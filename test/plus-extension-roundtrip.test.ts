// SPDX-License-Identifier: MPL-2.0
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {unpackSb3, validateSourceFiles} from '../src/browser';
import {extensionLocksEntry, lockStandardExtensionBuild} from '../src/extension-artifact-lock';
import {importSb3} from '../src/import';
import {createDeterministicSb3} from '../src/source';
import {buildStandardExtension} from '../src/standard-extension-build';
import {standardBuildFixture} from './standard-build-fixture';

let lock: ReturnType<typeof lockStandardExtensionBuild>;
let bundle: Uint8Array;
beforeAll(async () => {
  const snapshot = standardBuildFixture();
  snapshot.set(
    'src/index.ts',
    Buffer.from(
      "Scratch.extensions.register({}); globalThis.__plusRoundtripExecuted = true; throw new Error('do not evaluate');",
    ),
  );
  const built = await buildStandardExtension(snapshot);
  lock = lockStandardExtensionBuild(built);
  bundle = built.files.get('recipe-fixture.js')!;
});

function fixture(type: 'embedded-file' | 'embedded-data') {
  const spec = {
    id: 'recipefixture',
    sha256: lock.bundleSHA256,
    execution: 'sandboxed',
    artifactLockFormatVersion: 1,
    source:
      type === 'embedded-file'
        ? {type, path: 'extensions/recipefixture.js', url: 'https://example.test/source.js'}
        : {type},
    version: '0.1.0',
    publisher: 'fixture',
    capabilities: [],
    dependencies: [],
  };
  const project = {
    targets: [{isStage: true, name: 'Stage', blocks: {}, costumes: [], sounds: []}],
    extensions: ['recipefixture'],
    extensionURLs:
      type === 'embedded-data'
        ? {recipefixture: 'data:text/javascript;base64,' + Buffer.from(bundle).toString('base64')}
        : {},
    turboWarpPlus: {schemaVersion: 1, uri: 'https://example.test/project.sb3', extensions: [spec]},
    unknownProjectField: {preserve: true},
  };
  const entries: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify(project)),
    [extensionLocksEntry]: strToU8(
      JSON.stringify({formatVersion: 1, extensions: [{id: spec.id, artifactLock: lock}]}),
    ),
  };
  if (type === 'embedded-file') entries['extensions/recipefixture.js'] = bundle;
  return {project, entries};
}

