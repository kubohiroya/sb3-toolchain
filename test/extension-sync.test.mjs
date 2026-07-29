// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
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
