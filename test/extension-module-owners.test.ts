// SPDX-License-Identifier: MPL-2.0

import {readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';

import {unzipSync} from 'fflate';
import type * as Rolldown from 'rolldown';
import {expect, test, vi} from 'vitest';

import {unbundleSb3} from '../src/extension-bundle-archive';
import {decodeExtensionDataUrl} from '../src/import';
import {createDeterministicSb3} from '../src/source';
import {evaluationProbe, moduleVm} from './module-bundle-helpers';

const probe = vi.hoisted(() => ({enabled: false, members: {} as Record<string, string>}));
vi.mock('rolldown', async (importOriginal) => {
  const original = await importOriginal<typeof Rolldown>();
  return {
    ...original,
    rolldown: (options: Rolldown.InputOptions) =>
      original.rolldown({...options, plugins: [options.plugins, evaluationProbe(probe)]}),
  };
});

// Unpublished owner entries are provided explicitly; regular CI uses the synthetic fixture.
const sourceDirectory = process.env.SB3_MODULE_OWNER_FIXTURE;
test.skipIf(!sourceDirectory)(
  'integrates the three real owner tarballs with one yaml evaluation and one external registration',
  async () => {
    const directory = path.resolve(sourceDirectory!);
    const root = path.dirname(directory);
    const manifestFile = path.join(directory, 'embedded-extensions.json');
    const originalManifest = await readFile(manifestFile, 'utf8');
    const manifest = JSON.parse(originalManifest);
    const project = JSON.parse(await readFile(path.join(directory, 'project.source.json'), 'utf8'));
    const [sd, yaml, scene] = manifest.extensionBundles[0].members as string[];
    for (const member of manifest.extensions) {
      probe.members[
        await realpath(
          path.join(root, 'node_modules', member.source.package, member.source.module.artifact),
        )
      ] = member.id;
    }
    try {
      const normal = await createDeterministicSb3(directory);
      const repeat = await createDeterministicSb3(directory);
      expect(repeat.archive).toEqual(normal.archive);
      const report = normal.bundlePlans[0].moduleBuild!;
      expect(report.sharedDependencies).toEqual([
        expect.objectContaining({package: 'yaml', version: '2.9.1', copies: 1}),
      ]);
      const code = normal.bundlePlans[0].contents.toString();
      await writeFile(path.join(root, 'shared-yaml.js'), code);
      for (const name of ['Parser', 'Composer', 'Document'])
        expect(code.match(new RegExp(`\\b${name} = class\\b`, 'g')) ?? []).toHaveLength(1);
      expect(code).not.toContain(root);
      expect(code).not.toContain('__yamlEvaluations');
      expect(code).not.toContain('__factoryCalls');
      const normalVm = moduleVm(project);
      vm.runInContext(code, normalVm.context);
      expect(normalVm.registered).toHaveLength(1);
      const normalExtension = normalVm.registered[0];
      normalExtension.getInfo();
      const normalUtil = {target: {}, thread: {}, stackFrame: {}, startBranch() {}};
      normalExtension[`${sd}__parseYaml`]({NAME: 'normal', TEXT: 'value: 3'}, normalUtil);
      expect(normalExtension[`${sd}__toJson`]({NAME: 'normal'}, normalUtil)).toBe('{"value":3}');
      const normalFragment = normalExtension[`${yaml}__parseText`]({
        TEXT: 'value: 4',
        FORMAT: 'yaml',
      });
      expect(
        JSON.parse(normalExtension[`${yaml}__renderJson`]({FRAGMENT: normalFragment})),
      ).toEqual({value: 4});
      await normalExtension[`${scene}__applyScene`]({
        SOURCE: 'formatVersion: 1\nroot:\n  children:\n    - type: sphere\n      id: normal',
      });
      expect(normalVm.port.calls).toEqual([['sphere', 'normal', '#scene']]);
      await normalExtension.dispose();
      expect(normalVm.removed).toHaveLength(7);

      probe.enabled = true;
      const instrumented = await createDeterministicSb3(directory);
      const loaded = moduleVm(project);
      vm.runInContext(instrumented.bundlePlans[0].contents.toString(), loaded.context);
      expect(loaded.registered).toHaveLength(1);
      expect(loaded.context.__factoryCalls).toEqual({[sd]: 1, [yaml]: 1, [scene]: 1});
      const evaluations = JSON.stringify(loaded.context.__yamlEvaluations);
      expect(Object.keys(loaded.context.__yamlEvaluations).length).toBeGreaterThan(20);
      expect(Object.values(loaded.context.__yamlEvaluations).every((count) => count === 1)).toBe(
        true,
      );
      const extension = loaded.registered[0];
      const info = extension.getInfo();
      expect(info.id).toBe('projectbundle');
      expect(loaded.sourceEditors).toHaveLength(4);
      expect(loaded.fixedEditors).toHaveLength(3);
      for (const editor of [...loaded.sourceEditors, ...loaded.fixedEditors]) {
        expect(editor.extensionId).toBe('projectbundle');
        expect(editor.opcodes.every((opcode: string) => opcode.startsWith('projectbundle_'))).toBe(
          true,
        );
      }
      const util = {target: {}, thread: {}, stackFrame: {}, startBranch() {}};
      extension[`${sd}__parseYaml`]({NAME: 'data', TEXT: 'value: 1'}, util);
      expect(extension[`${sd}__toJson`]({NAME: 'data'}, util)).toBe('{"value":1}');
      expect(() =>
        extension[`${sd}__parseYaml`]({NAME: 'bad', TEXT: 'base: &x [1]\ncopy: *x'}, util),
      ).toThrow('aliases');
      const fragment = extension[`${yaml}__parseText`]({TEXT: 'value: 2', FORMAT: 'yaml'});
      expect(JSON.parse(extension[`${yaml}__renderJson`]({FRAGMENT: fragment}))).toEqual({
        value: 2,
      });
      extension[`${yaml}__parseText`]({TEXT: 'base: &x [1]\ncopy: *x', FORMAT: 'yaml'});
      expect(extension[`${yaml}__lastParseSucceeded`]()).toBe(false);
      expect(extension[`${sd}__toJson`]({NAME: 'data'}, util)).toBe('{"value":1}');
      expect(
        extension[`${yaml}__isValidSchema`]({SCHEMA: '{"type":"object"}', FRAGMENT: fragment}),
      ).toBe(true);
      await extension[`${scene}__applyScene`]({
        SOURCE: 'formatVersion: 1\nroot:\n  children:\n    - type: box\n      id: first',
      });
      expect(loaded.port.calls).toEqual([['box', 'first', '#scene']]);
      expect(extension[`${scene}__sceneStatus`]()).toBe('ready');
      expect(extension[`${scene}__whenSceneApplied`]()).toBe(true);
      expect(extension[`${scene}__whenSceneApplied`]()).toBe(false);
      expect(JSON.stringify(loaded.context.__yamlEvaluations)).toBe(evaluations);
      expect(loaded.context.__factoryCalls).toEqual({[sd]: 1, [yaml]: 1, [scene]: 1});
      await extension.dispose();
      await extension.dispose();
      expect(loaded.removed).toHaveLength(7);
      expect([...loaded.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);

      const sandboxed = moduleVm(project, false);
      vm.runInContext(instrumented.bundlePlans[0].contents.toString(), sandboxed.context);
      expect(sandboxed.registered).toHaveLength(1);
      expect(sandboxed.context.__yamlEvaluations).toEqual({});
      expect(sandboxed.context.__factoryCalls).toEqual({});
      probe.enabled = false;

      manifest.extensionBundles[0].recoveryCapsule = true;
      await writeFile(manifestFile, JSON.stringify(manifest));
      const recovery = await createDeterministicSb3(directory);
      const recoveryInput = path.join(root, 'recovery.sb3'),
        restoredOutput = path.join(root, 'restored.sb3');
      await writeFile(recoveryInput, recovery.archive);
      await unbundleSb3({
        bundleId: 'projectbundle',
        inputPath: recoveryInput,
        outputPath: restoredOutput,
        yes: true,
      });
      const restored = JSON.parse(
        Buffer.from(unzipSync(await readFile(restoredOutput))['project.json']).toString(),
      );
      expect(restored.extensions).toEqual(project.extensions);
      for (const member of manifest.extensions) {
        expect(
          Buffer.from(decodeExtensionDataUrl(restored.extensionURLs[member.id]).source),
        ).toEqual(await readFile(path.join(directory, member.path)));
      }
      delete manifest.extensionBundles[0].recoveryCapsule;
      manifest.extensionBundles[0].buildMode = 'classic';
      delete manifest.extensionBundles[0].sharedDependencies;
      await writeFile(manifestFile, JSON.stringify(manifest));
      const classic = await createDeterministicSb3(directory);
      const classicCode = classic.bundlePlans[0].contents.toString();
      for (const name of ['Parser', 'Composer', 'Document'])
        expect(
          classicCode.match(new RegExp(`(?:var|let|const) ${name} = class`, 'g')),
        ).toHaveLength(3);
      const classicVm = moduleVm(project);
      vm.runInContext(classicCode, classicVm.context);
      expect(classicVm.registered).toHaveLength(1);
      expect(classicVm.registered[0].getInfo().blocks).toEqual(info.blocks);
      for (const listener of [...(classicVm.listeners.get('RUNTIME_DISPOSED') ?? [])]) listener();
      const sizes = (built: typeof normal) => ({
        javascript: built.bundlePlans[0].contents.length,
        javascriptGzip: gzipSync(built.bundlePlans[0].contents).length,
        sb3: built.archive.length,
      });
      const evidence = {
        provenance: JSON.parse(await readFile(path.join(root, 'owner-provenance.json'), 'utf8')),
        report,
        evaluations: loaded.context.__yamlEvaluations,
        factories: loaded.context.__factoryCalls,
        externalRegistrations: loaded.registered.length,
        editorRegistrations: {
          source: loaded.sourceEditors.length,
          fixed: loaded.fixedEditors.length,
          removed: loaded.removed.length,
        },
        parserComposerDocumentCopies: {classic: 3, module: 1},
        sizes: {classic: sizes(classic), module: sizes(normal)},
        reproducible: true,
        recovery: true,
      };
      await writeFile(
        path.join(root, 'module-owner-results.json'),
        JSON.stringify(evidence, null, 2),
      );
      await writeFile(path.join(root, 'shared-yaml.sb3'), normal.archive);
      process.stdout.write(
        JSON.stringify({
          sizes: evidence.sizes,
          yamlModules: Object.keys(evidence.evaluations).length,
          factories: evidence.factories,
          externalRegistrations: 1,
        }) + '\n',
      );
    } finally {
      probe.enabled = false;
      await writeFile(manifestFile, originalManifest);
    }
  },
  120_000,
);
