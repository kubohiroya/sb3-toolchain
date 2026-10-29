// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {expect, test, vi} from 'vitest';

import {parseCliArguments, runCli} from '../src/cli';
import {
  defaultKamishibaiManifestUrl,
  kamishibaiReplacementIds,
  replaceSb3Extensions,
} from '../src/index';

const [runtimeId, authoringId] = kamishibaiReplacementIds;
const donorUrl =
  'https://kubohiroya.github.io/turbowarp-kamishibai-samples/stories/tutorial/tutorial-blocks-4.0.sb3';

function dataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

function project(version: string, label: string): any {
  return {
    targets: [
      {
        name: label,
        isStage: true,
        blocks: {
          start: {
            opcode: `${authoringId}_kamishibai`,
            inputs: {LABEL: [1, [10, label]]},
            x: 19,
            y: 42,
          },
        },
        variables: {score: ['score', 25]},
        costumes: [],
        sounds: [],
        extensionStorage: {[runtimeId]: {label}},
      },
    ],
    extensions: [runtimeId, authoringId, 'pen'],
    extensionStorage: {[runtimeId]: {assets: {'/assets/SafetyPose': 'keep-story-data'}}},
    extensionURLs: {
      [runtimeId]: dataUrl(
        `// ID: ${runtimeId}\n// Version: ${version}\nthrow new Error('never execute ${label}');\n`,
      ),
      [authoringId]: dataUrl(
        `(function(Scratch){const extension={getInfo(){return {"id":"${authoringId}","name":"${label}"}}};Scratch.extensions.register(extension);})(Scratch);`,
      ),
      other: dataUrl('// ID: other\n// Keep this extension.\n'),
      external: 'https://example.invalid/custom.js',
    },
    monitors: [{opcode: `${runtimeId}_value`, value: 3}],
    meta: {semver: '3.0.0', agent: label},
  };
}

function archive(value: any): Uint8Array {
  return zipSync({
    'project.json': strToU8(JSON.stringify(value)),
    'costume.svg': strToU8('<svg>original</svg>'),
    'extra/story.txt': strToU8('extra archive entries must survive'),
  });
}

function manifest(contents: Uint8Array): any {
  return {
    formatVersion: 1,
    status: 'published',
    published: true,
    version: '4.0.0-rc.69',
    runtime: {version: '4.0.0-rc.69'},
    surfaces: {sb3BlocksUrl: donorUrl},
    artifacts: {
      sb3Blocks: {
        size: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex'),
      },
    },
  };
}

