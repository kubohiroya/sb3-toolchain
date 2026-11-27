// SPDX-License-Identifier: MPL-2.0
import {cp, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {strToU8, unzipSync, zipSync} from 'fflate';
import {describe, expect, it} from 'vitest';
import {unpackSb3, validateSourceFiles} from '../src/browser';
import {
  extensionLocksEntry,
  lockStandardExtensionBuild,
  validateExtensionArtifactLock,
} from '../src/extension-artifact-lock';
import {createDeterministicSb3} from '../src/source';
import {importSb3} from '../src/import';
import {buildStandardExtension, runStandardExtensionBuild} from '../src/standard-extension-build';
import {standardBuildFixture} from './standard-build-fixture';

describe('extension artifact locks', () => {
  it('preserves the receipt and API through SB3, browser unpack, Node import and rebuild', async () => {
    const build = await buildStandardExtension(standardBuildFixture());
    const lock = lockStandardExtensionBuild(build);
    const bundle = build.files.get('recipe-fixture.js')!;
    const project = {
      targets: [{isStage: true, name: 'Stage', blocks: {}, costumes: [], sounds: []}],
      extensions: ['recipefixture'],
      extensionURLs: {
        recipefixture: 'data:text/javascript;base64,' + Buffer.from(bundle).toString('base64'),
      },
    };
    const archive = zipSync({
      'project.json': strToU8(JSON.stringify(project)),
      [extensionLocksEntry]: strToU8(
        JSON.stringify({formatVersion: 1, extensions: [{id: 'recipefixture', artifactLock: lock}]}),
      ),
    });
    const unpacked = unpackSb3(archive);
    const manifest = JSON.parse(
      new TextDecoder().decode(unpacked.files.get('embedded-extensions.json')),
    );
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.extensions[0].artifactLock).toEqual(lock);
    expect(lock.provenance).toMatchObject({
      kind: 'build',
      receipt: {source: {kind: 'local-snapshot'}},
    });
    const root = await mkdtemp(path.join(tmpdir(), 'toolchain-lock-test-'));
    try {
      const inputPath = path.join(root, 'project.sb3');
      const outputDirectory = path.join(root, 'source');
      await writeFile(inputPath, archive);
      await importSb3({inputPath, outputDirectory, protectedRoot: root});
      const first = await createDeterministicSb3(outputDirectory);
      const again = unpackSb3(first.archive);
      expect(again.files.get('embedded-extensions.json')).toEqual(
        unpacked.files.get('embedded-extensions.json'),
      );
      expect(
        JSON.parse(new TextDecoder().decode(unzipSync(first.archive)[extensionLocksEntry]))
          .extensions[0].artifactLock,
      ).toEqual(lock);
      await writeFile(inputPath, first.archive);
      await importSb3({
        inputPath,
        outputDirectory: path.join(root, 'reimport'),
        protectedRoot: root,
      });
      const second = await createDeterministicSb3(path.join(root, 'reimport'));
      expect(second.archive).toEqual(first.archive);
      const bytes = await readFile(path.join(outputDirectory, 'extensions/recipefixture.js'));
      await writeFile(
        path.join(outputDirectory, 'extensions/recipefixture.js'),
        Buffer.concat([bytes, Buffer.from('changed')]),
      );
      await expect(createDeterministicSb3(outputDirectory)).rejects.toThrow(
        'artifact lock mismatch',
      );
      expect(await readFile(inputPath)).toEqual(Buffer.from(first.archive));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects unknown versions, credential fields and altered API or source bytes', async () => {
    const build = await buildStandardExtension(standardBuildFixture());
    const lock = lockStandardExtensionBuild(build);
    for (const changed of [
      {...lock, formatVersion: 2},
      {...lock, token: 'do-not-save'},
      {...lock, apiJSON: lock.apiJSON.replace('greet', 'changed')},
      {
        ...lock,
        provenance: {
          kind: 'build',
          receipt: {
            ...build.receipt,
            source: {kind: 'local-snapshot', path: '/private/home/project'},
          },
        },
      },
    ])
      expect(() => validateExtensionArtifactLock(changed, 'recipefixture')).toThrow();
    expect(() => validateExtensionArtifactLock(lock, 'recipefixture', strToU8('changed'))).toThrow(
      'artifact lock mismatch',
    );
    const changed = new Map(build.files);
    changed.set('recipe-fixture.js.map', strToU8('corrupt cache'));
    expect(() => lockStandardExtensionBuild({...build, files: changed})).toThrow('receipt');
  });

  it('keeps format 1 projects readable and refuses locks in an old embedded manifest version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'toolchain-old-lock-test-'));
    try {
      await cp(new URL('./fixtures/minimal-source', import.meta.url), root, {recursive: true});
      const built = await createDeterministicSb3(root);
      expect(unzipSync(built.archive)[extensionLocksEntry]).toBeUndefined();
      const unpacked = unpackSb3(built.archive);
      const manifest = JSON.parse(
        new TextDecoder().decode(unpacked.files.get('embedded-extensions.json')),
      );
      expect(manifest.formatVersion).toBe(1);
      manifest.extensions[0].artifactLock = {formatVersion: 99};
      unpacked.files.set('embedded-extensions.json', strToU8(JSON.stringify(manifest)));
      expect(() => validateSourceFiles(unpacked.files)).toThrow('manifest format 2');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('standard build jobs', () => {
  it('produces the same artifacts in an independent job without executing source or scripts', async () => {
    const fixture = standardBuildFixture();
    fixture.set(
      'src/index.ts',
      Buffer.from(
        "Scratch.extensions.register({}); globalThis.__mustNeverRun = true; throw new Error('do not evaluate');",
      ),
    );
    const direct = await buildStandardExtension(fixture);
    const job = await runStandardExtensionBuild(fixture);
    expect(job.receipt).toEqual(direct.receipt);
    expect([...job.files.keys()]).toEqual([...direct.files.keys()]);
    for (const [file, bytes] of job.files)
      expect(Buffer.from(bytes)).toEqual(Buffer.from(direct.files.get(file)!));
    expect((globalThis as Record<string, unknown>).__mustNeverRun).toBeUndefined();
  });

  it('terminates and cleans a timed-out or cancelled job before rejecting', async () => {
    const temporaryJobs = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith('sb3-extension-build-')).sort();
    const before = await temporaryJobs();
    await expect(runStandardExtensionBuild(standardBuildFixture(), {timeoutMs: 1})).rejects.toThrow(
      'timed out',
    );
    const controller = new AbortController();
    const job = runStandardExtensionBuild(standardBuildFixture(), {signal: controller.signal});
    setTimeout(() => controller.abort(), 10);
    await expect(job).rejects.toThrow(/cancelled|aborted/u);
    await expect(runStandardExtensionBuild(standardBuildFixture())).resolves.toHaveProperty(
      'files',
    );
    expect(await temporaryJobs()).toEqual(before);
  });

  it('keeps parallel jobs separate and does not inherit NODE_OPTIONS', async () => {
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = '--require /this-must-not-be-loaded-by-the-child.js';
      const [first, second] = await Promise.all([
        runStandardExtensionBuild(standardBuildFixture({id: 'first'})),
        runStandardExtensionBuild(standardBuildFixture({id: 'second'})),
      ]);
      expect(
        JSON.parse(new TextDecoder().decode(first.files.get('extension-manifest.json'))).id,
      ).toBe('first');
      expect(
        JSON.parse(new TextDecoder().decode(second.files.get('extension-manifest.json'))).id,
      ).toBe('second');
      expect(first.receipt.snapshotSHA256).not.toBe(second.receipt.snapshotSHA256);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });

  it('detects a changed input or dependency lock before returning any candidate', async () => {
    await expect(
      buildStandardExtension(standardBuildFixture(), {expectedSnapshotSHA256: '0'.repeat(64)}),
    ).rejects.toThrow('snapshot or lockfile changed');
    await expect(
      buildStandardExtension(standardBuildFixture(), {expectedLockfileSHA256: '0'.repeat(64)}),
    ).rejects.toThrow('snapshot or lockfile changed');
  });
});
