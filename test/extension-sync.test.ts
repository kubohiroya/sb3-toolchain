// SPDX-License-Identifier: MPL-2.0

import {cp, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test} from 'vitest';

import {
  extensionApiManifestIntegrity,
  extensionIntegrity,
  extensionStatus,
  syncExtensions,
  updateExtensions,
} from '../src/index';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');
const installedCommit = '1'.repeat(40);
const updatedCommit = '2'.repeat(40);

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-extension-sync-test-'));
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

function extensionContents(id: string, version: number | string): Buffer {
  return Buffer.from(
    `// Name: ${id}\n// ID: ${id}\n` + `Scratch.extensions.register(new Extension${version}());\n`,
  );
}

function sourceMetadata(
  id: string,
  contents: Uint8Array,
  repository = `example/${id}-extension`,
): any {
  return {
    provider: 'github',
    repository,
    ref: 'main',
    resolvedCommit: installedCommit,
    artifact: `dist/${id}.js`,
    integrity: extensionIntegrity(contents),
  };
}

function apiManifest(id: string, overrides: Record<string, unknown> = {}): any {
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

function apiManifestContents(id: string, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(`${JSON.stringify(apiManifest(id, overrides), null, 2)}\n`);
}

async function addApiManifest(
  sourceDirectory: string,
  id: string,
  contents: Buffer = apiManifestContents(id),
  artifact = 'dist/extension-manifest.json',
): Promise<Buffer> {
  const embeddedManifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
  const embeddedManifest = await readJson(embeddedManifestPath);
  const extension = embeddedManifest.extensions.find((entry: any) => entry.id === id);
  expect(extension).toBeTruthy();
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

async function writeManagedSource(sourceDirectory: string, extensionIds: string[] = ['example']) {
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

async function installNpmExtensionPackage(
  directory: string,
  contents: Uint8Array,
  {version = '1.2.3'}: {version?: string} = {},
): Promise<string> {
  const packageDirectory = path.join(directory, 'node_modules', '@example', 'example-extension');
  await mkdir(path.join(packageDirectory, 'dist'), {recursive: true});
  await writeFile(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify({name: '@example/example-extension', version}, null, 2)}\n`,
  );
  await writeFile(path.join(packageDirectory, 'dist/example.js'), contents);
  return packageDirectory;
}

function mockGithub({
  artifacts = new Map<string, unknown>(),
  commits = new Map<string, unknown>(),
}: {
  artifacts?: Map<string, unknown>;
  commits?: Map<string, unknown>;
}) {
  const calls: {options: RequestInit | undefined; url: string}[] = [];
  const fetchImplementation = async (url: any, options?: any): Promise<Response> => {
    calls.push({options, url: String(url)});
    expect(options.redirect).toBe('error');
    const parsedUrl = new URL(String(url));
    if (parsedUrl.hostname === 'api.github.com') {
      const repository = parsedUrl.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/commits\//u)?.[1];
      const commit = commits.get(repository ?? '');
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
        : new Response((response as any) ?? 'not found', {
            status: response === undefined ? 404 : 200,
          });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return {calls, fetch: fetchImplementation};
}

function rawPath(repository: string, commit: string, artifact: string): string {
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
    expect(statuses).toStrictEqual([
      {
        id: 'example',
        local: 'valid',
        ref: 'main',
        remoteCommit: updatedCommit,
        resolvedCommit: installedCommit,
        state: 'update-available',
      },
    ]);
    expect(github.calls.length).toBe(1);
    expect(github.calls[0].url).toMatch(/^https:\/\/api\.github\.com\//u);

    await writeFile(
      path.join(sourceDirectory, 'extensions/example.js'),
      extensionContents('example', 'LocalEdit'),
    );
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const manifestBeforeSync = await readFile(manifestPath, 'utf8');
    const modifiedStatus = await extensionStatus(sourceDirectory, {fetch: github.fetch});
    expect(modifiedStatus[0].local).toBe('modified');

    github.calls.length = 0;
    await expect(
      syncExtensions({
        fetch: github.fetch,
        sourceDirectory,
      }),
    ).rejects.toThrow(/requires --yes/u);
    const synchronized = await syncExtensions({
      fetch: github.fetch,
      sourceDirectory,
      yes: true,
    });
    expect(synchronized.changed).toBe(true);
    expect(await readFile(path.join(sourceDirectory, 'extensions/example.js'))).toStrictEqual(
      installedContents,
    );
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBeforeSync);
    expect(github.calls.length).toBe(2);
    expect(new URL(github.calls[1].url).pathname).toBe(
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
    expect(unchanged.changed).toBe(false);
    expect(after.mtimeMs).toBe(before.mtimeMs);
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

    expect(await extensionStatus(sourceDirectory, {fetch: rejectNetwork})).toStrictEqual([
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
    expect(synchronized.changed).toBe(true);
    expect(synchronized.extensions).toStrictEqual([
      {
        id: 'example',
        package: '@example/example-extension',
        version: '1.2.3',
      },
    ]);
    expect(await readFile(extensionPath)).toStrictEqual(installedContents);

    await writeJson(path.join(directory, 'node_modules/@example/example-extension/package.json'), {
      name: '@example/example-extension',
      version: '1.2.4',
    });
    await expect(
      syncExtensions({fetch: rejectNetwork, sourceDirectory, yes: true}),
    ).rejects.toThrow(/version mismatch.*expected 1\.2\.3.*1\.2\.4/u);
    expect(await readFile(extensionPath)).toStrictEqual(installedContents);

    const updatedContents = extensionContents('example', 'V2');
    await writeFile(
      path.join(directory, 'node_modules/@example/example-extension/dist/example.js'),
      updatedContents,
    );
    const status = await extensionStatus(sourceDirectory, {fetch: rejectNetwork});
    expect(status[0].state).toBe('update-available');
    expect(status[0].installedVersion).toBe('1.2.4');
    const updated = await updateExtensions({
      extensionId: 'example',
      fetch: rejectNetwork,
      sourceDirectory,
      yes: true,
    });
    expect(updated.changed).toBe(true);
    expect(await readFile(extensionPath)).toStrictEqual(updatedContents);
    const updatedManifest = await readJson(manifestPath);
    expect(updatedManifest.extensions[0].source.version).toBe('1.2.4');
    expect(updatedManifest.extensions[0].source.integrity).toBe(
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

    await expect(syncExtensions({sourceDirectory, yes: true})).rejects.toThrow(
      /Installed npm package was not found/u,
    );
    await installNpmExtensionPackage(directory, installedContents);
    await expect(syncExtensions({sourceDirectory, yes: true})).rejects.toThrow(
      /integrity mismatch/u,
    );
  });
});

test('rejects failed, redirected, oversized, corrupted, and wrong-ID downloads', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    const contentsById = await writeManagedSource(sourceDirectory);
    const extensionPath = path.join(sourceDirectory, 'extensions/example.js');
    const originalContents = contentsById.get('example');
    const artifactPath = rawPath('example/example-extension', installedCommit, 'dist/example.js');

    const artifactCases: [unknown, RegExp, number][] = [
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
    ];
    for (const [response, message, maximumArtifactBytes] of artifactCases) {
      const github = mockGithub({artifacts: new Map([[artifactPath, response]])});
      await expect(
        syncExtensions({
          fetch: github.fetch,
          maximumArtifactBytes,
          sourceDirectory,
          yes: true,
        }),
      ).rejects.toThrow(message);
      expect(await readFile(extensionPath)).toStrictEqual(originalContents);
    }

    const wrongId = extensionContents('another', 'V2');
    const github = mockGithub({
      artifacts: new Map([
        [rawPath('example/example-extension', updatedCommit, 'dist/example.js'), wrongId],
      ]),
    });
    await expect(
      updateExtensions({fetch: github.fetch, sourceDirectory, yes: true}),
    ).rejects.toThrow(/header ID mismatch/u);
    expect(await readFile(extensionPath)).toStrictEqual(originalContents);
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
      artifacts: new Map<string, unknown>([
        [examplePath, updatedExample],
        [secondPath, new Response('missing', {status: 404})],
      ]),
    });
    await expect(
      updateExtensions({fetch: failedGithub.fetch, sourceDirectory, yes: true}),
    ).rejects.toThrow(/HTTP 404/u);
    expect(await readFile(path.join(sourceDirectory, 'extensions/example.js'))).toStrictEqual(
      contentsById.get('example'),
    );
    expect(await readFile(path.join(sourceDirectory, 'extensions/second.js'))).toStrictEqual(
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
    expect(result.changed).toBe(true);
    expect(await readFile(path.join(sourceDirectory, 'extensions/example.js'))).toStrictEqual(
      updatedExample,
    );
    expect(await readFile(path.join(sourceDirectory, 'extensions/second.js'))).toStrictEqual(
      updatedSecond,
    );

    const manifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    for (const extension of manifest.extensions) {
      const contents = extension.id === 'example' ? updatedExample : updatedSecond;
      expect(extension.source.resolvedCommit).toBe(updatedCommit);
      expect(extension.source.integrity).toBe(extensionIntegrity(contents));
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
    expect((await extensionStatus(sourceDirectory, {fetch: syncGithub.fetch}))[0].local).toBe(
      'modified',
    );
    const synchronized = await syncExtensions({
      fetch: syncGithub.fetch,
      sourceDirectory,
      yes: true,
    });
    expect(synchronized.changed).toBe(true);
    expect(await readFile(apiManifestPath)).toStrictEqual(installedApiManifest);
    expect((await extensionStatus(sourceDirectory, {fetch: syncGithub.fetch}))[0].local).toBe(
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
    expect(updated.changed).toBe(true);
    expect(
      updated.apiCompatibility[0].changes.map(({breaking, kind, path: changePath}) => ({
        breaking,
        kind,
        path: changePath,
      })),
    ).toStrictEqual([{breaking: false, kind: 'block-added', path: '/blocks/clear'}]);
    expect(await readFile(apiManifestPath)).toStrictEqual(updatedApiManifest);
    const embeddedManifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    expect(embeddedManifest.extensions[0].source.resolvedCommit).toBe(updatedCommit);
    expect(embeddedManifest.extensions[0].source.apiManifest.integrity).toBe(
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
    await expect(
      updateExtensions({fetch: github.fetch, sourceDirectory, yes: true}),
    ).rejects.toThrow(/breaking.*block-type-changed.*\/blocks\/value\/blockType/su);
    expect(await readFile(path.join(sourceDirectory, 'extensions/example.js'))).toStrictEqual(
      originalExtension,
    );
    expect(
      await readFile(path.join(sourceDirectory, 'extensions/example.manifest.json')),
    ).toStrictEqual(originalManifest);
    await expect(
      updateExtensions({
        allowBreakingApi: true,
        fetch: github.fetch,
        sourceDirectory,
      }),
    ).rejects.toThrow(/requires --yes/u);
    const updated = await updateExtensions({
      allowBreakingApi: true,
      fetch: github.fetch,
      sourceDirectory,
      yes: true,
    });
    expect(updated.changed).toBe(true);
    expect(updated.apiCompatibility[0].changes[0].breaking).toBe(true);
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
    const manifestCases: [unknown, RegExp, number][] = [
      [Buffer.from('{'), /not valid JSON/u, 1024],
      [apiManifestContents('example', {formatVersion: 2}), /Unsupported.*formatVersion/u, 1024],
      [apiManifestContents('another'), /ID mismatch/u, 1024],
      [new Response(Buffer.alloc(65), {headers: {'content-length': '65'}}), /64-byte limit/u, 64],
      [
        new Response(null, {headers: {location: 'https://example.com/'}, status: 302}),
        /HTTP 302/u,
        1024,
      ],
    ];
    for (const [response, message, maximumManifestBytes] of manifestCases) {
      const github = mockGithub({
        artifacts: new Map<string, unknown>([
          [extensionPath, extensionContents('example', 'V2')],
          [manifestPath, response],
        ]),
      });
      await expect(
        updateExtensions({
          fetch: github.fetch,
          maximumManifestBytes,
          sourceDirectory,
          yes: true,
        }),
      ).rejects.toThrow(message);
      expect(await readFile(path.join(sourceDirectory, 'extensions/example.js'))).toStrictEqual(
        installedExtension,
      );
      expect(
        await readFile(path.join(sourceDirectory, 'extensions/example.manifest.json')),
      ).toStrictEqual(installedApiManifest);
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
    await expect(
      syncExtensions({fetch: syncGithub.fetch, sourceDirectory, yes: true}),
    ).rejects.toThrow(/API manifest integrity mismatch/u);
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
    expect(result.apiCompatibility[0].changes).toStrictEqual([]);
    expect(result.migration?.counts.apiManifestArtifacts).toBe(1);
    await expect(
      readFile(path.join(sourceDirectory, 'extensions/oldext.manifest.json')),
    ).rejects.toSatisfy((error: any) => error?.code === 'ENOENT');
    expect(
      await readFile(path.join(sourceDirectory, 'extensions/newext.manifest.json')),
    ).toStrictEqual(updatedApiManifest);
    const embeddedManifest = await readJson(path.join(sourceDirectory, 'embedded-extensions.json'));
    expect(embeddedManifest.extensions[0].id).toBe('newext');
    expect(embeddedManifest.extensions[0].source.apiManifest.path).toBe(
      'extensions/newext.manifest.json',
    );
    expect(embeddedManifest.extensions[0].source.apiManifest.artifact).toBe(
      'dist/newext.manifest.json',
    );
  });
});
