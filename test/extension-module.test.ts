// SPDX-License-Identifier: MPL-2.0

import {readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

import type * as Rolldown from 'rolldown';
import {afterEach, expect, test, vi} from 'vitest';

import {createDeterministicSb3, validateSb3Source} from '../src/source';
import {extensionIntegrity} from '../src/extension-dependencies';
import {bundleExtensions} from '../src/extension-bundle-configuration';
import {parseCliArguments} from '../src/cli';
import {evaluationProbe, moduleVm, syntheticModuleProject} from './module-bundle-helpers';

const probe = vi.hoisted(() => ({enabled: false, members: {} as Record<string, string>}));
vi.mock('rolldown', async (importOriginal) => {
  const original = await importOriginal<typeof Rolldown>();
  return {
    ...original,
    rolldown: (options: Rolldown.InputOptions) =>
      original.rolldown({...options, plugins: [options.plugins, evaluationProbe(probe)]}),
  };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  probe.enabled = false;
  probe.members = {};
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function fixture(requirement?: string) {
  const value = await syntheticModuleProject(requirement);
  cleanups.push(value.cleanup);
  return value;
}

test('uses one browser yaml graph, evaluates each module and each factory once, and registers once', async () => {
  const f = await fixture();
  probe.members = f.entries;
  const normal = await createDeterministicSb3(f.sourceDirectory);
  const second = await createDeterministicSb3(f.sourceDirectory);
  expect(second.archive).toEqual(normal.archive);
  const elsewhere = await fixture();
  expect((await createDeterministicSb3(elsewhere.sourceDirectory)).archive).toEqual(normal.archive);
  expect(normal.bundlePlans[0].moduleBuild?.sharedDependencies).toEqual([
    expect.objectContaining({package: 'yaml', copies: 1}),
  ]);
  expect(
    normal.bundlePlans[0].moduleBuild?.inputs
      .filter((input) => input.package === 'yaml')
      .every((input) => input.file.startsWith('browser/') || input.file === 'package.json'),
  ).toBe(true);
  expect(normal.bundlePlans[0].moduleBuild?.inputs).toContainEqual(
    expect.objectContaining({package: 'yaml', file: 'browser/package.json'}),
  );
  probe.enabled = true;
  const instrumented = await createDeterministicSb3(f.sourceDirectory);
  const loaded = moduleVm(
    JSON.parse((await readFile(path.join(f.sourceDirectory, 'project.source.json'))).toString()),
  );
  vm.runInContext(instrumented.bundlePlans[0].contents.toString(), loaded.context);
  expect(loaded.registered).toHaveLength(1);
  const extension = loaded.registered[0];
  extension.getInfo();
  const evaluations = JSON.stringify(loaded.context.__yamlEvaluations);
  expect(Object.keys(loaded.context.__yamlEvaluations).length).toBeGreaterThan(20);
  expect(Object.values(loaded.context.__yamlEvaluations).every((count) => count === 1)).toBe(true);
  expect(loaded.context.__factoryCalls).toEqual({alpha: 1, beta: 1});
  expect(extension.alpha__parse({TEXT: 'value: 1'})).toBe('{"value":1}');
  expect(extension.beta__parse({TEXT: 'value: 2'})).toBe('{"value":2}');
  expect(JSON.stringify(loaded.context.__yamlEvaluations)).toBe(evaluations);
  extension.alpha__fire();
  expect(loaded.hats).toEqual(['projectbundle_alpha__ready']);
  expect(extension.alpha__lookup({OPCODE: 'beta_parse'})).toBe('projectbundle_beta__parse');
  await extension.dispose();
  await extension.dispose();
  expect([...loaded.context.__disposed].sort()).toEqual(['alpha', 'beta']);
});

test('short-circuits a required sandbox before module evaluation or factory initialization', async () => {
  const f = await fixture('required');
  probe.enabled = true;
  probe.members = f.entries;
  const built = await createDeterministicSb3(f.sourceDirectory);
  const loaded = moduleVm({}, false);
  vm.runInContext(built.bundlePlans[0].contents.toString(), loaded.context);
  expect(loaded.registered).toHaveLength(1);
  expect(loaded.registered[0].getInfo().id).toBe('projectbundle');
  expect(loaded.context.__yamlEvaluations).toEqual({});
  expect(loaded.context.__factoryCalls).toEqual({});
});

test('validates all module metadata before activating any member', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'node_modules/test-beta/module.js');
  const code = (await readFile(file, 'utf8')).replace("id: 'beta'", "id: 'wrong'");
  await writeFile(file, code);
  f.manifest.extensions[1].source.module.integrity = extensionIntegrity(code);
  await f.save();
  probe.enabled = true;
  probe.members = f.entries;
  const built = await createDeterministicSb3(f.sourceDirectory);
  const loaded = moduleVm({});
  expect(() => vm.runInContext(built.bundlePlans[0].contents.toString(), loaded.context)).toThrow(
    'Module entry contract mismatch',
  );
  expect(loaded.context.__factoryCalls).toEqual({});
  expect(loaded.registered).toHaveLength(0);
});

test('cleans up previously activated members if a later factory registers instead of returning an instance', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'node_modules/test-beta/module.js');
  const code = (await readFile(file, 'utf8')).replace(
    'return {\n    getInfo',
    'scratch.extensions.register({}); return {\n    getInfo',
  );
  await writeFile(file, code);
  f.manifest.extensions[1].source.module.integrity = extensionIntegrity(code);
  await f.save();
  const built = await createDeterministicSb3(f.sourceDirectory);
  const loaded = moduleVm({});
  expect(() => vm.runInContext(built.bundlePlans[0].contents.toString(), loaded.context)).toThrow(
    'Module factory must not register',
  );
  expect(loaded.context.__disposed).toEqual(['alpha']);
  expect(loaded.registered).toHaveLength(0);
});

