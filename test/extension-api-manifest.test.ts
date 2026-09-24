// SPDX-License-Identifier: MPL-2.0

import {expect, test} from 'vitest';

import {
  compareExtensionApiManifests,
  extensionApiManifestIntegrity,
  parseExtensionApiManifest,
  tryParseExtensionApiManifest,
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
    [{...manifest(), formatVersion: 3}, /Unsupported.*formatVersion/u],
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

test('reports a parse failure as a value instead of throwing', () => {
  const invalid = tryParseExtensionApiManifest(contents(manifest({formatVersion: 3})));
  expect(invalid.manifest).toBe(null);
  expect(invalid.error).toBe('Unsupported extension API manifest formatVersion: 3');

  const mismatched = tryParseExtensionApiManifest(contents(), {expectedId: 'another'});
  expect(mismatched.manifest).toBe(null);
  expect(mismatched.error).toBe(
    'Extension API manifest ID mismatch: expected another, got example',
  );

  const malformed = tryParseExtensionApiManifest(Buffer.from('{'));
  expect(malformed.manifest).toBe(null);
  expect(malformed.error).toMatch(/^Extension API manifest is not valid JSON: /u);
});

test('returns the canonicalized manifest when parsing succeeds', () => {
  const result = tryParseExtensionApiManifest(contents(), {expectedId: 'example'});
  expect(result.error).toBe(null);
  expect(result.manifest).toStrictEqual(parseExtensionApiManifest(contents()));
});

const V2_BLOCK = {
  arguments: [{id: 'KEY', type: 'STRING'}],
  blockType: 'REPORTER',
  effect: 'storage-read',
  errors: ['KVS_KEY_INVALID'],
  immutable: true,
  opcode: 'getValue',
  resultType: 'string',
  server: {irOperation: 'kvs.getText', supported: true},
};

function v2(blockOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    blocks: [{...V2_BLOCK, ...blockOverrides}],
    formatVersion: 2,
    id: 'kubohiroyakvs',
    menus: [],
  });
}

test('parses a format version 2 manifest and keeps its metadata', () => {
  const parsed = parseExtensionApiManifest(v2(), {expectedId: 'kubohiroyakvs'});

  expect(parsed.formatVersion).toBe(2);
  expect(parsed.blocks[0]).toEqual(V2_BLOCK);
});

test('requires every format version 2 metadata field', () => {
  for (const key of ['resultType', 'effect', 'immutable', 'errors', 'server']) {
    const block: Record<string, unknown> = {...V2_BLOCK};
    delete block[key];
    const {error} = tryParseExtensionApiManifest(
      JSON.stringify({blocks: [block], formatVersion: 2, id: 'kubohiroyakvs', menus: []}),
    );
    expect(error).toContain(key);
  }
});

test('rejects format version 2 metadata in a format version 1 manifest', () => {
  const {error} = tryParseExtensionApiManifest(
    JSON.stringify({blocks: [V2_BLOCK], formatVersion: 1, id: 'kubohiroyakvs', menus: []}),
  );

  expect(error).toContain('unsupported properties');
});

test('rejects an effect outside the shared vocabulary', () => {
  const {error} = tryParseExtensionApiManifest(v2({effect: 'disk-write'}));

  expect(error).toContain('effect must be one of');
});

test('rejects a server hint that claims support without an operation', () => {
  const {error} = tryParseExtensionApiManifest(v2({server: {supported: true}}));

  expect(error).toContain('server.irOperation is required when supported is true');
});

test('accepts an unsupported server hint without an operation', () => {
  const parsed = parseExtensionApiManifest(v2({server: {supported: false}}));

  expect(parsed.blocks[0]?.server).toEqual({supported: false});
});

test('keeps format version 2 argument constraints', () => {
  const parsed = parseExtensionApiManifest(
    v2({
      arguments: [
        {
          id: 'PATH',
          maximum: 9,
          minimum: 0,
          normalizesTo: 'pathSegments',
          staticLiteral: true,
          type: 'STRING',
        },
      ],
    }),
  );

  expect(parsed.blocks[0]?.arguments[0]).toEqual({
    id: 'PATH',
    maximum: 9,
    minimum: 0,
    normalizesTo: 'pathSegments',
    staticLiteral: true,
    type: 'STRING',
  });
});

