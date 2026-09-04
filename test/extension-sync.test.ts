// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  extensionApiManifestIntegrity,
  extensionIntegrity,
  extensionStatus,
  syncExtensions,
  updateExtensions,
} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');
const installedCommit = '1'.repeat(40);
const updatedCommit = '2'.repeat(40);

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-extension-sync-test-'));
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

function extensionContents(id, version) {
  return Buffer.from(
    `// Name: ${id}\n// ID: ${id}\n` + `Scratch.extensions.register(new Extension${version}());\n`,
  );
}

function sourceMetadata(id, contents, repository = `example/${id}-extension`) {
  return {
    provider: 'github',
    repository,
    ref: 'main',
    resolvedCommit: installedCommit,
    artifact: `dist/${id}.js`,
    integrity: extensionIntegrity(contents),
  };
}

function apiManifest(id, overrides = {}) {
  return {
    formatVersion: 1,
    id,
    blocks: [
      {
        opcode: 'value',
        blockType: 'REPORTER',
        arguments: [{id: 'INPUT', type: 'STRING'}],
      },
    ],
    menus: [],
    ...overrides,
  };
}

function apiManifestContents(id, overrides = {}) {
  return Buffer.from(`${JSON.stringify(apiManifest(id, overrides), null, 2)}\n`);
}

async function addApiManifest(
  sourceDirectory,
  id,
  contents = apiManifestContents(id),
  artifact = 'dist/extension-manifest.json',
) {
  const embeddedManifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
  const embeddedManifest = await readJson(embeddedManifestPath);
  const extension = embeddedManifest.extensions.find((entry) => entry.id === id);
  assert(extension);
  extension.source.apiManifest = {
    artifact,
    formatVersion: 1,
    integrity: extensionApiManifestIntegrity(contents),
    path: `extensions/${id}.manifest.json`,
  };
  await Promise.all([
    writeJson(embeddedManifestPath, embeddedManifest),
    writeFile(path.join(sourceDirectory, extension.source.apiManifest.path), contents),
  ]);
  return contents;
}

async function writeManagedSource(sourceDirectory, extensionIds = ['example']) {
  await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
  const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
  const projectPath = path.join(sourceDirectory, 'project.source.json');
  const manifest = await readJson(manifestPath);
  const project = await readJson(projectPath);
  manifest.extensions = [];

  const contentsById = new Map();
  for (const id of extensionIds) {
    const contents = extensionContents(id, 'V1');
    const extension = {
      id,
      path: `extensions/${id}.js`,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
      source: sourceMetadata(id, contents),
    };
    manifest.extensions.push(extension);
    project.extensionURLs[id] = `embedded-extension:${extension.path}`;
    await writeFile(path.join(sourceDirectory, extension.path), contents);
    contentsById.set(id, contents);
  }
  if (!extensionIds.includes('example')) {
    delete project.extensionURLs.example;
    await rm(path.join(sourceDirectory, 'extensions/example.js'));
  }
  await writeJson(manifestPath, manifest);
  await writeJson(projectPath, project);
  return contentsById;
}

