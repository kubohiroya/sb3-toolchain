// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {readBounded} from './distribution-archive';
import type {StandardBuildSource} from './standard-extension-build';

export interface GitHubExtensionSnapshot {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly source: StandardBuildSource & {kind: 'github'};
  readonly measurements: Readonly<{
    downloadBytes: number;
    snapshotBytes: number;
    cacheBytes: 0;
    temporaryDiskBytes: 0;
  }>;
}

/** Fetch only declarative inputs and source files from one immutable Git tree. No Git or package scripts run. */
export async function resolveGitHubExtensionSnapshot(
  reference: string,
  {
    ref = 'HEAD',
    expectedCommit,
    signal,
    fetchImpl = globalThis.fetch,
  }: {ref?: string; expectedCommit?: string; signal?: AbortSignal; fetchImpl?: typeof fetch} = {},
): Promise<GitHubExtensionSnapshot> {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\/?$/u.exec(
      reference,
    );
  if (!match || !ref || ref.length > 128 || /[\u0000-\u0020\u007f]/u.test(ref))
    throw new Error('Invalid GitHub snapshot reference');
  const repository = match[1]!;
  const operation = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
    : AbortSignal.timeout(45_000);
  const root = 'https://api.github.com/repos/' + repository;
  let downloadBytes = 0;
  const json = async (url: string, limit: number) => {
    operation.throwIfAborted();
    const response = await fetchImpl(url, {
      credentials: 'omit',
      redirect: 'error',
      signal: operation,
    });
    if (!response.ok) throw new Error('GitHub snapshot request failed: HTTP ' + response.status);
    const bytes = await readBounded(response.body, limit, operation);
    downloadBytes += bytes.length;
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  };
  const commit = await json(root + '/commits/' + encodeURIComponent(ref), 256 * 1024);
  if (
    !/^[a-f0-9]{40}$/u.test(commit.sha) ||
    !/^[a-f0-9]{40}$/u.test(commit.commit?.tree?.sha) ||
    (expectedCommit !== undefined && expectedCommit !== commit.sha)
  )
    throw new Error('GitHub source commit changed or is invalid');
  const tree = await json(
    root + '/git/trees/' + commit.commit.tree.sha + '?recursive=1',
    1024 * 1024,
  );
  if (
    tree.sha !== commit.commit.tree.sha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 4096
  )
    throw new Error('Unsupported or incomplete GitHub source tree');
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let snapshotBytes = 0;
  for (const item of tree.tree) {
    if (
      typeof item.path !== 'string' ||
      !/^(?:[\p{L}\p{M}\p{N}_. -]+\/)*[\p{L}\p{M}\p{N}_. -]+$/u.test(item.path) ||
      item.path.split('/').some((part: string) => part === '.' || part === '..') ||
      seen.has(item.path) ||
      !['040000', '100644', '100755'].includes(item.mode)
    )
      throw new Error('Unsafe path, link or duplicate in GitHub source tree');
    seen.add(item.path);
    if (
      !['package.json', 'pnpm-lock.yaml', 'extension-build.json'].includes(item.path) &&
      !/^src\/.*\.(?:js|ts|json)$/u.test(item.path)
    )
      continue;
    if (
      item.type !== 'blob' ||
      !/^[a-f0-9]{40}$/u.test(item.sha) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.size > 1024 * 1024 ||
      files.size >= 128 ||
      snapshotBytes + item.size > 4 * 1024 * 1024
    )
      throw new Error('GitHub source snapshot exceeds its input limits');
    const blob = await json(root + '/git/blobs/' + item.sha, 1450 * 1024);
    if (
      blob.sha !== item.sha ||
      blob.encoding !== 'base64' ||
      typeof blob.content !== 'string' ||
      blob.size !== item.size ||
      !/^[A-Za-z0-9+/=\n\r]*$/u.test(blob.content)
    )
      throw new Error('Invalid GitHub source blob');
    const bytes = Buffer.from(blob.content, 'base64');
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length !== item.size || hash !== item.sha)
      throw new Error('GitHub source blob integrity mismatch');
    files.set(item.path, bytes);
    snapshotBytes += bytes.length;
  }
  operation.throwIfAborted();
  return {
    files,
    source: {kind: 'github', repository, commit: commit.sha},
    measurements: {downloadBytes, snapshotBytes, cacheBytes: 0, temporaryDiskBytes: 0},
  };
}
