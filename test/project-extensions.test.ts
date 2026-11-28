// SPDX-License-Identifier: MPL-2.0
import {createHash} from 'node:crypto';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {describe, expect, it} from 'vitest';
import {extensionLocksEntry, lockPublishedExtension} from '../src/extension-artifact-lock';
import {
  applyProjectExtensionUpdate,
  listProjectExtensions,
  planProjectExtensionUpdate,
  type ProjectExtensionPlanOptions,
} from '../src/project-extensions';
import type {PublishedExtension} from '../src/web-distribution';

const id = 'sample';
const packageName = '@outside-editor/sample';
const hex = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const encode = (value: string) => new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
const dataUrl = (value: string) =>
  `data:text/javascript;base64,${Buffer.from(value).toString('base64')}`;
const bundleOf = (version: string) =>
  `// Name: Sample\n// ID: sample\n// License: MIT\n\n// extension ${version}\n`;
const apiOf = (opcodes: string[]) =>
  JSON.stringify({
    id,
    formatVersion: 1,
    blocks: opcodes.map((opcode) => ({opcode, blockType: 'COMMAND', arguments: []})),
    menus: [],
  });

/** A verified npm publication, as `resolvePublishedExtension` would return it. */
function published(
  version: string,
  {
    opcodes = ['go'],
    execution = 'sandboxed',
  }: {opcodes?: string[]; execution?: 'sandboxed' | 'unsandboxed'} = {},
): PublishedExtension {
  const bytes = encode(bundleOf(version));
  const apiBytes = encode(apiOf(opcodes));
  return {
    distribution: {
      formatVersion: 1,
      id,
      package: packageName,
      version,
      name: 'Sample',
      description: 'Sample extension',
      license: 'MIT',
      execution,
      resources: {schemaVersion: 1, resources: []} as never,
      bundle: {file: 'sample.js', size: bytes.length, sha256: hex(bytes)},
      api: {file: 'extension-manifest.json', size: apiBytes.length, sha256: hex(apiBytes)},
    },
    source: {
      provider: 'npm',
      package: packageName,
      version,
      integrity: `sha512-${'A'.repeat(86)}==`,
    },
    bytes,
    apiBytes,
    measurements: {downloadBytes: 0, expandedBytes: 0, cacheBytes: 0, temporaryDiskBytes: 0},
  };
}

const releases = {
  '1.0.0': published('1.0.0'),
  '1.1.0': published('1.1.0'),
  '2.0.0-beta.1': published('2.0.0-beta.1'),
  '2.0.0': published('2.0.0', {opcodes: ['stop']}),
  '3.0.0': published('3.0.0', {execution: 'unsandboxed'}),
} as const;
const cdn = (version: string) =>
  `https://cdn.jsdelivr.net/npm/${packageName}@${version}/dist/sample.js`;

/** A registry where `latest` points at `latest`, and a CDN that serves every release. */
function ports(
  latest: keyof typeof releases = '1.1.0',
): ProjectExtensionPlanOptions & {resolved: string[]} {
  const resolved: string[] = [];
  return {
    resolved,
    resolve: async (reference) => {
      resolved.push(reference);
      const version = reference.slice(reference.lastIndexOf('@') + 1);
      const release = releases[(version === 'latest' ? latest : version) as keyof typeof releases];
      if (!release) throw new Error('No such version');
      return release;
    },
    fetch: (async (url: string) => {
      const release = Object.values(releases).find(
        (item) => cdn(item.distribution.version) === url,
      );
      return release ? new Response(release.bytes) : new Response('missing', {status: 404});
    }) as unknown as typeof fetch,
  };
}

/** A project that uses `sample` 1.0.0 by reference, with its lock, beside an unrelated extension. */
function lockedProject() {
  const release = releases['1.0.0'];
  const other = '// other\n';
  const archive: Record<string, Uint8Array> = {
    'costume.svg': strToU8('<svg/>'),
    [extensionLocksEntry]: strToU8(
      `${JSON.stringify({formatVersion: 1, extensions: [{id, artifactLock: lockPublishedExtension(release)}]})}\n`,
    ),
  };
  const project = {
    targets: [
      {
        isStage: true,
        blocks: {a: {opcode: 'sample_go'}, b: {opcode: 'other_x'}},
        variables: {v: ['score', 3]},
      },
    ],
    meta: {semver: '3.0.0'},
    extensions: [id, 'other'],
    extensionURLs: {other: dataUrl(other)},
    turboWarpPlus: {
      schemaVersion: 1,
      uri: 'https://example.test/works/demo.sb3',
      extensions: [
        {
          id,
          source: {type: 'remote-cacheable', url: cdn('1.0.0')},
          execution: 'sandboxed',
          sha256: hex(release.bytes),
          version: '1.0.0',
          capabilities: [],
          dependencies: [],
        },
      ],
    },
  };
  return {archive, project};
}