async function installNpmExtensionPackage(directory, contents, {version = '1.2.3'} = {}) {
  const packageDirectory = path.join(directory, 'node_modules', '@example', 'example-extension');
  await mkdir(path.join(packageDirectory, 'dist'), {recursive: true});
  await writeFile(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify({name: '@example/example-extension', version}, null, 2)}\n`,
  );
  await writeFile(path.join(packageDirectory, 'dist/example.js'), contents);
  return packageDirectory;
}

function mockGithub({artifacts = new Map(), commits = new Map()}) {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({options, url});
    assert.equal(options.redirect, 'error');
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'api.github.com') {
      const repository = parsedUrl.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/commits\//u)?.[1];
      const commit = commits.get(repository);
      return commit instanceof Response
        ? commit
        : new Response(JSON.stringify({sha: commit ?? updatedCommit}), {
            headers: {'content-type': 'application/json'},
          });
    }
    if (parsedUrl.hostname === 'raw.githubusercontent.com') {
      const response = artifacts.get(parsedUrl.pathname);
      return response instanceof Response
        ? response
        : new Response(response ?? 'not found', {status: response === undefined ? 404 : 200});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return {calls, fetch: fetchImplementation};
}

function rawPath(repository, commit, artifact) {
  return `/${repository}/${commit}/${artifact}`;
}

test('reports status and syncs only from the pinned commit without touching identical files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    const installedContents = contentsById.get('example');
    const github = mockGithub({
      artifacts: new Map([
        [
          rawPath('example/example-extension', installedCommit, 'dist/example.js'),
          installedContents,
        ],
      ]),
    });

    const statuses = await extensionStatus(sourceDirectory, {fetch: github.fetch});
    assert.deepEqual(statuses, [
      {
        id: 'example',
        local: 'valid',
        ref: 'main',
        remoteCommit: updatedCommit,
        resolvedCommit: installedCommit,
        state: 'update-available',
      },
    ]);
    assert.equal(github.calls.length, 1);
    assert.match(github.calls[0].url, /^https:\/\/api\.github\.com\//u);

    await writeFile(
      path.join(sourceDirectory, 'extensions/example.js'),
      extensionContents('example', 'LocalEdit'),
    );
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const manifestBeforeSync = await readFile(manifestPath, 'utf8');
    const modifiedStatus = await extensionStatus(sourceDirectory, {fetch: github.fetch});
    assert.equal(modifiedStatus[0].local, 'modified');

    github.calls.length = 0;
    await assert.rejects(
      syncExtensions({
        fetch: github.fetch,
        sourceDirectory,
      }),
      /requires --yes/u,
    );
    const synchronized = await syncExtensions({
      fetch: github.fetch,
      sourceDirectory,
      yes: true,
    });
    assert.equal(synchronized.changed, true);
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/example.js')),
      installedContents,
    );
    assert.equal(await readFile(manifestPath, 'utf8'), manifestBeforeSync);
    assert.equal(github.calls.length, 2);
    assert.equal(
      new URL(github.calls[1].url).pathname,
      rawPath('example/example-extension', installedCommit, 'dist/example.js'),
    );

    const extensionPath = path.join(sourceDirectory, 'extensions/example.js');
    const before = await stat(extensionPath);
    const unchanged = await syncExtensions({
      fetch: github.fetch,
      sourceDirectory,
      yes: true,
    });
    const after = await stat(extensionPath);
    assert.equal(unchanged.changed, false);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});

test('reports and synchronizes an exact installed npm extension without network access', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    const installedContents = contentsById.get('example');
    await installNpmExtensionPackage(directory, installedContents);
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const manifest = await readJson(manifestPath);
    manifest.extensions[0].source = {
      artifact: 'dist/example.js',
      integrity: extensionIntegrity(installedContents),
      package: '@example/example-extension',
      provider: 'npm',
      version: '1.2.3',
    };
    await writeJson(manifestPath, manifest);
    const extensionPath = path.join(sourceDirectory, 'extensions/example.js');
    await writeFile(extensionPath, extensionContents('example', 'LocalEdit'));
    const rejectNetwork = () => {
      throw new Error('npm synchronization must not use fetch');
    };

    assert.deepEqual(await extensionStatus(sourceDirectory, {fetch: rejectNetwork}), [
      {
        id: 'example',
        installedVersion: '1.2.3',
        local: 'modified',
        package: '@example/example-extension',
        state: 'current',
        version: '1.2.3',
      },
    ]);
    const synchronized = await syncExtensions({
      fetch: rejectNetwork,
      sourceDirectory,
      yes: true,
    });
    assert.equal(synchronized.changed, true);
    assert.deepEqual(synchronized.extensions, [
      {
        id: 'example',
        package: '@example/example-extension',
        version: '1.2.3',
      },
    ]);
    assert.deepEqual(await readFile(extensionPath), installedContents);

    await writeJson(path.join(directory, 'node_modules/@example/example-extension/package.json'), {
      name: '@example/example-extension',
      version: '1.2.4',
    });
    await assert.rejects(
      syncExtensions({fetch: rejectNetwork, sourceDirectory, yes: true}),
      /version mismatch.*expected 1\.2\.3.*1\.2\.4/u,
    );
    assert.deepEqual(await readFile(extensionPath), installedContents);

    const updatedContents = extensionContents('example', 'V2');
    await writeFile(
      path.join(directory, 'node_modules/@example/example-extension/dist/example.js'),
      updatedContents,
    );
    const status = await extensionStatus(sourceDirectory, {fetch: rejectNetwork});
    assert.equal(status[0].state, 'update-available');
    assert.equal(status[0].installedVersion, '1.2.4');
    const updated = await updateExtensions({
      extensionId: 'example',
      fetch: rejectNetwork,
      sourceDirectory,
      yes: true,
    });
    assert.equal(updated.changed, true);
    assert.deepEqual(await readFile(extensionPath), updatedContents);
    const updatedManifest = await readJson(manifestPath);
    assert.equal(updatedManifest.extensions[0].source.version, '1.2.4');
    assert.equal(
      updatedManifest.extensions[0].source.integrity,
      extensionIntegrity(updatedContents),
    );
  });
});

test('rejects missing and integrity-mismatched npm extension artifacts', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    const installedContents = contentsById.get('example');
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const manifest = await readJson(manifestPath);
    manifest.extensions[0].source = {
      artifact: 'dist/example.js',
      integrity: extensionIntegrity(extensionContents('example', 'Different')),
      package: '@example/example-extension',
      provider: 'npm',
      version: '1.2.3',
    };
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      syncExtensions({sourceDirectory, yes: true}),
      /Installed npm package was not found/u,
    );
    await installNpmExtensionPackage(directory, installedContents);
    await assert.rejects(syncExtensions({sourceDirectory, yes: true}), /integrity mismatch/u);
  });
});

test('rejects failed, redirected, oversized, corrupted, and wrong-ID downloads', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    const extensionPath = path.join(sourceDirectory, 'extensions/example.js');
    const originalContents = contentsById.get('example');
    const artifactPath = rawPath('example/example-extension', installedCommit, 'dist/example.js');

    for (const [response, message, maximumArtifactBytes] of [
      [new Response('missing', {status: 404}), /HTTP 404/u, 1024],
      [
        new Response(null, {
          headers: {location: 'https://example.com/untrusted.js'},
          status: 302,
        }),
        /HTTP 302/u,
        1024,
      ],
      [new Response(Buffer.alloc(65), {headers: {'content-length': '65'}}), /64-byte limit/u, 64],
      [extensionContents('example', 'Corrupted'), /integrity mismatch/u, 1024],
    ]) {
      const github = mockGithub({artifacts: new Map([[artifactPath, response]])});
      await assert.rejects(
        syncExtensions({
          fetch: github.fetch,
          maximumArtifactBytes,
          sourceDirectory,
          yes: true,
        }),
        message,
      );
      assert.deepEqual(await readFile(extensionPath), originalContents);
    }

    const wrongId = extensionContents('another', 'V2');
    const github = mockGithub({
      artifacts: new Map([
        [rawPath('example/example-extension', updatedCommit, 'dist/example.js'), wrongId],
      ]),
    });
    await assert.rejects(
      updateExtensions({fetch: github.fetch, sourceDirectory, yes: true}),
      /header ID mismatch/u,
    );
    assert.deepEqual(await readFile(extensionPath), originalContents);
  });
});

test('updates multiple extensions and metadata as one transaction', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory, ['example', 'second']);
    const updatedExample = extensionContents('example', 'V2');
    const updatedSecond = extensionContents('second', 'V2');
    const examplePath = rawPath('example/example-extension', updatedCommit, 'dist/example.js');
    const secondPath = rawPath('example/second-extension', updatedCommit, 'dist/second.js');

    const failedGithub = mockGithub({
      artifacts: new Map([
        [examplePath, updatedExample],
        [secondPath, new Response('missing', {status: 404})],
      ]),
    });
    await assert.rejects(
      updateExtensions({fetch: failedGithub.fetch, sourceDirectory, yes: true}),
      /HTTP 404/u,
    );
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/example.js')),
      contentsById.get('example'),
    );
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/second.js')),
      contentsById.get('second'),
    );

    const github = mockGithub({
      artifacts: new Map([
        [examplePath, updatedExample],
        [secondPath, updatedSecond],
      ]),
    });
    const result = await updateExtensions({
      fetch: github.fetch,
      sourceDirectory,
      yes: true,
    });
    assert.equal(result.changed, true);
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/example.js')),
      updatedExample,
    );
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/second.js')),
      updatedSecond,
    );

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    for (const extension of manifest.extensions) {
      const contents = extension.id === 'example' ? updatedExample : updatedSecond;
      assert.equal(extension.source.resolvedCommit, updatedCommit);
      assert.equal(extension.source.integrity, extensionIntegrity(contents));
    }
  });
});

test('syncs and compatibly updates an opt-in extension API manifest', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    const installedExtension = contentsById.get('example');
    const installedApiManifest = await addApiManifest(sourceDirectory, 'example');
    const apiManifestPath = path.join(sourceDirectory, 'extensions/example.manifest.json');
    await writeFile(apiManifestPath, Buffer.from('{}\n'));

    const syncGithub = mockGithub({
      artifacts: new Map([
        [
          rawPath('example/example-extension', installedCommit, 'dist/example.js'),
          installedExtension,
        ],
        [
          rawPath('example/example-extension', installedCommit, 'dist/extension-manifest.json'),
          installedApiManifest,
        ],
      ]),
    });
    assert.equal(
      (await extensionStatus(sourceDirectory, {fetch: syncGithub.fetch}))[0].local,
      'modified',
    );
    const synchronized = await syncExtensions({
      fetch: syncGithub.fetch,
      sourceDirectory,
      yes: true,
    });
    assert.equal(synchronized.changed, true);
    assert.deepEqual(await readFile(apiManifestPath), installedApiManifest);
    assert.equal(
      (await extensionStatus(sourceDirectory, {fetch: syncGithub.fetch}))[0].local,
      'valid',
    );

    const updatedExtension = extensionContents('example', 'V2');
    const updatedApiManifest = apiManifestContents('example', {
      blocks: [
        ...apiManifest('example').blocks,
        {opcode: 'clear', blockType: 'COMMAND', arguments: []},
      ],
    });
    const updateGithub = mockGithub({
      artifacts: new Map([
        [rawPath('example/example-extension', updatedCommit, 'dist/example.js'), updatedExtension],
        [
          rawPath('example/example-extension', updatedCommit, 'dist/extension-manifest.json'),
          updatedApiManifest,
        ],
      ]),
    });
    const updated = await updateExtensions({
      fetch: updateGithub.fetch,
      sourceDirectory,
      yes: true,
    });
    assert.equal(updated.changed, true);
    assert.deepEqual(
      updated.apiCompatibility[0].changes.map(({breaking, kind, path: changePath}) => ({
        breaking,
        kind,
        path: changePath,
      })),
      [{breaking: false, kind: 'block-added', path: '/blocks/clear'}],
    );
    assert.deepEqual(await readFile(apiManifestPath), updatedApiManifest);
    const embeddedManifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    assert.equal(embeddedManifest.extensions[0].source.resolvedCommit, updatedCommit);
    assert.equal(
      embeddedManifest.extensions[0].source.apiManifest.integrity,
      extensionApiManifestIntegrity(updatedApiManifest),
    );
  });
});

test('rejects breaking API updates unless both explicit overrides are present', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    await addApiManifest(sourceDirectory, 'example');
    const originalExtension = contentsById.get('example');
    const originalManifest = await readFile(
      path.join(sourceDirectory, 'extensions/example.manifest.json'),
    );
    const updatedExtension = extensionContents('example', 'V2');
    const breakingManifest = apiManifestContents('example', {
      blocks: [
        {
          opcode: 'value',
          blockType: 'COMMAND',
          arguments: [{id: 'INPUT', type: 'STRING'}],
        },
      ],
    });
    const github = mockGithub({
      artifacts: new Map([
        [rawPath('example/example-extension', updatedCommit, 'dist/example.js'), updatedExtension],
        [
          rawPath('example/example-extension', updatedCommit, 'dist/extension-manifest.json'),
          breakingManifest,
        ],
      ]),
    });
    await assert.rejects(
      updateExtensions({fetch: github.fetch, sourceDirectory, yes: true}),
      /breaking.*block-type-changed.*\/blocks\/value\/blockType/su,
    );
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/example.js')),
      originalExtension,
    );
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/example.manifest.json')),
      originalManifest,
    );
    await assert.rejects(
      updateExtensions({
        allowBreakingApi: true,
        fetch: github.fetch,
        sourceDirectory,
      }),
      /requires --yes/u,
    );
    const updated = await updateExtensions({
      allowBreakingApi: true,
      fetch: github.fetch,
      sourceDirectory,
      yes: true,
    });
    assert.equal(updated.changed, true);
    assert.equal(updated.apiCompatibility[0].changes[0].breaking, true);
  });
});

test('rejects unsafe API manifest downloads without changing the source', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeManagedSource(sourceDirectory);
    const installedApiManifest = await addApiManifest(sourceDirectory, 'example');
    const installedExtension = await readFile(path.join(sourceDirectory, 'extensions/example.js'));
    const extensionPath = rawPath('example/example-extension', updatedCommit, 'dist/example.js');
    const manifestPath = rawPath(
      'example/example-extension',
      updatedCommit,
      'dist/extension-manifest.json',
    );
    for (const [response, message, maximumManifestBytes] of [
      [Buffer.from('{'), /not valid JSON/u, 1024],
      [apiManifestContents('example', {formatVersion: 2}), /Unsupported.*formatVersion/u, 1024],
      [apiManifestContents('another'), /ID mismatch/u, 1024],
      [new Response(Buffer.alloc(65), {headers: {'content-length': '65'}}), /64-byte limit/u, 64],
      [
        new Response(null, {headers: {location: 'https://example.com/'}, status: 302}),
        /HTTP 302/u,
        1024,
      ],
    ]) {
      const github = mockGithub({
        artifacts: new Map([
          [extensionPath, extensionContents('example', 'V2')],
          [manifestPath, response],
        ]),
      });
      await assert.rejects(
        updateExtensions({
          fetch: github.fetch,
          maximumManifestBytes,
          sourceDirectory,
          yes: true,
        }),
        message,
      );
      assert.deepEqual(
        await readFile(path.join(sourceDirectory, 'extensions/example.js')),
        installedExtension,
      );
      assert.deepEqual(
        await readFile(path.join(sourceDirectory, 'extensions/example.manifest.json')),
        installedApiManifest,
      );
    }

    const corruptedManifest = apiManifestContents('example', {
      blocks: [{opcode: 'changed', blockType: 'COMMAND', arguments: []}],
    });
    const syncGithub = mockGithub({
      artifacts: new Map([
        [
          rawPath('example/example-extension', installedCommit, 'dist/example.js'),
          installedExtension,
        ],
        [
          rawPath('example/example-extension', installedCommit, 'dist/extension-manifest.json'),
          corruptedManifest,
        ],
      ]),
    });
    await assert.rejects(
      syncExtensions({fetch: syncGithub.fetch, sourceDirectory, yes: true}),
      /API manifest integrity mismatch/u,
    );
  });
});

test('normalizes the manifest ID during a managed extension ID migration', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeManagedSource(sourceDirectory, ['oldext']);
    await addApiManifest(
      sourceDirectory,
      'oldext',
      apiManifestContents('oldext'),
      'dist/oldext.manifest.json',
    );
    const updatedExtension = extensionContents('newext', 'V2');
    const updatedApiManifest = apiManifestContents('newext');
    const github = mockGithub({
      artifacts: new Map([
        [rawPath('example/oldext-extension', updatedCommit, 'dist/newext.js'), updatedExtension],
        [
          rawPath('example/oldext-extension', updatedCommit, 'dist/newext.manifest.json'),
          updatedApiManifest,
        ],
      ]),
    });
    const result = await updateExtensions({
      apiManifestArtifact: 'dist/newext.manifest.json',
      extensionId: 'oldext',
      fetch: github.fetch,
      migrateToId: 'newext',
      sourceArtifact: 'dist/newext.js',
      sourceDirectory,
      yes: true,
    });
    assert.deepEqual(result.apiCompatibility[0].changes, []);
    assert.equal(result.migration.counts.apiManifestArtifacts, 1);
    await assert.rejects(
      readFile(path.join(sourceDirectory, 'extensions/oldext.manifest.json')),
      (error) => error?.code === 'ENOENT',
    );
    assert.deepEqual(
      await readFile(path.join(sourceDirectory, 'extensions/newext.manifest.json')),
      updatedApiManifest,
    );
    const embeddedManifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    assert.equal(embeddedManifest.extensions[0].id, 'newext');
    assert.equal(
      embeddedManifest.extensions[0].source.apiManifest.path,
      'extensions/newext.manifest.json',
    );
    assert.equal(
      embeddedManifest.extensions[0].source.apiManifest.artifact,
      'dist/newext.manifest.json',
    );
  });
});
