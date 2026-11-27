// SPDX-License-Identifier: MPL-2.0

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {StandardBuildOptions, StandardExtensionBuild} from './standard-extension-build';
import {lockStandardExtensionBuild} from './extension-artifact-lock';

// This fixed child handles deadlines and secret-free environment inheritance, not OS isolation.
// Desktop must run this entry inside its separately verified OS sandbox.
const program = `
const {buildStandardExtension} = await import(process.argv[1]);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 6 * 1024 * 1024) throw new Error('Build job input limit');
}
try {
  const {files, options} = JSON.parse(input);
  const result = await buildStandardExtension(new Map(files.map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')])), options);
  process.stdout.write(JSON.stringify({receipt: result.receipt, measurements: result.measurements, files: [...result.files].map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')])}));
} catch {
  process.stderr.write('Standard extension build failed; inspect the bounded snapshot with the low-level compiler for diagnostics.');
  process.exitCode = 1;
}
`;

export interface StandardBuildJobOptions extends StandardBuildOptions {
  /** Wall-clock deadline; process termination is awaited before rejecting. */
  timeoutMs?: number;
}

/** Bounded, cancellable child job. This function does not establish an OS security boundary. */
export async function runStandardExtensionBuild(
  snapshot: ReadonlyMap<string, Uint8Array>,
  {signal, timeoutMs = 30_000, ...options}: StandardBuildJobOptions = {},
): Promise<StandardExtensionBuild> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('Invalid standard build deadline');
  if (snapshot.size > 128) throw new Error('Build job input limit');
  let inputBytes = 0;
  for (const [name, bytes] of snapshot) {
    inputBytes += bytes.byteLength;
    if (name.length > 1024 || bytes.byteLength > 1024 * 1024 || inputBytes > 4 * 1024 * 1024)
      throw new Error('Build job input limit');
  }
  const files = [...snapshot].map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]);
  const input = JSON.stringify({files, options});
  if (snapshot.size > 128 || input.length > 6 * 1024 * 1024)
    throw new Error('Build job input limit');
  const directory = await mkdtemp(path.join(tmpdir(), 'sb3-extension-build-'));
  try {
    signal?.throwIfAborted();
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const modulePath = './standard-extension-compiler.' + extension;
    const moduleURL = new URL(modulePath, import.meta.url);
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '--eval', program, moduleURL.href],
      {
        cwd: directory,
        env: {LANG: 'C', TZ: 'UTC'},
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    return await new Promise<StandardExtensionBuild>((resolve, reject) => {
      let failure: Error | undefined;
      let size = 0;
      const chunks: Buffer[] = [];
      const stop = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new Error('Standard extension build cancelled'));
      const timer = setTimeout(
        () => stop(new Error('Standard extension build timed out')),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      child.on('error', (error) => {
        failure ??= error;
      });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) stop(new Error('Build job output limit'));
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure || code !== 0) {
          reject(failure ?? new Error('Standard extension build failed'));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString()) as {
            receipt: StandardExtensionBuild['receipt'];
            measurements: StandardExtensionBuild['measurements'];
            files: [string, string][];
          };
          const build = {
            receipt: result.receipt,
            measurements: result.measurements,
            files: new Map(
              result.files.map(([name, bytes]) => [
                name,
                Uint8Array.from(Buffer.from(bytes, 'base64')),
              ]),
            ),
          };
          lockStandardExtensionBuild(build);
          resolve(build);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(input);
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