test.each(['digest', 'version', 'range', 'lock', 'entry', 'escape'])(
  'rejects invalid pinned module input: %s',
  async (failure) => {
    const f = await fixture();
    const member = f.manifest.extensions[0];
    let message: RegExp;
    if (failure === 'digest') {
      member.source.module.integrity = extensionIntegrity('wrong');
      message = /Module integrity mismatch/;
    } else if (failure === 'version') {
      f.manifest.extensionBundles[0].sharedDependencies.yaml = '9.0.0';
      message = /expected 9.0.0/;
    } else if (failure === 'range') {
      const file = path.join(f.root, 'node_modules/test-alpha/package.json');
      const metadata = JSON.parse(await readFile(file, 'utf8'));
      metadata.dependencies.yaml = '^1.0.0';
      await writeFile(file, JSON.stringify(metadata));
      message = /Incompatible shared dependency/;
    } else if (failure === 'lock') {
      await rm(path.join(f.root, 'package-lock.json'));
      message = /require .*lock/;
    } else if (failure === 'entry') {
      delete (member.source as any).module;
      message = /needs an npm source.module/;
    } else {
      member.source.module.artifact = '../outside.js';
      message = /entry|path/i;
    }
    await f.save();
    await expect(validateSb3Source(f.sourceDirectory)).rejects.toThrow(message);
  },
);

test.each(['./node_modules/yaml/browser/index.js', '../yaml/dist/public-api.js'])(
  'rejects bypasses of shared browser resolution: %s',
  async (request) => {
    const f = await fixture();
    const file = path.join(f.root, 'node_modules/test-alpha/module.js');
    const code = (await readFile(file, 'utf8')).replace("from 'yaml'", `from '${request}'`);
    await writeFile(file, code);
    f.manifest.extensions[0].source.module.integrity = extensionIntegrity(code);
    await f.save();
    await expect(validateSb3Source(f.sourceDirectory)).rejects.toThrow(
      /Duplicate shared dependency|browser entry exclusively/,
    );
  },
);

test('rolls back to retained classic sources without installed module dependencies or a lock', async () => {
  const f = await fixture();
  delete (f.manifest.extensionBundles[0] as any).buildMode;
  delete (f.manifest.extensionBundles[0] as any).sharedDependencies;
  await f.save();
  await rm(path.join(f.root, 'node_modules'), {recursive: true});
  await rm(path.join(f.root, 'package-lock.json'));
  const built = await createDeterministicSb3(f.sourceDirectory);
  expect(built.bundlePlans[0]).not.toHaveProperty('moduleBuild');
  const loaded = moduleVm({});
  vm.runInContext(built.bundlePlans[0].contents.toString(), loaded.context);
  expect(loaded.registered).toHaveLength(1);
});

test('configures module mode explicitly through the CLI while retaining the classic default', () => {
  const base = [
    'extensions',
    'bundle',
    'app',
    'alpha',
    'beta',
    '--id',
    'projectbundle',
    '--name',
    'Project',
  ];
  expect(parseCliArguments(base)).not.toHaveProperty('buildMode');
  expect(
    parseCliArguments([...base, '--build-mode', 'module', '--share', 'yaml@2.9.1']),
  ).toMatchObject({buildMode: 'module', sharedDependencies: {yaml: '2.9.1'}});
  expect(() => parseCliArguments([...base, '--share', 'yaml@2.9.1'])).toThrow(
    '--build-mode module',
  );
  expect(() =>
    parseCliArguments([...base, '--build-mode', 'module', '--share', 'yaml@^2.9']),
  ).toThrow('exact');
  expect(() =>
    parseCliArguments([...base, '--build-mode', 'module', '--share', '__proto__@1.0.0']),
  ).toThrow('Invalid shared dependency');
});

test('transactionally configures and builds module mode using parent project dependencies', async () => {
  const f = await fixture();
  delete (f.manifest as any).extensionBundles;
  await f.save();
  const installedYaml = JSON.parse(
    await readFile(path.join(f.root, 'node_modules/yaml/package.json'), 'utf8'),
  );
  const result = await bundleExtensions({
    sourceDirectory: f.sourceDirectory,
    bundleId: 'projectbundle',
    bundleName: 'Project',
    extensionIds: ['alpha', 'beta'],
    buildMode: 'module',
    sharedDependencies: {yaml: installedYaml.version},
    yes: true,
  });
  expect(result.applied).toBe(true);
  expect(result.moduleBuild?.sharedDependencies[0].copies).toBe(1);
  const built = await createDeterministicSb3(f.sourceDirectory);
  expect(built.embeddedExtensionCount).toBe(1);
});
