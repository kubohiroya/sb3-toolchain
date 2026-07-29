// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {access, cp, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {runCli} from '../src/cli.js';
import {
  createDeterministicSb3,
  extensionIntegrity,
  migrateExtensionId,
  planExtensionIdMigration,
  updateExtensions,
  validateSb3Source,
} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');
const oldId = 'twOld';
const newId = 'newext';
const installedCommit = '1'.repeat(40);
const updatedCommit = '2'.repeat(40);

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-id-migration-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function extensionContents(id, version = 'V1') {
  return Buffer.from(
    `// Name: Migration test\n// ID: ${id}\n` +
      `Scratch.extensions.register(new Extension${version}());\n`,
  );
}

async function writeMigrationSource(sourceDirectory, {managed = false} = {}) {
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

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), (error) => error?.code === 'ENOENT');
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
    assert.equal(plan.artifactReady, false);
    assert.deepEqual(plan.counts, {
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
    assert.equal(plan.totalChanges, 9);
    assert.ok(
      plan.unclassifiedReferences.some(
        (reference) =>
          reference.path === '/targets/0/variables/variableId/0' &&
          reference.value === `${oldId} variable name`,
      ),
    );
    assert.ok(
      plan.unclassifiedReferences.some(
        (reference) =>
          reference.path === '/targets/0/blocks/block/fields/TEXT/0' &&
          reference.value === `${oldId} literal`,
      ),
    );
    assert.ok(
      plan.unclassifiedReferences.some(
        (reference) => reference.value === `other_${oldId}_operation`,
      ),
    );
    const output = [];
    await runCli(['extensions', 'migrate-id', sourceDirectory, '--from', oldId, '--to', newId], {
      log: (message) => output.push(message),
    });
    assert.match(output[0], /^Dry run:/u);
    assert.ok(output.some((line) => line.startsWith('Unclassified value:')));

    await assert.rejects(
      planExtensionIdMigration({
        fromId: oldId,
        sourceDirectory,
        toId: 'New-ID',
      }),
      /\[a-z0-9\]\+/u,
    );
    const project = await readJson(path.join(sourceDirectory, 'project.source.json'));
    project.extensionURLs[newId] = 'https://example.com/collision.js';
    await writeJson(path.join(sourceDirectory, 'project.source.json'), project);
    await assert.rejects(
      planExtensionIdMigration({
        fromId: oldId,
        sourceDirectory,
        toId: newId,
      }),
      /already contains/u,
    );
  });
});

test('requires a new-ID artifact, then migrates known schema fields atomically', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const {oldPath} = await writeMigrationSource(sourceDirectory);
    await assert.rejects(
      migrateExtensionId({
        fromId: oldId,
        sourceDirectory,
        toId: newId,
        yes: true,
      }),
      /must declare/u,
    );
    assert.equal(
      (await readJson(path.join(sourceDirectory, 'embedded-extensions.json'))).extensions[0].id,
      oldId,
    );

    await writeFile(oldPath, extensionContents(newId));
    const dryRun = await migrateExtensionId({
      fromId: oldId,
      sourceDirectory,
      toId: newId,
    });
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.artifactReady, true);
    assert.equal(
      (await readJson(path.join(sourceDirectory, 'embedded-extensions.json'))).extensions[0].id,
      oldId,
    );

    const migrated = await migrateExtensionId({
      fromId: oldId,
      sourceDirectory,
      toId: newId,
      yes: true,
    });
    assert.equal(migrated.applied, true);
    await assertMissing(path.join(sourceDirectory, `extensions/${oldId}.js`));
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, `extensions/${newId}.js`)),
      extensionContents(newId),
    );

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    assert.equal(manifest.extensions[0].id, newId);
    assert.equal(manifest.extensions[0].path, `extensions/${newId}.js`);
    const project = await readJson(path.join(sourceDirectory, 'project.source.json'));
    assert.deepEqual(project.extensions, [newId, 'external']);
    assert.equal(project.extensionURLs[newId], `embedded-extension:extensions/${newId}.js`);
    assert.equal(project.targets[0].blocks.block.opcode, `${newId}_doThing`);
    assert.equal(project.targets[0].blocks.menu.opcode, `${newId}_menu`);
    assert.equal(project.targets[0].blocks.unrelated.opcode, `other_${oldId}_operation`);
    assert.equal(project.monitors[0].opcode, `${newId}_value`);
    assert.equal(project.monitors[1].opcode, `other_${oldId}_value`);
    assert.equal(project.targets[0].variables.variableId[0], `${oldId} variable name`);
    assert.equal(project.targets[0].blocks.block.fields.TEXT[0], `${oldId} literal`);
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
    const calls = [];
    let servedContents = extensionContents(oldId, 'V2');
    const fetchImplementation = async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === 'api.github.com') {
        return new Response(JSON.stringify({sha: updatedCommit}));
      }
      assert.equal(
        parsedUrl.pathname,
        `/example/migration-extension/${updatedCommit}/dist/${newId}.js`,
      );
      return new Response(servedContents);
    };

    await assert.rejects(
      updateExtensions({
        extensionId: oldId,
        fetch: fetchImplementation,
        migrateToId: newId,
        sourceArtifact: `dist/${newId}.js`,
        sourceDirectory,
        yes: true,
      }),
      /expected newext/u,
    );
    assert.equal(
      (await readJson(path.join(sourceDirectory, 'embedded-extensions.json'))).extensions[0].id,
      oldId,
    );

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
    assert.equal(result.changed, true);
    assert.equal(result.extensions[0].id, newId);
    assert.equal(result.extensions[0].previousId, oldId);
    assert.equal(result.migration.fromId, oldId);
    assert.equal(calls.length, 2);
    assert.notDeepEqual(
      await readFile(path.join(sourceDirectory, `extensions/${newId}.js`)),
      originalContents,
    );

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    const extension = manifest.extensions[0];
    assert.equal(extension.id, newId);
    assert.equal(extension.path, `extensions/${newId}.js`);
    assert.equal(extension.source.artifact, `dist/${newId}.js`);
    assert.equal(extension.source.resolvedCommit, updatedCommit);
    assert.equal(extension.source.integrity, extensionIntegrity(updatedContents));
    await validateSb3Source(sourceDirectory);
    await createDeterministicSb3(sourceDirectory);
  });
});
