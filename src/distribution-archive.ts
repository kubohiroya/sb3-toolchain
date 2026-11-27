// SPDX-License-Identifier: MPL-2.0
import {DistributionError} from '@kubohiroya/turbowarp-extension-manifest/distribution';

const decoder = new TextDecoder('utf-8', {fatal: true});

export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body)
    throw new DistributionError('MISSING_ARTIFACT', 'The distribution response has no body');
  signal?.throwIfAborted();
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, {once: true});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) {
        throw new DistributionError(
          'SIZE_LIMIT',
          'The distribution exceeds the supported download size',
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let next = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, next);
    next += chunk.length;
  }
  return bytes;
}

function field(header: Uint8Array, start: number, length: number): string {
  const value = header.subarray(start, start + length);
  const end = value.indexOf(0);
  return decoder.decode(end === -1 ? value : value.subarray(0, end));
}

function octal(value: string): number {
  if (!/^[0-7]+$/u.test(value.trim()))
    throw new DistributionError('INVALID_ARCHIVE', 'Invalid tar number');
  return parseInt(value.trim(), 8);
}

/** Index the package metadata and flat dist files without extracting any archive path. */
export function indexNpmDistribution(
  archive: Uint8Array<ArrayBuffer>,
): Map<string, Uint8Array<ArrayBuffer>> {
  const entries = new Map<string, Uint8Array<ArrayBuffer>>();
  const names = new Set<string>();
  let hasExtendedHeader = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return entries;
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(field(header, 148, 8))) {
      throw new DistributionError('INVALID_ARCHIVE', 'Invalid tar header checksum');
    }
    const prefix = field(header, 345, 155);
    const file = (prefix ? prefix + '/' : '') + field(header, 0, 100);
    const type = header[156];
    const size = octal(field(header, 124, 12));
    if (names.size >= 4096)
      throw new DistributionError('SIZE_LIMIT', 'Too many npm archive entries');
    // Reject unsafe entries even when the resolver would not extract them.
    const segments = file.replace(/\/$/u, '').split('/');
    if (
      segments[0] !== 'package' ||
      segments.some((segment) => !segment || segment === '.' || segment === '..') ||
      /[\\\u0000-\u001f\u007f:]/u.test(file) ||
      names.has(file) ||
      ![0, 48, 53, 120, 76, 75, 103].includes(type!) ||
      (type === 53 && size !== 0)
    ) {
      throw new DistributionError('INVALID_ARCHIVE', 'Unsafe or duplicate npm archive entry');
    }
    names.add(file);
    const start = offset + 512;
    offset = start + Math.ceil(size / 512) * 512;
    if (offset > archive.length)
      throw new DistributionError('INVALID_ARCHIVE', 'Truncated npm tarball');
    // PAX and GNU long names cannot change the identity of a distribution file.
    if (type === 103)
      throw new DistributionError('INVALID_ARCHIVE', 'Unsupported global tar metadata');
    if (type === 120 || type === 76 || type === 75) {
      hasExtendedHeader = true;
      continue;
    }
    if (
      file === 'package/package.json' ||
      /^package\/dist\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(file)
    ) {
      if (hasExtendedHeader || (type !== 0 && type !== 48) || entries.has(file)) {
        throw new DistributionError('INVALID_ARCHIVE', 'Ambiguous distribution archive entry');
      }
      entries.set(file, archive.subarray(start, start + size));
    }
    hasExtendedHeader = false;
  }
  throw new DistributionError('INVALID_ARCHIVE', 'The npm tarball has no end marker');
}
