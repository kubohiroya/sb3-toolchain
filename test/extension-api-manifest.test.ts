// SPDX-License-Identifier: MPL-2.0

import {expect, test} from 'vitest';

import {
  compareExtensionApiManifests,
  extensionApiManifestIntegrity,
  parseExtensionApiManifest,
  validateExtensionApiManifestSourceMetadata,
  validateManagedExtensionApiManifest,
} from '../src/index';
import type {
  EmbeddedExtension,
  ExtensionApiManifestSource,
  GitHubExtensionSource,
} from '../src/index';

type ManagedExtension = EmbeddedExtension & {
  source: GitHubExtensionSource & {apiManifest: ExtensionApiManifestSource};
};

function manifest(overrides: Record<string, unknown> = {}): any {
  return {
    formatVersion: 1,
    id: 'example',
    blocks: [
      {
        opcode: 'speak',
        blockType: 'REPORTER',
        arguments: [
          {id: 'VOICE', type: 'STRING', menu: 'voices'},
          {id: 'MESSAGE', type: 'STRING'},
        ],
      },
    ],
    menus: [{id: 'voices', acceptReporters: true}],
    ...overrides,
  };
}

function contents(value: unknown = manifest()): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function managedExtension(apiContents: Buffer = contents()): ManagedExtension {
  return {
    id: 'example',
    path: 'extensions/example.js',
    mediaType: 'text/javascript',
    parameters: [],
    encoding: 'base64',
    source: {
      provider: 'github',
      repository: 'example/example-extension',
      ref: 'main',
      resolvedCommit: '1'.repeat(40),
      artifact: 'dist/example.js',
      integrity: `sha256-${'A'.repeat(43)}=`,
      apiManifest: {
        artifact: 'dist/extension-manifest.json',
        formatVersion: 1,
        integrity: extensionApiManifestIntegrity(apiContents),
        path: 'extensions/example.manifest.json',
      },
    },
  };
}

test('validates and canonicalizes extension API manifest v1', () => {
  const apiContents = contents();
  expect(parseExtensionApiManifest(apiContents, {expectedId: 'example'})).toStrictEqual({
    blocks: [
      {
        arguments: [
          {id: 'MESSAGE', type: 'STRING'},
          {id: 'VOICE', menu: 'voices', type: 'STRING'},
        ],
        blockType: 'REPORTER',
        opcode: 'speak',
      },
    ],
    formatVersion: 1,
    id: 'example',
    menus: [{acceptReporters: true, id: 'voices'}],
  });
  const extension = managedExtension(apiContents);
  expect(validateExtensionApiManifestSourceMetadata(extension)).toBe(extension.source?.apiManifest);
  expect(validateManagedExtensionApiManifest(extension, apiContents)?.integrity).toBe(
    extension.source?.apiManifest?.integrity,
  );
});

test('rejects malformed, ambiguous, and mismatched extension API manifests', () => {
  const invalidManifests: [unknown, RegExp][] = [
    [{...manifest(), extra: true}, /unsupported properties/u],
    [{...manifest(), formatVersion: 2}, /Unsupported.*formatVersion/u],
    [{...manifest(), id: 'Wrong-ID'}, /Invalid.*ID/u],
    [
      {...manifest(), blocks: [...manifest().blocks, manifest().blocks[0]]},
      /duplicate block opcode/u,
    ],
    [
      {
        ...manifest(),
        blocks: [
          {
            opcode: 'speak',
            blockType: 'REPORTER',
            arguments: [
              {id: 'MESSAGE', type: 'STRING'},
              {id: 'MESSAGE', type: 'NUMBER'},
            ],
          },
        ],
      },
      /duplicate argument ID/u,
    ],
    [
      {
        ...manifest(),
        blocks: [
          {
            opcode: 'speak',
            blockType: 'REPORTER',
            arguments: [{id: 'VOICE', type: 'STRING', menu: 'missing'}],
          },
        ],
      },
      /unknown menu/u,
    ],
  ];
  for (const [value, message] of invalidManifests) {
    expect(() => parseExtensionApiManifest(contents(value))).toThrow(message);
  }
  expect(() => parseExtensionApiManifest(contents(), {expectedId: 'another'})).toThrow(
    /ID mismatch/u,
  );

  const extension = managedExtension();
  expect(extension.source.apiManifest.path).toBe('extensions/example.manifest.json');
  extension.source.apiManifest.path = 'extensions/other.manifest.json';
  expect(() => validateExtensionApiManifestSourceMetadata(extension)).toThrow(/path must match/u);
});

test('classifies compatible additions and breaking API changes with stable paths', () => {
  const installed = parseExtensionApiManifest(contents());
  const candidate = parseExtensionApiManifest(
    contents(
      manifest({
        blocks: [
          {
            opcode: 'speak',
            blockType: 'COMMAND',
            arguments: [
              {id: 'MESSAGE', type: 'STRING'},
              {id: 'VOICE', type: 'STRING', menu: 'voices'},
              {id: 'RATE', type: 'NUMBER'},
            ],
          },
          {opcode: 'clear', blockType: 'COMMAND', arguments: []},
        ],
        menus: [{id: 'voices', acceptReporters: false}],
      }),
    ),
  );
  const changes = compareExtensionApiManifests(installed, candidate);
  expect(changes.map(({breaking, kind, path}) => ({breaking, kind, path}))).toStrictEqual([
    {
      breaking: false,
      kind: 'block-added',
      path: '/blocks/clear',
    },
    {
      breaking: true,
      kind: 'argument-added',
      path: '/blocks/speak/arguments/RATE',
    },
    {
      breaking: true,
      kind: 'block-type-changed',
      path: '/blocks/speak/blockType',
    },
    {
      breaking: true,
      kind: 'menu-accept-reporters-changed',
      path: '/menus/voices/acceptReporters',
    },
  ]);
});

test('classifies removal of an unreferenced menu as compatible', () => {
  const installed = parseExtensionApiManifest(
    contents(
      manifest({
        menus: [
          {id: 'unused', acceptReporters: false},
          {id: 'voices', acceptReporters: true},
        ],
      }),
    ),
  );
  const candidate = parseExtensionApiManifest(contents());
  expect(
    compareExtensionApiManifests(installed, candidate).map(({breaking, kind, path}) => ({
      breaking,
      kind,
      path,
    })),
  ).toStrictEqual([{breaking: false, kind: 'menu-removed', path: '/menus/unused'}]);
});

test('classifies removal of a referenced menu as breaking', () => {
  const installed = parseExtensionApiManifest(contents());
  const candidate = parseExtensionApiManifest(
    contents(
      manifest({
        blocks: [
          {
            opcode: 'speak',
            blockType: 'REPORTER',
            arguments: [
              {id: 'VOICE', type: 'STRING'},
              {id: 'MESSAGE', type: 'STRING'},
            ],
          },
        ],
        menus: [],
      }),
    ),
  );
  expect(
    compareExtensionApiManifests(installed, candidate).find(
      (change) => change.kind === 'menu-removed',
    )?.breaking,
  ).toBe(true);
});
