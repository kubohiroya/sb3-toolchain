// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments, runCli} from '../src/cli';
import {
  extensionSourceTypes,
  formatExtensionDigestInventory,
  inspectSb3ExtensionDigests,
  inventoryExtensionDigests,
  readProjectManifest,
} from '../src/index';

const sharedCode = "// ID: shared\nthrow new Error('never execute shared');\n";
const soloCode = "// ID: solo\nthrow new Error('never execute solo');\n";
const remoteCode = "// ID: remote\nthrow new Error('never execute remote');\n";

function digest(source: string): string {
  return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
}

function dataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

function manifest(uri: string | undefined, extensions: any[]): any {
  return {schemaVersion: 1, ...(uri === undefined ? {} : {uri}), extensions};
}

function archive(project: any, files: Record<string, string> = {}): Uint8Array {
  return zipSync({
    'project.json': strToU8(JSON.stringify(project)),
    'costume.svg': strToU8('<svg>unrelated asset</svg>'),
    ...Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [name, strToU8(contents)]),
    ),
  });
}

/** One project keeping an extension in each of the four forms the manifest can name. */
function allFormsProject(): any {
  return {
    targets: [],
    extensions: ['sharedFile', 'soloData', 'remoteCached', 'remoteOnly'],
    extensionURLs: {soloData: dataUrl(soloCode)},
    turboWarpPlus: manifest('https://example.com/turbowarp-plus-projects/ab/cd/one', [
      {
        id: 'sharedFile',
        source: {
          type: 'embedded-file',
          path: 'extensions/shared.js',
          url: 'https://cdn.example.com/shared.js',
        },
        execution: 'unsandboxed',
        sha256: digest(sharedCode),
      },
      {
        id: 'soloData',
        source: {type: 'embedded-data'},
        execution: 'sandboxed',
        sha256: digest(soloCode),
      },
      {
        id: 'remoteCached',
        source: {type: 'remote-cacheable', url: 'https://cdn.example.com/remote.js'},
        execution: 'sandboxed',
        sha256: digest(remoteCode),
      },
      {
        id: 'remoteOnly',
        source: {type: 'remote-non-cacheable', url: 'https://cdn.example.com/private.js'},
        execution: 'sandboxed',
        sha256: digest('// private\n'),
      },
    ]),
  };
}

/** A second project naming the same shared bytes, but keeping them as a non-cacheable reference. */
function convertedProject(): any {
  return {
    targets: [],
    extensions: ['sharedFile', 'remoteCached'],
    extensionURLs: {},
    turboWarpPlus: manifest('https://example.com/turbowarp-plus-projects/ef/01/two', [
      {
        id: 'sharedFile',
        source: {type: 'embedded-file', path: 'extensions/shared.js'},
        execution: 'unsandboxed',
        sha256: digest(sharedCode),
      },
      {
        id: 'remoteCached',
        source: {type: 'remote-non-cacheable', url: 'https://cdn.example.com/remote.js'},
        execution: 'sandboxed',
        sha256: digest(remoteCode),
      },
    ]),
  };
}

async function withFixture(
  callback: (directory: string) => Promise<void>,
  files: Record<string, Uint8Array> = {},
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-digests-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(path.join(directory, name), contents);
    }
    await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('inspects every source form, its held size, and the project URI', () => {
  const result = inspectSb3ExtensionDigests(
    '/tmp/one.sb3',
    archive(allFormsProject(), {'extensions/shared.js': sharedCode}),
  );
  expect(result.manifestPresent).toBe(true);
  expect(result.uri).toBe('https://example.com/turbowarp-plus-projects/ab/cd/one');
  expect(result.extensions.map((extension) => extension.sourceType)).toEqual([
    'embedded-file',
    'embedded-data',
    'remote-cacheable',
    'remote-non-cacheable',
  ]);
  expect(result.extensions[0]).toEqual({
    id: 'sharedFile',
    sha256: digest(sharedCode),
    sourceType: 'embedded-file',
    size: Buffer.byteLength(sharedCode),
    heldSha256: digest(sharedCode),
    url: 'https://cdn.example.com/shared.js',
    path: 'extensions/shared.js',
    execution: 'unsandboxed',
    cacheable: false,
  });
  expect(result.extensions[1]).toMatchObject({
    sourceType: 'embedded-data',
    size: Buffer.byteLength(soloCode),
    heldSha256: digest(soloCode),
    path: null,
    url: null,
  });
  // A reference form holds no bytes, so there is no size and no digest to recompute. The pinned
  // digest is still reported, and the URL is never contacted to find out.
  expect(result.extensions[2]).toMatchObject({
    sourceType: 'remote-cacheable',
    size: null,
    heldSha256: null,
    cacheable: true,
    url: 'https://cdn.example.com/remote.js',
  });
  expect(result.extensions[3]).toMatchObject({size: null, heldSha256: null, cacheable: false});
  expect(extensionSourceTypes).toContain('remote-non-cacheable');
});