describe('locked Plus extension source roundtrip', () => {
  for (const type of ['embedded-file', 'embedded-data'] as const) {
    it(`preserves ${type}, manifest, bytes and receipt through browser and Node paths`, async () => {
      const {project, entries} = fixture(type);
      const original = zipSync(entries);
      const fetched = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('No network is allowed'));
      const root = await mkdtemp(path.join(tmpdir(), 'plus-artifact-roundtrip-'));
      try {
        const unpacked = unpackSb3(original);
        validateSourceFiles(unpacked.files);
        expect(
          JSON.parse(strFromU8(unpacked.files.get('project.source.json')!)).turboWarpPlus,
        ).toEqual(project.turboWarpPlus);
        const inputPath = path.join(root, 'input.sb3');
        const outputDirectory = path.join(root, 'source');
        await writeFile(inputPath, original);
        await importSb3({inputPath, outputDirectory, protectedRoot: root});
        const built = await createDeterministicSb3(outputDirectory);
        const archive = unzipSync(built.archive);
        const again = JSON.parse(strFromU8(archive['project.json']));
        expect(again.turboWarpPlus).toEqual(project.turboWarpPlus);
        expect(again.unknownProjectField).toEqual(project.unknownProjectField);
        expect(JSON.parse(strFromU8(archive[extensionLocksEntry]))).toEqual(
          JSON.parse(strFromU8(entries[extensionLocksEntry])),
        );
        const held =
          type === 'embedded-file'
            ? archive['extensions/recipefixture.js']
            : Buffer.from(again.extensionURLs.recipefixture.split(',')[1], 'base64');
        expect(Buffer.from(held)).toEqual(Buffer.from(bundle));
        expect(Object.hasOwn(archive, 'extensions/recipefixture.js')).toBe(
          type === 'embedded-file',
        );
        expect(Object.hasOwn(again.extensionURLs, 'recipefixture')).toBe(type === 'embedded-data');
        expect(unpackSb3(built.archive).files.get('embedded-extensions.json')).toEqual(
          unpacked.files.get('embedded-extensions.json'),
        );
        await writeFile(inputPath, built.archive);
        const secondDirectory = path.join(root, 'second');
        await importSb3({inputPath, outputDirectory: secondDirectory, protectedRoot: root});
        expect((await createDeterministicSb3(secondDirectory)).archive).toEqual(built.archive);
        expect(fetched).not.toHaveBeenCalled();
        expect((globalThis as Record<string, unknown>).__plusRoundtripExecuted).toBeUndefined();
      } finally {
        fetched.mockRestore();
        await rm(root, {recursive: true, force: true});
      }
    });
  }

  it('rejects unsupported manifest shapes, storage, capability and execution changes', () => {
    const mutations = [
      (project: any) => {
        project.extensions.push({id: 'not-an-ID'});
      },
      (project: any) => {
        project.turboWarpPlus.schemaVersion = 2;
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].artifactLockFormatVersion = 2;
      },
      (project: any) => {
        delete project.turboWarpPlus.extensions[0].artifactLockFormatVersion;
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].execution = 'unsandboxed';
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].capabilities = ['network'];
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].dependencies = ['other'];
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].trusted = true;
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].source.path = 'extensions/../private.js';
      },
      (project: any) => {
        project.turboWarpPlus.extensions[0].source = {
          type: 'remote-cacheable',
          url: 'https://example.test/a.js',
        };
      },
    ];
    for (const mutate of mutations) {
      const {project, entries} = fixture('embedded-file');
      mutate(project);
      entries['project.json'] = strToU8(JSON.stringify(project));
      expect(() => unpackSb3(zipSync(entries))).toThrow();
    }
  });

  it('rejects missing or modified locks and code without changing the original archive', () => {
    for (const change of [
      (entries: Record<string, Uint8Array>) => {
        delete entries[extensionLocksEntry];
      },
      (entries: Record<string, Uint8Array>) => {
        delete entries['extensions/recipefixture.js'];
      },
      (entries: Record<string, Uint8Array>) => {
        entries['extensions/recipefixture.js'] = strToU8('changed');
      },
      (entries: Record<string, Uint8Array>) => {
        entries[extensionLocksEntry] = strToU8('{"formatVersion":99,"extensions":[]}');
      },
    ]) {
      const {entries} = fixture('embedded-file');
      change(entries);
      const original = zipSync(entries);
      const copy = original.slice();
      expect(() => unpackSb3(original)).toThrow();
      expect(original).toEqual(copy);
    }
  });

  it('rejects a valid lock for a legacy extension outside the Plus manifest', async () => {
    const {project, entries} = fixture('embedded-data');
    const other = await buildStandardExtension(standardBuildFixture({id: 'otherfixture'}));
    const otherLock = lockStandardExtensionBuild(other);
    Object.assign(project.extensionURLs, {
      otherfixture:
        'data:text/javascript;base64,' +
        Buffer.from(other.files.get('recipe-fixture.js')!).toString('base64'),
    });
    project.extensions.push('otherfixture');
    entries['project.json'] = strToU8(JSON.stringify(project));
    entries[extensionLocksEntry] = strToU8(
      JSON.stringify({
        formatVersion: 1,
        extensions: [
          {id: 'recipefixture', artifactLock: lock},
          {id: 'otherfixture', artifactLock: otherLock},
        ],
      }),
    );
    expect(() => unpackSb3(zipSync(entries))).toThrow('orphan artifact lock');
  });

  it('refuses source edits that detach storage, receipt or manifest and leaves the input unchanged', async () => {
    const {entries} = fixture('embedded-file');
    const root = await mkdtemp(path.join(tmpdir(), 'plus-artifact-tamper-'));
    try {
      const inputPath = path.join(root, 'input.sb3');
      const original = zipSync(entries);
      const outputDirectory = path.join(root, 'source');
      await writeFile(inputPath, original);
      await importSb3({inputPath, outputDirectory, protectedRoot: root});
      const file = path.join(outputDirectory, 'project.source.json');
      const project = JSON.parse(await readFile(file, 'utf8'));
      project.turboWarpPlus.extensions[0].sha256 = '0'.repeat(64);
      await writeFile(file, JSON.stringify(project));
      await expect(createDeterministicSb3(outputDirectory)).rejects.toThrow('hash differ');
      project.turboWarpPlus.extensions[0].sha256 = lock.bundleSHA256;
      await writeFile(file, JSON.stringify(project));
      const sourceFile = path.join(outputDirectory, 'sb3-source.json');
      const source = JSON.parse(await readFile(sourceFile, 'utf8'));
      source.archiveEntries = source.archiveEntries.filter(
        (name: string) => name !== 'extensions/recipefixture.js',
      );
      await writeFile(sourceFile, JSON.stringify(source));
      await expect(createDeterministicSb3(outputDirectory)).rejects.toThrow(
        'archive entry is missing',
      );
      const files = unpackSb3(original).files;
      files.set('sb3-source.json', strToU8(JSON.stringify(source)));
      expect(() => validateSourceFiles(files)).toThrow('archive entry is missing');
      expect(await readFile(inputPath)).toEqual(Buffer.from(original));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
