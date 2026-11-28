// SPDX-License-Identifier: MPL-2.0
/**
 * The file side of `extensions list-sb3` and `extensions update-sb3`: read an SB3, call the shared
 * core in `./project-extensions`, and write the result to a separate SB3. Everything the commands
 * decide is decided there, so the Editor gets the same answer for the same input.
 */

import {strToU8, zipSync} from 'fflate';

import {assert} from './assert';
import {writeSb3Archive} from './build';
import type {WriteSb3ArchiveOptions, WriteSb3ArchiveResult} from './build';
import {assertDistinctOutput, readArchive, unpackSb3Entries} from './extension-sb3-replacement';
import {
  applyProjectExtensionUpdate,
  listProjectExtensions,
  planProjectExtensionUpdate,
  type ProjectExtension,
  type ProjectExtensionPlan,
  type ProjectExtensionPlanOptions,
  type ProjectExtensionRequest,
} from './project-extensions';
import {fixedZipTimestamp} from './source';

async function readSb3(inputPath: string) {
  const {entries, project} = unpackSb3Entries(await readArchive(inputPath));
  const archive = {...entries};
  delete archive['project.json'];
  return {archive, project};
}

export async function listSb3Extensions(inputPath: string): Promise<readonly ProjectExtension[]> {
  const {archive, project} = await readSb3(inputPath);
  return listProjectExtensions(archive, project);
}

export interface UpdateSb3ExtensionsOptions extends ProjectExtensionPlanOptions {
  readonly inputPath: string;
  /** Absent for a dry run, which only plans. */
  readonly outputPath?: string | undefined;
  readonly requests: Readonly<Record<string, ProjectExtensionRequest>>;
  readonly confirmReplace?: WriteSb3ArchiveOptions['confirmReplace'];
  readonly yes?: boolean | undefined;
}

export interface UpdateSb3ExtensionsResult {
  readonly plan: ProjectExtensionPlan;
  /** Absent for a dry run or a blocked plan. */
  readonly written?: WriteSb3ArchiveResult;
}

/**
 * Plan, and unless it is a dry run or blocked, apply and write a separate SB3. The input is never
 * written: the output must be another path, and a failure leaves nothing half-written.
 */
export async function updateSb3Extensions({
  inputPath,
  outputPath,
  requests,
  confirmReplace,
  yes = false,
  ...ports
}: UpdateSb3ExtensionsOptions): Promise<UpdateSb3ExtensionsResult> {
  if (outputPath !== undefined) await assertDistinctOutput(outputPath, [inputPath]);
  const {archive, project} = await readSb3(inputPath);
  const plan = await planProjectExtensionUpdate(archive, project, requests, ports);
  if (outputPath === undefined || plan.blocked) return {plan};
  const result = await applyProjectExtensionUpdate(archive, project, plan, {
    ...(ports.fetch ? {fetch: ports.fetch} : {}),
    ...(ports.signal ? {signal: ports.signal} : {}),
    ...(ports.timeoutMs ? {timeoutMs: ports.timeoutMs} : {}),
  });
  const entries: Record<string, Uint8Array> = {
    ...result.archive,
    'project.json': strToU8(`${JSON.stringify(result.project)}\n`),
  };
  const sb3 = zipSync(entries, {level: 6, mtime: fixedZipTimestamp});
  await assertDistinctOutput(outputPath, [inputPath]);
  assert(sb3.byteLength > 0, 'The updated SB3 is empty.');
  const written = await writeSb3Archive({archive: sb3, confirmReplace, outputPath, yes});
  return {plan, written};
}