test('reports a project without a manifest as absent rather than empty', () => {
  const result = inspectSb3ExtensionDigests(
    '/tmp/plain.sb3',
    archive({targets: [], extensions: [], extensionURLs: {other: dataUrl(soloCode)}}),
  );
  expect(result).toEqual({
    inputPath: '/tmp/plain.sb3',
    uri: null,
    manifestPresent: false,
    extensions: [],
  });
});

test('reports which digests several projects share and which belong to one', async () => {
  await withFixture(
    async (directory) => {
      const inventory = await inventoryExtensionDigests([
        path.join(directory, 'one.sb3'),
        path.join(directory, 'two.sb3'),
      ]);
      expect(inventory.projects).toHaveLength(2);
      expect(inventory.projects.map((project) => project.uri)).toEqual([
        'https://example.com/turbowarp-plus-projects/ab/cd/one',
        'https://example.com/turbowarp-plus-projects/ef/01/two',
      ]);

      const byDigest = new Map(inventory.digests.map((usage) => [usage.sha256, usage]));
      const shared = byDigest.get(digest(sharedCode));
      expect(shared).toMatchObject({
        shared: true,
        ids: ['sharedFile'],
        sourceTypes: ['embedded-file'],
        cacheable: false,
        size: Buffer.byteLength(sharedCode),
      });
      expect(shared?.projects.map((project) => project.inputPath)).toEqual([
        path.join(directory, 'one.sb3'),
        path.join(directory, 'two.sb3'),
      ]);

      const solo = byDigest.get(digest(soloCode));
      expect(solo).toMatchObject({shared: false, ids: ['soloData'], cacheable: false});
      expect(solo?.projects).toHaveLength(1);

      // Only one of the two projects still keeps these bytes cacheable, so a cache entry for
      // them is still named. Once that project is converted too, cacheable turns false and the
      // retained copy is the stale one to remove.
      const remote = byDigest.get(digest(remoteCode));
      expect(remote).toMatchObject({
        shared: true,
        cacheable: true,
        sourceTypes: ['remote-cacheable', 'remote-non-cacheable'],
        size: null,
      });

      expect(inventory.digests.map((usage) => usage.sha256)).toEqual(
        [...inventory.digests.map((usage) => usage.sha256)].sort(),
      );
    },
    {
      'one.sb3': archive(allFormsProject(), {'extensions/shared.js': sharedCode}),
      'two.sb3': archive(convertedProject(), {'extensions/shared.js': sharedCode}),
    },
  );
});

test('reports a digest that does not match the bytes the archive holds', () => {
  const project = allFormsProject();
  const result = inspectSb3ExtensionDigests(
    '/tmp/mismatch.sb3',
    archive(project, {'extensions/shared.js': '// tampered\n'}),
  );
  expect(result.extensions[0]).toMatchObject({
    sha256: digest(sharedCode),
    heldSha256: digest('// tampered\n'),
    size: Buffer.byteLength('// tampered\n'),
  });
  const lines = formatExtensionDigestInventory({projects: [result], digests: []});
  expect(lines.join('\n')).toContain(`held-sha256=${digest('// tampered\n')}`);
});

test('refuses a manifest whose embedded source names a missing archive entry', () => {
  expect(() => inspectSb3ExtensionDigests('/tmp/broken.sb3', archive(allFormsProject()))).toThrow(
    /names a missing archive entry: extensions\/shared\.js/u,
  );
});

test('refuses the retired source spellings by naming what replaces them', () => {
  for (const [type, expected] of [
    ['remote', /remote-cacheable or remote-non-cacheable/u],
    ['cached', /embedded-file with a url/u],
    ['embedded', /embedded-file or embedded-data/u],
  ] as const) {
    expect(() =>
      readProjectManifest({
        turboWarpPlus: manifest(undefined, [
          {
            id: 'legacy',
            source: {type, url: 'https://cdn.example.com/legacy.js'},
            execution: 'sandboxed',
            sha256: digest(soloCode),
          },
        ]),
      }),
    ).toThrow(expected);
  }
});

