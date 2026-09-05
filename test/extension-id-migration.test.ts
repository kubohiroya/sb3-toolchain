// SPDX-License-Identifier: MPL-2.0

import {access, cp, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test} from 'vitest';

import {runCli} from '../src/cli';
import {
  createDeterministicSb3,
  extensionApiManifestIntegrity,
  extensionIntegrity,
  migrateExtensionId,
  planExtensionIdMigration,
  updateExtensions,
  validateSb3Source,
} from '../src/index';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');
const oldId = 'twOld';
const newId = 'newext';
const installedCommit = '1'.repeat(40);
const updatedCommit = '2'.repeat(40);
const legacyTmId = ['tm', 'pose'].join('');
const tmId = 'kubohiroyatm';

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-id-migration-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function readJson(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function extensionContents(id: string, version = 'V1'): Buffer {
  return Buffer.from(
    `// Name: Migration test\n// ID: ${id}\n` +
      `Scratch.extensions.register(new Extension${version}());\n`,
  );
}

function apiManifestContents(id: string, opcode = 'accumulatedPose'): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        formatVersion: 1,
        id,
        blocks: [
          {
            opcode,
            blockType: 'REPORTER',
            arguments: [{id: 'TARGET', type: 'STRING'}],
          },
        ],
        menus: [],
      },
      null,
      2,
    )}\n`,
  );
}

async function writeMigrationSource(
  sourceDirectory: string,
  {managed = false}: {managed?: boolean} = {},
) {
  await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
  const oldPath = path.join(sourceDirectory, `extensions/${oldId}.js`);
  await rename(path.join(sourceDirectory, 'extensions/example.js'), oldPath);
  const contents = extensionContents(oldId);
  await writeFile(oldPath, contents);

  const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
  const manifest = await readJson(manifestPath);
  manifest.extensions[0].id = oldId;
  manifest.extensions[0].path = `extensions/${oldId}.js`;
  if (managed) {
    manifest.extensions[0].source = {
      provider: 'github',
      repository: 'example/migration-extension',
      ref: 'main',
      resolvedCommit: installedCommit,
      artifact: `dist/${oldId}.js`,
      integrity: extensionIntegrity(contents),
    };
  }
  await writeJson(manifestPath, manifest);

  const projectPath = path.join(sourceDirectory, 'project.source.json');
  const project = await readJson(projectPath);
  delete project.extensionURLs.example;
  project.extensions = [oldId, 'external'];
  project.extensionURLs = {
    [oldId]: `embedded-extension:extensions/${oldId}.js`,
    external: project.extensionURLs.external,
  };
  project.targets[0].variables = {
    variableId: [`${oldId} variable name`, 0],
  };
  project.targets[0].blocks = {
    block: {
      opcode: `${oldId}_doThing`,
      fields: {
        TEXT: [`${oldId} literal`, null],
      },
      inputs: {},
      next: null,
      parent: null,
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    menu: {
      opcode: `${oldId}_menu`,
      fields: {},
      inputs: {},
      next: null,
      parent: 'block',
      shadow: true,
      topLevel: false,
    },
    unrelated: {
      opcode: `other_${oldId}_operation`,
      fields: {},
      inputs: {},
      next: null,
      parent: null,
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
  };
  project.monitors = [
    {id: 'monitor', mode: 'default', opcode: `${oldId}_value`, params: {}},
    {id: 'other', mode: 'default', opcode: `other_${oldId}_value`, params: {}},
  ];
  project.meta.migrationNote = `${oldId} remains in this literal`;
  await writeJson(projectPath, project);
  return {contents, manifestPath, oldPath, projectPath};
}

async function assertMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toSatisfy((error: any) => error?.code === 'ENOENT');
}

async function writeTurboWarpTmMigrationSource(sourceDirectory: string) {
  await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
  const otherId = 'textlines';
  const legacyContents = extensionContents(legacyTmId);
  const legacyApiManifest = apiManifestContents(legacyTmId);

  await rename(
    path.join(sourceDirectory, 'extensions/example.js'),
    path.join(sourceDirectory, `extensions/${legacyTmId}.js`),
  );
  await Promise.all([
    writeFile(path.join(sourceDirectory, `extensions/${legacyTmId}.js`), legacyContents),
    writeFile(
      path.join(sourceDirectory, `extensions/${legacyTmId}.manifest.json`),
      legacyApiManifest,
    ),
    writeFile(path.join(sourceDirectory, `extensions/${otherId}.js`), extensionContents(otherId)),
  ]);

  const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
  const manifest = await readJson(manifestPath);
  manifest.extensions = [
    {
      id: legacyTmId,
      path: `extensions/${legacyTmId}.js`,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
      source: {
        provider: 'github',
        repository: 'kubohiroya/turbowarp-tm',
        ref: 'main',
        resolvedCommit: installedCommit,
        artifact: `dist/${legacyTmId}.js`,
        integrity: extensionIntegrity(legacyContents),
        apiManifest: {
          artifact: `dist/${legacyTmId}.manifest.json`,
          formatVersion: 1,
          integrity: extensionApiManifestIntegrity(legacyApiManifest),
          path: `extensions/${legacyTmId}.manifest.json`,
        },
      },
    },
    {
      id: otherId,
      path: `extensions/${otherId}.js`,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
    },
  ];
  await writeJson(manifestPath, manifest);

  const projectPath = path.join(sourceDirectory, 'project.source.json');
  const project = await readJson(projectPath);
  project.extensions = [legacyTmId, otherId];
  project.extensionURLs = {
    [legacyTmId]: `embedded-extension:extensions/${legacyTmId}.js`,
    [otherId]: `embedded-extension:extensions/${otherId}.js`,
    external: project.extensionURLs.external,
  };
  project.targets[0].blocks = {
    tmReporter: {
      opcode: `${legacyTmId}_accumulatedPose`,
      fields: {},
      inputs: {},
      next: null,
      parent: null,
      shadow: false,
      topLevel: true,
      x: 0,
      y: 0,
    },
    tmMenu: {
      opcode: `${legacyTmId}_targetMenu`,
      fields: {},
      inputs: {},
      next: null,
      parent: 'tmReporter',
      shadow: true,
      topLevel: false,
    },
    otherExtension: {
      opcode: `${otherId}_contains_${legacyTmId}`,
      fields: {},
      inputs: {},
      next: null,
      parent: null,
      shadow: false,
      topLevel: true,
      x: 100,
      y: 0,
    },
  };
  project.monitors = [
    {id: 'tmMonitor', mode: 'default', opcode: `${legacyTmId}_accumulatedPose`, params: {}},
  ];
  await writeJson(projectPath, project);
}

test('plans schema-aware changes and reports strings it will not rewrite', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeMigrationSource(sourceDirectory);

    const plan = await planExtensionIdMigration({
      fromId: oldId,
      sourceDirectory,
      toId: newId,
    });
    expect(plan.artifactReady).toBe(false);
    expect(plan.counts).toStrictEqual({
      apiManifestArtifacts: 0,
      blockOpcodes: 2,
      extensionFiles: 1,
      extensionUrlKeys: 1,
      extensionUrlValues: 1,
      manifestIds: 1,
      manifestPaths: 1,
      monitorOpcodes: 1,
      projectExtensions: 1,
      sourceArtifacts: 0,
    });
    expect(plan.totalChanges).toBe(9);
    expect(
      plan.unclassifiedReferences.some(
        (reference) =>
          reference.path === '/targets/0/variables/variableId/0' &&
          reference.value === `${oldId} variable name`,
      ),
    ).toBeTruthy();
    expect(
      plan.unclassifiedReferences.some(
        (reference) =>
          reference.path === '/targets/0/blocks/block/fields/TEXT/0' &&
          reference.value === `${oldId} literal`,
      ),
    ).toBeTruthy();
    expect(
      plan.unclassifiedReferences.some(
        (reference) => reference.value === `other_${oldId}_operation`,
      ),
    ).toBeTruthy();
    const output: string[] = [];
    await runCli(['extensions', 'migrate-id', sourceDirectory, '--from', oldId, '--to', newId], {
      log: (message) => output.push(message),
    });
    expect(output[0]).toMatch(/^Dry run:/u);
    expect(output.some((line) => line.startsWith('Unclassified value:'))).toBeTruthy();

    await expect(
      planExtensionIdMigration({
        fromId: oldId,
        sourceDirectory,
        toId: 'New-ID',
      }),
    ).rejects.toThrow(/\[a-z0-9\]\+/u);
    const project = await readJson(path.join(sourceDirectory, 'project.source.json'));
    project.extensionURLs[newId] = 'https://example.com/collision.js';
    await writeJson(path.join(sourceDirectory, 'project.source.json'), project);
    await expect(
      planExtensionIdMigration({
        fromId: oldId,
        sourceDirectory,
        toId: newId,
      }),
    ).rejects.toThrow(/already contains/u);
  });
});

test('requires a new-ID artifact, then migrates known schema fields atomically', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {oldPath} = await writeMigrationSource(sourceDirectory);
    await expect(
      migrateExtensionId({
        fromId: oldId,
        sourceDirectory,
        toId: newId,
        yes: true,
      }),
    ).rejects.toThrow(/must declare/u);
    expect(
      (await readJson(path.join(sourceDirectory, 'embedded-extensions.json'))).extensions[0].id,
    ).toBe(oldId);

    await writeFile(oldPath, extensionContents(newId));
    const dryRun = await migrateExtensionId({
      fromId: oldId,
      sourceDirectory,
      toId: newId,
    });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.artifactReady).toBe(true);
    expect(
      (await readJson(path.join(sourceDirectory, 'embedded-extensions.json'))).extensions[0].id,
    ).toBe(oldId);

    const migrated = await migrateExtensionId({
      fromId: oldId,
      sourceDirectory,
      toId: newId,
      yes: true,
    });
    expect(migrated.applied).toBe(true);
    await assertMissing(path.join(sourceDirectory, `extensions/${oldId}.js`));
    expect(await readFile(path.join(sourceDirectory, `extensions/${newId}.js`))).toStrictEqual(
      extensionContents(newId),
    );

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    expect(manifest.extensions[0].id).toBe(newId);
    expect(manifest.extensions[0].path).toBe(`extensions/${newId}.js`);
    const project = await readJson(path.join(sourceDirectory, 'project.source.json'));
    expect(project.extensions).toStrictEqual([newId, 'external']);
    expect(project.extensionURLs[newId]).toBe(`embedded-extension:extensions/${newId}.js`);
    expect(project.targets[0].blocks.block.opcode).toBe(`${newId}_doThing`);
    expect(project.targets[0].blocks.menu.opcode).toBe(`${newId}_menu`);
    expect(project.targets[0].blocks.unrelated.opcode).toBe(`other_${oldId}_operation`);
    expect(project.monitors[0].opcode).toBe(`${newId}_value`);
    expect(project.monitors[1].opcode).toBe(`other_${oldId}_value`);
    expect(project.targets[0].variables.variableId[0]).toBe(`${oldId} variable name`);
    expect(project.targets[0].blocks.block.fields.TEXT[0]).toBe(`${oldId} literal`);
    await validateSb3Source(sourceDirectory);
    await createDeterministicSb3(sourceDirectory);
  });
});

test('updates a managed artifact and migrates its ID and provenance together', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {contents: originalContents} = await writeMigrationSource(sourceDirectory, {
      managed: true,
    });
    const updatedContents = extensionContents(newId, 'V2');
    const calls: string[] = [];
    let servedContents = extensionContents(oldId, 'V2');
    const fetchImplementation = async (url: any, options?: any): Promise<Response> => {
      calls.push(String(url));
      expect(options.redirect).toBe('error');
      const parsedUrl = new URL(String(url));
      if (parsedUrl.hostname === 'api.github.com') {
        return new Response(JSON.stringify({sha: updatedCommit}));
      }
      expect(parsedUrl.pathname).toBe(
        `/example/migration-extension/${updatedCommit}/dist/${newId}.js`,
      );
      return new Response(servedContents);
    };

    await expect(
      updateExtensions({
        extensionId: oldId,
        fetch: fetchImplementation,
        migrateToId: newId,
        sourceArtifact: `dist/${newId}.js`,
        sourceDirectory,
        yes: true,
      }),
    ).rejects.toThrow(/expected newext/u);
    expect(
      (await readJson(path.join(sourceDirectory, 'embedded-extensions.json'))).extensions[0].id,
    ).toBe(oldId);

    servedContents = updatedContents;
    calls.length = 0;
    const result = await updateExtensions({
      extensionId: oldId,
      fetch: fetchImplementation,
      migrateToId: newId,
      sourceArtifact: `dist/${newId}.js`,
      sourceDirectory,
      yes: true,
    });
    expect(result.changed).toBe(true);
    expect(result.extensions[0].id).toBe(newId);
    expect(result.extensions[0].previousId).toBe(oldId);
    expect(result.migration?.fromId).toBe(oldId);
    expect(calls.length).toBe(2);
    expect(await readFile(path.join(sourceDirectory, `extensions/${newId}.js`))).not.toStrictEqual(
      originalContents,
    );

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    const extension = manifest.extensions[0];
    expect(extension.id).toBe(newId);
    expect(extension.path).toBe(`extensions/${newId}.js`);
    expect(extension.source.artifact).toBe(`dist/${newId}.js`);
    expect(extension.source.resolvedCommit).toBe(updatedCommit);
    expect(extension.source.integrity).toBe(extensionIntegrity(updatedContents));
    await validateSb3Source(sourceDirectory);
    await createDeterministicSb3(sourceDirectory);
  });
});

test('migrates the TurboWarp TM legacy extension ID fixture with the generic workflow', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeTurboWarpTmMigrationSource(sourceDirectory);

    const plan = await planExtensionIdMigration({
      fromId: legacyTmId,
      sourceDirectory,
      toId: tmId,
    });
    expect(plan.artifactReady).toBe(false);
    expect(plan.counts).toStrictEqual({
      apiManifestArtifacts: 0,
      blockOpcodes: 2,
      extensionFiles: 1,
      extensionUrlKeys: 1,
      extensionUrlValues: 1,
      manifestIds: 1,
      manifestPaths: 2,
      monitorOpcodes: 1,
      projectExtensions: 1,
      sourceArtifacts: 0,
    });
    expect(plan.totalChanges).toBe(10);
    expect(
      plan.unclassifiedReferences.some((reference) => reference.value.includes(`${legacyTmId}`)),
    ).toBeTruthy();

    const output: string[] = [];
    await runCli(
      ['extensions', 'migrate-id', sourceDirectory, '--from', legacyTmId, '--to', tmId],
      {
        log: (message) => output.push(message),
      },
    );
    expect(output.some((line) => line.includes('Dry run:'))).toBeTruthy();
    expect(output.some((line) => line.includes('manifestPaths=2'))).toBeTruthy();
    expect(output.some((line) => line.includes('Unclassified value:'))).toBeTruthy();

    const updatedContents = extensionContents(tmId, 'V2');
    const updatedApiManifest = apiManifestContents(tmId);
    const calls: string[] = [];
    const fetchImplementation = async (url: any, options?: any): Promise<Response> => {
      calls.push(String(url));
      expect(options.redirect).toBe('error');
      const parsedUrl = new URL(String(url));
      if (parsedUrl.hostname === 'api.github.com') {
        return new Response(JSON.stringify({sha: updatedCommit}));
      }
      if (parsedUrl.pathname.endsWith(`/dist/${tmId}.js`)) {
        return new Response(updatedContents);
      }
      expect(parsedUrl.pathname.endsWith(`/dist/${tmId}.manifest.json`)).toBeTruthy();
      return new Response(updatedApiManifest);
    };

    const result = await updateExtensions({
      apiManifestArtifact: `dist/${tmId}.manifest.json`,
      extensionId: legacyTmId,
      fetch: fetchImplementation,
      migrateToId: tmId,
      sourceArtifact: `dist/${tmId}.js`,
      sourceDirectory,
      yes: true,
    });
    expect(result.changed).toBe(true);
    expect(result.migration?.fromId).toBe(legacyTmId);
    expect(result.migration?.toId).toBe(tmId);
    expect(result.apiCompatibility[0].changes).toStrictEqual([]);
    expect(calls.length).toBe(3);

    await assertMissing(path.join(sourceDirectory, `extensions/${legacyTmId}.js`));
    await assertMissing(path.join(sourceDirectory, `extensions/${legacyTmId}.manifest.json`));
    expect(await readFile(path.join(sourceDirectory, `extensions/${tmId}.js`))).toStrictEqual(
      updatedContents,
    );
    expect(
      await readFile(path.join(sourceDirectory, `extensions/${tmId}.manifest.json`)),
    ).toStrictEqual(updatedApiManifest);

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    const extension = manifest.extensions[0];
    expect(extension.id).toBe(tmId);
    expect(extension.path).toBe(`extensions/${tmId}.js`);
    expect(extension.source.artifact).toBe(`dist/${tmId}.js`);
    expect(extension.source.integrity).toBe(extensionIntegrity(updatedContents));
    expect(extension.source.apiManifest.artifact).toBe(`dist/${tmId}.manifest.json`);
    expect(extension.source.apiManifest.integrity).toBe(
      extensionApiManifestIntegrity(updatedApiManifest),
    );

    const project = await readJson(path.join(sourceDirectory, 'project.source.json'));
    expect(project.extensions).toStrictEqual([tmId, 'textlines']);
    expect(project.extensionURLs[tmId]).toBe(`embedded-extension:extensions/${tmId}.js`);
    expect(project.targets[0].blocks.tmReporter.opcode).toBe(`${tmId}_accumulatedPose`);
    expect(project.targets[0].blocks.tmMenu.opcode).toBe(`${tmId}_targetMenu`);
    expect(project.targets[0].blocks.otherExtension.opcode).toBe(
      `textlines_contains_${legacyTmId}`,
    );
    expect(project.monitors[0].opcode).toBe(`${tmId}_accumulatedPose`);
    await validateSb3Source(sourceDirectory);
    await createDeterministicSb3(sourceDirectory);
  });
});

test('rejects the TurboWarp TM target ID when the fixture already contains it', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeTurboWarpTmMigrationSource(sourceDirectory);
    const projectPath = path.join(sourceDirectory, 'project.source.json');
    const project = await readJson(projectPath);
    project.extensions.push(tmId);
    await writeJson(projectPath, project);

    await expect(
      planExtensionIdMigration({
        fromId: legacyTmId,
        sourceDirectory,
        toId: tmId,
      }),
    ).rejects.toThrow(/already contains/u);
  });
});