describe('project extension updates', () => {
  it('lists what the project records, and admits what it does not', async () => {
    const {archive, project} = lockedProject();
    const [sample, other] = await listProjectExtensions(archive, project);
    expect(sample).toMatchObject({
      id,
      format: 'remote-cacheable',
      version: '1.0.0',
      source: {kind: 'npm', package: packageName, version: '1.0.0'},
    });
    expect(other).toMatchObject({id: 'other', format: 'embedded-data', source: {kind: 'unknown'}});
    expect(other!.diagnostics.map((item) => item.code)).toEqual([
      'LEGACY_DATA_URL',
      'SOURCE_UNKNOWN',
    ]);
  });

  it('updates to the latest stable release and pins its version, digest, address and lock', async () => {
    const {archive, project} = lockedProject();
    const before = structuredClone({archive, project});
    const options = ports();
    const plan = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: 'latest'}},
      options,
    );
    expect(options.resolved).toEqual([`${packageName}@latest`]);
    expect(plan.blocked).toBe(false);
    expect(plan.steps[0]).toMatchObject({
      change: 'version',
      from: {version: '1.0.0'},
      to: {
        version: '1.1.0',
        format: 'remote-cacheable',
        url: cdn('1.1.0'),
        sha256: hex(releases['1.1.0'].bytes),
      },
    });
    const result = await applyProjectExtensionUpdate(archive, project, plan, options);
    expect({archive, project}).toEqual(before);
    const [sample, other] = await listProjectExtensions(result.archive, result.project);
    expect(sample).toMatchObject({
      version: '1.1.0',
      url: cdn('1.1.0'),
      source: {kind: 'npm', version: '1.1.0'},
    });
    expect(other).toEqual((await listProjectExtensions(archive, project))[1]);
    expect(result.project.targets).toBe(project.targets);
    expect(result.archive['costume.svg']).toBe(archive['costume.svg']);
    expect((result.project.turboWarpPlus as {uri: string}).uri).toBe(
      'https://example.test/works/demo.sb3',
    );
  });

  it('goes back to an older version and embeds it in one step', async () => {
    const {archive, project} = lockedProject();
    const options = ports();
    const newer = await applyProjectExtensionUpdate(
      archive,
      project,
      await planProjectExtensionUpdate(archive, project, {[id]: {version: '1.1.0'}}, options),
      options,
    );
    const plan = await planProjectExtensionUpdate(
      newer.archive,
      newer.project,
      {[id]: {version: '1.0.0', format: 'embedded-data'}},
      options,
    );
    expect(plan.steps[0]!.change).toBe('version-and-format');
    expect(plan.steps[0]!.diagnostics.map((item) => item.code)).toContain('DOWNGRADE');
    const older = await applyProjectExtensionUpdate(newer.archive, newer.project, plan, options);
    const [sample] = await listProjectExtensions(older.archive, older.project);
    // Embedded, but it still records the address and version it came from.
    expect(sample).toMatchObject({
      format: 'embedded-data',
      version: '1.0.0',
      url: cdn('1.0.0'),
      source: {kind: 'npm'},
    });
    expect((older.project.extensionURLs as Record<string, string>)[id]).toBe(
      dataUrl(bundleOf('1.0.0')),
    );
  });

  it('does not take a prerelease for a stable release unless asked', async () => {
    const {archive, project} = lockedProject();
    const blocked = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: 'latest'}},
      ports('2.0.0-beta.1'),
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.steps[0]!.diagnostics.map((item) => item.code)).toContain(
      'PRERELEASE_NOT_REQUESTED',
    );
    await expect(applyProjectExtensionUpdate(archive, project, blocked)).rejects.toMatchObject({
      code: 'PLAN_BLOCKED',
    });
    const allowed = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: 'latest', allowPrerelease: true}},
      ports('2.0.0-beta.1'),
    );
    expect(allowed.blocked).toBe(false);
    const explicit = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: '2.0.0-beta.1'}},
      ports(),
    );
    expect(explicit.steps[0]!.diagnostics.map((item) => [item.code, item.severity])).toContainEqual(
      ['PRERELEASE', 'warning'],
    );
  });

  it('blocks a version without a block the project uses, and a wider execution mode', async () => {
    const {archive, project} = lockedProject();
    const breaking = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: '2.0.0'}},
      ports(),
    );
    expect(
      breaking.steps[0]!.diagnostics.filter((item) => item.severity === 'error').map(
        (item) => item.code,
      ),
    ).toEqual(['BLOCK_IN_USE_REMOVED', 'API_BREAKING']);
    const widened = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: '3.0.0'}},
      ports(),
    );
    expect(widened.blocked).toBe(true);
    const allowed = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: '3.0.0', allowExecutionChange: true}},
      ports(),
    );
    expect(allowed.steps[0]!.to.execution).toBe('unsandboxed');
  });

  it('changes only the form, keeping the bytes, and verifies the address first', async () => {
    const {archive, project} = lockedProject();
    const options = ports();
    const embedded = await applyProjectExtensionUpdate(
      archive,
      project,
      await planProjectExtensionUpdate(
        archive,
        project,
        {[id]: {format: 'embedded-file'}},
        options,
      ),
      options,
    );
    expect(options.resolved).toEqual([]);
    const [sample] = await listProjectExtensions(embedded.archive, embedded.project);
    expect(sample).toMatchObject({
      format: 'embedded-file',
      sha256: hex(releases['1.0.0'].bytes),
      url: cdn('1.0.0'),
    });
    expect(embedded.archive[extensionLocksEntry]).toEqual(archive[extensionLocksEntry]);

    const wrong = await planProjectExtensionUpdate(
      embedded.archive,
      embedded.project,
      {other: {format: 'remote-cacheable', url: cdn('1.1.0')}},
      options,
    );
    expect(wrong.steps[0]!.diagnostics.map((item) => item.code)).toContain('REMOTE_MISMATCH');
    expect(wrong.blocked).toBe(true);
  });

  it('identifies an embedded copy of unknown origin only from a reference that serves its bytes', async () => {
    const archive = {};
    const project = {
      targets: [],
      extensions: [id],
      extensionURLs: {[id]: dataUrl(bundleOf('1.0.0'))},
    };
    const unknown = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: 'latest'}},
      ports(),
    );
    expect(unknown.steps[0]!.diagnostics.map((item) => item.code)).toEqual(['SOURCE_UNKNOWN']);

    const options = ports();
    const plan = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {reference: `${packageName}@1.0.0`}},
      options,
    );
    expect(plan.steps[0]).toMatchObject({
      change: 'source',
      to: {format: 'embedded-data', url: cdn('1.0.0')},
    });
    const result = await applyProjectExtensionUpdate(archive, project, plan, options);
    const [sample] = await listProjectExtensions(result.archive, result.project);
    expect(sample).toMatchObject({
      source: {kind: 'npm', version: '1.0.0'},
      url: cdn('1.0.0'),
      version: '1.0.0',
    });
  });

  it('refuses a plan for a project that changed since', async () => {
    const {archive, project} = lockedProject();
    const options = ports();
    const plan = await planProjectExtensionUpdate(
      archive,
      project,
      {[id]: {version: 'latest'}},
      options,
    );
    const edited = {...project, targets: [...project.targets, {isStage: false, blocks: {}}]};
    await expect(applyProjectExtensionUpdate(archive, edited, plan, options)).rejects.toMatchObject(
      {code: 'PLAN_STALE'},
    );
    await expect(
      applyProjectExtensionUpdate(archive, project, JSON.parse(JSON.stringify(plan))),
    ).rejects.toMatchObject({code: 'PLAN_UNKNOWN'});
  });

  it('keeps the version, form and lock through saving and reopening the SB3', async () => {
    const {archive, project} = lockedProject();
    const options = ports();
    const result = await applyProjectExtensionUpdate(
      archive,
      project,
      await planProjectExtensionUpdate(
        archive,
        project,
        {[id]: {version: '1.1.0', format: 'embedded-file'}},
        options,
      ),
      options,
    );
    const sb3 = zipSync({
      ...result.archive,
      'project.json': strToU8(JSON.stringify(result.project)),
    });
    const {'project.json': json, ...reopened} = unzipSync(sb3);
    const [sample] = await listProjectExtensions(reopened, JSON.parse(strFromU8(json!)));
    expect(sample).toMatchObject({
      format: 'embedded-file',
      version: '1.1.0',
      source: {kind: 'npm', version: '1.1.0'},
      diagnostics: [],
    });
  });
});