test('refuses manifest values that would make the inventory meaningless', () => {
  expect(() => readProjectManifest({turboWarpPlus: {schemaVersion: 2, extensions: []}})).toThrow(
    /schemaVersion 1/u,
  );
  expect(() =>
    readProjectManifest({
      turboWarpPlus: manifest('http://example.com/insecure', []),
    }),
  ).toThrow(/absolute HTTPS URL|HTTPS without credentials/u);
  expect(() =>
    readProjectManifest({
      turboWarpPlus: manifest(undefined, [
        {
          id: 'badDigest',
          source: {type: 'embedded-data'},
          execution: 'sandboxed',
          sha256: 'NOT-A-DIGEST',
        },
      ]),
    }),
  ).toThrow(/lowercase SHA-256 pin/u);
  expect(() =>
    readProjectManifest({
      turboWarpPlus: manifest(undefined, [
        {
          id: 'escape',
          source: {type: 'embedded-file', path: '../outside.js'},
          execution: 'sandboxed',
          sha256: digest(soloCode),
        },
      ]),
    }),
  ).toThrow(/unsafe embedded path/u);
  expect(readProjectManifest({targets: []})).toBeNull();
});

test('refuses duplicate inputs and non-regular SB3 paths', async () => {
  await withFixture(
    async (directory) => {
      const inputPath = path.join(directory, 'one.sb3');
      await expect(inventoryExtensionDigests([inputPath, inputPath])).rejects.toThrow(
        /Duplicate SB3 input/u,
      );
      await expect(inventoryExtensionDigests([])).rejects.toThrow(/At least one INPUT\.sb3/u);
      await expect(inventoryExtensionDigests([path.join(directory, 'notes.txt')])).rejects.toThrow(
        /Expected an \.sb3 file/u,
      );
      const linkPath = path.join(directory, 'link.sb3');
      await symlink(inputPath, linkPath);
      await expect(inventoryExtensionDigests([linkPath])).rejects.toThrow(
        /Expected a regular SB3 file/u,
      );
    },
    {
      'one.sb3': archive(allFormsProject(), {'extensions/shared.js': sharedCode}),
      'notes.txt': strToU8('not an archive'),
    },
  );
});

test('parses the CLI invocation and prints both report shapes', async () => {
  expect(parseCliArguments(['extensions', 'digests', 'a.sb3', 'b.sb3', '--json'])).toEqual({
    action: 'digests',
    command: 'extensions',
    inputPaths: [path.resolve('a.sb3'), path.resolve('b.sb3')],
    json: true,
  });
  expect(() => parseCliArguments(['extensions', 'digests'])).toThrow(/at least one INPUT\.sb3/u);
  expect(() => parseCliArguments(['extensions', 'digests', 'a.sb3', '--nope'])).toThrow(
    /Unknown option: --nope/u,
  );

  await withFixture(
    async (directory) => {
      const lines: string[] = [];
      await runCli(
        ['extensions', 'digests', path.join(directory, 'one.sb3'), path.join(directory, 'two.sb3')],
        {log: (message) => lines.push(message)},
      );
      const text = lines.join('\n');
      expect(text).toContain('2 SB3 inputs');
      expect(text).toContain('uri=https://example.com/turbowarp-plus-projects/ab/cd/one');
      expect(text).toContain('source=embedded-data');
      expect(text).toContain('size=not-held');
      expect(text).toContain(`Shared: ${digest(sharedCode)}`);
      expect(text).toContain(`Single: ${digest(soloCode)}`);
      expect(text).toContain('IndexedDB belongs to an origin and a browser profile');

      const jsonLines: string[] = [];
      await runCli(['extensions', 'digests', path.join(directory, 'two.sb3'), '--json'], {
        log: (message) => jsonLines.push(message),
      });
      const inventory = JSON.parse(jsonLines.join('\n'));
      expect(inventory.projects[0].extensions).toHaveLength(2);
      expect(inventory.digests.every((usage: any) => usage.shared === false)).toBe(true);
    },
    {
      'one.sb3': archive(allFormsProject(), {'extensions/shared.js': sharedCode}),
      'two.sb3': archive(convertedProject(), {'extensions/shared.js': sharedCode}),
    },
  );
});

test('lists the new action in the usage text', () => {
  expect(parseCliArguments(['extensions', 'digests', '--help'])).toEqual({command: 'help'});
  expect(() => parseCliArguments(['extensions', 'inventory', 'a.sb3'])).toThrow(
    /requires status, digests, sync/u,
  );
});
