// SPDX-License-Identifier: MPL-2.0

import {lstat, readFile} from 'node:fs/promises';
import path from 'node:path';

import {discoverTests} from '@kubohiroya/turbowarp-plus-editor-test/test-discovery';
import type {TestDiscovery} from '@kubohiroya/turbowarp-plus-editor-test/test-discovery';
import {strFromU8, unzipSync} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';

const archiveSizeLimit = 64 * 1024 * 1024;
const projectSizeLimit = 64 * 1024 * 1024;
const archiveEntryLimit = 4096;

/** Discover project tests from a local SB3 or its expanded source without loading a VM or any extension. */
export async function listProjectTests(inputPath: string): Promise<TestDiscovery> {
  const input = path.resolve(inputPath);
  const info = await lstat(input);
  if (info.isDirectory()) {
    const projectFile = path.join(input, 'project.source.json');
    const projectInfo = await lstat(projectFile);
    assert(projectInfo.isFile(), `Expected a regular project.source.json file: ${projectFile}`);
    assert(projectInfo.size <= projectSizeLimit, 'project.source.json exceeds the 64 MiB limit.');
    return discoverTests(await readFile(projectFile, 'utf8'));
  }
  assert(
    info.isFile() && path.extname(input).toLowerCase() === '.sb3',
    `Expected an .sb3 file or source directory: ${input}`,
  );
  assert(info.size <= archiveSizeLimit, 'SB3 exceeds the 64 MiB limit.');

  const names = new Set<string>();
  const entries = unzipSync(await readFile(input), {
    filter: ({name, originalSize}) => {
      validateArchiveEntryName(name);
      assert(!names.has(name), `Duplicate SB3 archive entry: ${name}`);
      names.add(name);
      assert(names.size <= archiveEntryLimit, 'SB3 entry limit exceeded.');
      if (name !== 'project.json') return false;
      assert(originalSize <= projectSizeLimit, 'SB3 project.json exceeds the 64 MiB limit.');
      return true;
    },
  });
  assert(Object.hasOwn(entries, 'project.json'), 'SB3 archive does not contain project.json.');
  return discoverTests(strFromU8(entries['project.json']));
}