test('reports a format version rise as compatible and a fall as breaking', () => {
  const one = parseExtensionApiManifest(
    JSON.stringify({
      blocks: [
        {arguments: [{id: 'KEY', type: 'STRING'}], blockType: 'REPORTER', opcode: 'getValue'},
      ],
      formatVersion: 1,
      id: 'kubohiroyakvs',
      menus: [],
    }),
  );
  const two = parseExtensionApiManifest(v2());

  const rise = compareExtensionApiManifests(one, two).filter(
    (change) => change.kind === 'format-version-changed',
  );
  const fall = compareExtensionApiManifests(two, one).filter(
    (change) => change.kind === 'format-version-changed',
  );

  expect(rise).toEqual([
    {after: 2, before: 1, breaking: false, kind: 'format-version-changed', path: '/formatVersion'},
  ]);
  expect(fall[0]?.breaking).toBe(true);
});

test('classifies format version 2 metadata changes', () => {
  const installed = parseExtensionApiManifest(v2());

  const changed = (overrides: Record<string, unknown>) =>
    compareExtensionApiManifests(installed, parseExtensionApiManifest(v2(overrides)));

  expect(changed({resultType: 'json'})).toEqual([
    {
      after: 'json',
      before: 'string',
      breaking: true,
      kind: 'block-resultType-changed',
      path: '/blocks/getValue/resultType',
    },
  ]);
  expect(changed({effect: 'storage-write'})[0]?.breaking).toBe(true);
  expect(changed({immutable: false})[0]?.breaking).toBe(true);
  // A new error code only widens what the block declares.
  expect(changed({errors: ['KVS_KEY_INVALID', 'KVS_STORAGE_FAILURE']})).toEqual([
    {
      after: 'KVS_STORAGE_FAILURE',
      before: null,
      breaking: false,
      kind: 'block-error-added',
      path: '/blocks/getValue/errors',
    },
  ]);
  expect(changed({errors: []})[0]?.breaking).toBe(true);
  // Losing server support breaks a project whose server already lowers this block.
  expect(changed({server: {supported: false}}).some((change) => change.breaking)).toBe(true);
});

test('accepts the state effect and the extension-level types at version 2', () => {
  const pathSegmentType = {
    kind: 'discriminatedUnion',
    variants: [
      {kind: 'key', valueType: 'string'},
      {kind: 'index', valueType: 'nonNegativeInteger'},
    ],
  };
  const dataReferenceType = {
    kind: 'named',
    lifetime: 'untilProjectStop',
    scope: 'target',
    valueType: 'jsonValue',
  };
  const parsed = parseExtensionApiManifest(
    JSON.stringify({
      blocks: [{...V2_BLOCK, effect: 'state'}],
      dataReferenceType,
      formatVersion: 2,
      id: 'kubohiroyastructureddata',
      menus: [],
      pathSegmentType,
    }),
  );

  expect(parsed.blocks[0]?.effect).toBe('state');
  expect(parsed.pathSegmentType).toEqual(pathSegmentType);
  expect(parsed.dataReferenceType).toEqual(dataReferenceType);
});

test('rejects the extension-level types in a format version 1 manifest', () => {
  const {error} = tryParseExtensionApiManifest(
    JSON.stringify({
      blocks: [],
      dataReferenceType: {
        kind: 'named',
        lifetime: 'untilProjectStop',
        scope: 'target',
        valueType: 'jsonValue',
      },
      formatVersion: 1,
      id: 'kubohiroyastructureddata',
      menus: [],
    }),
  );

  expect(error).toContain('unsupported properties');
});

test('rejects a malformed path segment type', () => {
  const {error} = tryParseExtensionApiManifest(
    JSON.stringify({
      blocks: [V2_BLOCK],
      formatVersion: 2,
      id: 'kubohiroyakvs',
      menus: [],
      pathSegmentType: {kind: 'union', variants: [{kind: 'key', valueType: 'string'}]},
    }),
  );

  expect(error).toContain('pathSegmentType kind must be discriminatedUnion');
});