async function withFixture(
  callback: (fixture: {
    inputPath: string;
    fromPath: string;
    outputPath: string;
    directory: string;
    input: any;
    donor: any;
    inputArchive: Uint8Array;
    donorArchive: Uint8Array;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-replace-test-'));
  const inputPath = path.join(directory, 'input.sb3');
  const fromPath = path.join(directory, 'donor.sb3');
  const outputPath = path.join(directory, 'output.sb3');
  const input = project('4.0.0-rc.68', 'original');
  const donor = project('4.0.0-rc.69', 'donor');
  const inputArchive = archive(input);
  const donorArchive = archive(donor);
  await writeFile(inputPath, inputArchive);
  await writeFile(fromPath, donorArchive);
  try {
    await callback({
      inputPath,
      fromPath,
      outputPath,
      directory,
      input,
      donor,
      inputArchive,
      donorArchive,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function downloads(contents: Uint8Array, metadata: any = manifest(contents)) {
  return vi.fn<typeof fetch>(async (input) => {
    if (input === defaultKamishibaiManifestUrl) return Response.json(metadata);
    if (input === donorUrl) return new Response(Buffer.from(contents));
    throw new Error(`Unexpected request: ${input}`);
  });
}

test('parses automatic and explicit donor commands and rejects incomplete options', () => {
  expect(
    parseCliArguments(['extensions', 'replace-sb3', 'input.sb3', '--output', 'output.sb3']),
  ).toMatchObject({
    command: 'extensions',
    action: 'replace-sb3',
    fromPath: undefined,
    inputPath: path.resolve('input.sb3'),
    outputPath: path.resolve('output.sb3'),
    yes: false,
  });
  expect(
    parseCliArguments([
      'extensions',
      'replace-sb3',
      'input.sb3',
      '--from',
      'donor.sb3',
      '--output',
      'output.sb3',
      '--yes',
    ]),
  ).toMatchObject({fromPath: path.resolve('donor.sb3'), yes: true});
  expect(() => parseCliArguments(['extensions', 'replace-sb3', 'input.sb3'])).toThrow('--output');
  expect(() => parseCliArguments(['extensions', 'replace-sb3', '--from'])).toThrow(
    'requires a value',
  );
  expect(() => parseCliArguments(['extensions', 'replace-sb3', 'one.sb3', 'two.sb3'])).toThrow(
    'Only one',
  );
  expect(() => parseCliArguments(['extensions', 'replace-sb3', 'one.sb3', '--force'])).toThrow(
    'Unknown option',
  );
});

test('local donor replaces both implementations while retaining all story values, unrelated extensions and archive bytes', async () => {
  await withFixture(
    async ({inputPath, fromPath, outputPath, input, donor, inputArchive, donorArchive}) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const result = await replaceSb3Extensions({inputPath, fromPath, outputPath, fetch});
      const entries = unzipSync(await readFile(outputPath));
      const actual = JSON.parse(strFromU8(entries['project.json']));
      const expected = structuredClone(input);
      for (const id of kamishibaiReplacementIds)
        expected.extensionURLs[id] = donor.extensionURLs[id];
      expect(actual).toStrictEqual(expected);
      for (const [name, contents] of Object.entries(unzipSync(inputArchive)).filter(
        ([name]) => name !== 'project.json',
      )) {
        expect(entries[name]).toEqual(contents);
      }
      expect(Object.keys(entries)).toEqual(Object.keys(unzipSync(inputArchive)));
      expect(await readFile(inputPath)).toEqual(Buffer.from(inputArchive));
      expect(await readFile(fromPath)).toEqual(Buffer.from(donorArchive));
      expect(fetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        changed: true,
        extensionIds: [...kamishibaiReplacementIds],
        donor: {source: fromPath, version: '4.0.0-rc.69'},
      });
      expect(await replaceSb3Extensions({inputPath, fromPath, outputPath, fetch})).toMatchObject({
        changed: false,
      });
    },
  );
});

test('omitted --from downloads the published donor, verifies it, updates both IDs and reports provenance', async () => {
  await withFixture(async ({inputPath, outputPath, donorArchive, donor}) => {
    const fetch = downloads(donorArchive);
    const log = vi.fn();
    await runCli(['extensions', 'replace-sb3', inputPath, '--output', outputPath], {fetch, log});
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([defaultKamishibaiManifestUrl, donorUrl]);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    const output = JSON.parse(strFromU8(unzipSync(await readFile(outputPath))['project.json']));
    for (const id of kamishibaiReplacementIds)
      expect(output.extensionURLs[id]).toBe(donor.extensionURLs[id]);
    expect(log.mock.calls.flat().join('\n')).toContain(
      `version=4.0.0-rc.69; sha256=${manifest(donorArchive).artifacts.sb3Blocks.sha256}`,
    );
  });
});

test.each([
  [
    'unpublished',
    (m: any) => {
      m.published = false;
    },
    /published/,
  ],
  [
    'candidate',
    (m: any) => {
      m.status = 'candidate';
    },
    /published/,
  ],
  [
    'format',
    (m: any) => {
      m.formatVersion = 2;
    },
    /format 1/,
  ],
  [
    'version',
    (m: any) => {
      m.version = 'latest';
    },
    /version/,
  ],
  [
    'runtime version',
    (m: any) => {
      m.runtime.version = '4.0.0-rc.68';
    },
    /version mismatch/,
  ],
  [
    'foreign URL',
    (m: any) => {
      m.surfaces.sb3BlocksUrl = 'https://example.invalid/donor.sb3';
    },
    /official samples/,
  ],
  [
    'size',
    (m: any) => {
      m.artifacts.sb3Blocks.size += 1;
    },
    /size mismatch/,
  ],
  [
    'hash',
    (m: any) => {
      m.artifacts.sb3Blocks.sha256 = '0'.repeat(64);
    },
    /SHA-256 mismatch/,
  ],
] as const)(
  'rejects %s manifest without modifying an existing output',
  async (_name, change, error) => {
    await withFixture(async ({inputPath, outputPath, donorArchive}) => {
      await writeFile(outputPath, 'existing output');
      const metadata = manifest(donorArchive);
      change(metadata);
      await expect(
        replaceSb3Extensions({
          inputPath,
          outputPath,
          yes: true,
          fetch: downloads(donorArchive, metadata),
        }),
      ).rejects.toThrow(error);
      expect(await readFile(outputPath, 'utf8')).toBe('existing output');
    });
  },
);

test.each(['missing', 'wrong ID'] as const)(
  'rejects donor with %s authoring extension atomically',
  async (kind) => {
    await withFixture(async ({inputPath, fromPath, outputPath, donor}) => {
      if (kind === 'missing') delete donor.extensionURLs[authoringId];
      else donor.extensionURLs[authoringId] = dataUrl('// ID: wrong\n');
      await writeFile(fromPath, archive(donor));
      await expect(replaceSb3Extensions({inputPath, fromPath, outputPath})).rejects.toThrow(
        kind === 'missing' ? /Missing embedded/ : /ID mismatch/,
      );
      await expect(readFile(outputPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
  },
);

test('refuses automatic downgrade but allows an explicitly selected older local donor', async () => {
  await withFixture(async ({inputPath, fromPath, outputPath, input, donorArchive}) => {
    input.extensionURLs[runtimeId] = project('4.0.0-rc.70', 'newer').extensionURLs[runtimeId];
    await writeFile(inputPath, archive(input));
    await expect(
      replaceSb3Extensions({inputPath, outputPath, fetch: downloads(donorArchive)}),
    ).rejects.toThrow('older than input');
    await expect(readFile(outputPath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(replaceSb3Extensions({inputPath, fromPath, outputPath})).resolves.toMatchObject({
      changed: true,
    });
  });
});

test('rejects a runtime whose header disagrees with the published version', async () => {
  await withFixture(async ({inputPath, outputPath, donor}) => {
    donor.extensionURLs[runtimeId] = project('4.0.0-rc.68', 'wrong version').extensionURLs[
      runtimeId
    ];
    await expect(
      replaceSb3Extensions({inputPath, outputPath, fetch: downloads(archive(donor))}),
    ).rejects.toThrow('header does not match');
    await expect(readFile(outputPath)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

test('input and donor paths cannot be overwritten, including through symlink aliases and --yes', async () => {
  await withFixture(async ({inputPath, fromPath, inputArchive, directory}) => {
    await expect(
      replaceSb3Extensions({inputPath, fromPath, outputPath: inputPath, yes: true}),
    ).rejects.toThrow('Output must differ');
    await expect(
      replaceSb3Extensions({inputPath, fromPath, outputPath: fromPath, yes: true}),
    ).rejects.toThrow('Output must differ');
    const alias = path.join(directory, 'alias');
    await symlink(directory, alias);
    await expect(
      replaceSb3Extensions({
        inputPath,
        fromPath,
        outputPath: path.join(alias, 'input.sb3'),
        yes: true,
      }),
    ).rejects.toThrow('Output must differ');
    expect(await readFile(inputPath)).toEqual(Buffer.from(inputArchive));
  });
});

test('differing outputs require confirmation and cancelled replacement retains the output', async () => {
  await withFixture(async ({inputPath, fromPath, outputPath}) => {
    await writeFile(outputPath, 'old output');
    await expect(replaceSb3Extensions({inputPath, fromPath, outputPath})).rejects.toThrow(
      'requires --yes',
    );
    await expect(
      replaceSb3Extensions({inputPath, fromPath, outputPath, confirmReplace: () => false}),
    ).rejects.toThrow('cancelled');
    expect(await readFile(outputPath, 'utf8')).toBe('old output');
    await expect(
      replaceSb3Extensions({inputPath, fromPath, outputPath, yes: true}),
    ).resolves.toMatchObject({changed: true});
  });
});

test.each(['network', 'HTTP', 'oversize'] as const)(
  'failed %s download leaves no output',
  async (kind) => {
    await withFixture(async ({inputPath, outputPath}) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        if (kind === 'network') throw new Error('offline');
        if (kind === 'HTTP') return new Response('not found', {status: 404});
        return new Response('x'.repeat(1024 * 1024 + 1));
      });
      await expect(replaceSb3Extensions({inputPath, outputPath, fetch})).rejects.toThrow(
        kind === 'network' ? /offline/ : kind === 'HTTP' ? /404/ : /size limit/,
      );
      await expect(readFile(outputPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
  },
);

test('unsupported input fails before downloading anything', async () => {
  await withFixture(async ({inputPath, outputPath}) => {
    await writeFile(inputPath, archive({extensionURLs: {}}));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(replaceSb3Extensions({inputPath, outputPath, fetch})).rejects.toThrow(
      'no supported',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
