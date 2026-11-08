// SPDX-License-Identifier: MPL-2.0

import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';
import {writeSb3Archive} from './build';
import type {WriteSb3ArchiveOptions, WriteSb3ArchiveResult} from './build';
import {fixedZipTimestamp} from './source';
import {cleanUpTurboWarpBlocks} from './turbowarp-clean-up';
import type {TargetCleanUpResult} from './turbowarp-clean-up';
import type {ProjectJson} from './types';

export interface CleanUpSb3Options extends Omit<WriteSb3ArchiveOptions, 'archive'> {
  inputPath: string;
}

export interface CleanUpSb3ArchiveResult extends TargetCleanUpResult {
  archive: Uint8Array;
  targetCount: number;
}

export interface CleanUpSb3Result
  extends WriteSb3ArchiveResult, Omit<CleanUpSb3ArchiveResult, 'archive'> {}

/** Rearranges an SB3 archive without extracting its entries to disk. */
export function cleanUpSb3Archive(original: Uint8Array): CleanUpSb3ArchiveResult {
  const names = new Set<string>();
  const entries = unzipSync(original, {
    filter: ({name}) => {
      validateArchiveEntryName(name);
      assert(name !== '__proto__', 'Unsupported SB3 archive entry: __proto__');
      assert(!names.has(name), `Duplicate SB3 archive entry: ${name}`);
      names.add(name);
      return true;
    },
  });
  assert(Object.hasOwn(entries, 'project.json'), 'SB3 archive does not contain project.json.');
  const {project, ...counts} = cleanUpTurboWarpBlocks(
    JSON.parse(strFromU8(entries['project.json'])) as ProjectJson,
    {compact: true},
  );

  if (counts.movedScriptCount === 0) return {archive: original, ...counts};

  entries['project.json'] = strToU8(`${JSON.stringify(project)}\n`);
  return {archive: zipSync(entries, {level: 6, mtime: fixedZipTimestamp}), ...counts};
}

export async function cleanUpSb3({
  confirmReplace,
  inputPath,
  outputPath,
  yes,
}: CleanUpSb3Options): Promise<CleanUpSb3Result> {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  assert(path.extname(input).toLowerCase() === '.sb3', `Expected an .sb3 file: ${input}`);
  assert(input !== output, 'Output must differ from the input SB3 path.');
  const inputStats = await lstat(input);
  assert(inputStats.isFile(), `Expected a regular SB3 file: ${input}`);
  const outputStats = await lstat(output).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  assert(!outputStats || outputStats.isFile(), `Expected a regular SB3 output file: ${output}`);
  assert(
    !outputStats || outputStats.ino !== inputStats.ino || outputStats.dev !== inputStats.dev,
    'Output must differ from the input SB3 path.',
  );

  const {archive, ...counts} = cleanUpSb3Archive(await readFile(input));
  const written = await writeSb3Archive({archive, confirmReplace, outputPath: output, yes});
  return {...counts, ...written};
}
