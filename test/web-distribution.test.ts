// SPDX-License-Identifier: MPL-2.0
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {describe, expect, it, vi} from 'vitest';
import {resolvePublishedExtension} from '../src/web-distribution';

const filename = 'sample.js';
const packageName = '@outside-editor/sample';
const version = '1.2.3';
const tag = 'v' + version;
const commit = 'a'.repeat(40);
const resources = {schemaVersion: 1, resources: []};
const bundle = '// Name: Sample\n// ID: sample\n// License: MIT\n\n// extension\n';
const api = JSON.stringify({id: 'sample', formatVersion: 1, blocks: [], menus: []});
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const artifact = (file: string, contents: string) => ({
  file,
  size: Buffer.byteLength(contents),
  sha256: sha256(contents),
});
const distribution = {
  formatVersion: 1,
  id: 'sample',
  package: packageName,
  version,
  name: 'Sample',
  description: 'Sample extension',
  license: 'MIT',
  resources,
  execution: 'sandboxed',
  bundle: artifact(filename, bundle),
  api: artifact('extension-manifest.json', api),
};
const descriptor = JSON.stringify(distribution);

function npmArchive(files: Record<string, string>) {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write('package/' + name);
    const body = Buffer.from(content);
    header.write(body.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156);
    header.write('0ustar', 156);
    const checksum = header.reduce((total, byte) => total + byte, 0).toString(8);
    header.write(checksum.padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return new Uint8Array(gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

function npmFixture(
  file = bundle,
  changeIntegrity = false,
  expected = bundle,
  resolvedVersion = version,
) {
  const archive = npmArchive({
    'package.json': JSON.stringify({
      name: packageName,
      version: resolvedVersion,
      license: 'MIT',
      turbowarpExtension: {resourceDeclaration: resources},
    }),
    'dist/extension-package.json': JSON.stringify({
      ...distribution,
      version: resolvedVersion,
      bundle: artifact(filename, expected),
    }),
    'dist/extension-manifest.json': api,
    'dist/sample.js': file,
  });
  const tarball =
    'https://registry.npmjs.org/' + packageName + '/-/sample-' + resolvedVersion + '.tgz';
  const integrity =
    'sha512-' +
    createHash('sha512')
      .update(changeIntegrity ? 'incorrect' : archive)
      .digest('base64');
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    url === tarball
      ? new Response(archive)
      : Response.json({name: packageName, version: resolvedVersion, dist: {tarball, integrity}}),
  );
  return {fetchImpl};
}

function releaseFixture(
  changes: {
    changedAsset?: boolean;
    changedAssetID?: boolean;
    missingAsset?: boolean;
    commit?: string;
    releaseID?: number;
    latestTag?: string;
    latestPrerelease?: boolean;
  } = {},
) {
  const {
    changedAsset = false,
    changedAssetID = false,
    missingAsset = false,
    commit: revision = commit,
    releaseID = 123,
    latestTag = tag,
    latestPrerelease = false,
  } = changes;
  const assets = [
    artifact('extension-package.json', descriptor),
    distribution.bundle,
    distribution.api,
  ]
    .map(({file, sha256}, index) => ({
      id: changedAssetID && file === filename ? 999 : index + 101,
      name: file,
      state: 'uploaded',
      digest: 'sha256:' + (changedAsset && file === filename ? '0'.repeat(64) : sha256),
    }))
    .filter((asset) => !missingAsset || asset.name !== filename);
  const route = {
    ['https://api.github.com/repos/owner/sample/releases/latest']: Response.json({
      id: releaseID,
      tag_name: latestTag,
      draft: false,
      prerelease: latestPrerelease,
      assets,
    }),
    ['https://api.github.com/repos/owner/sample/releases/tags/' + tag]: Response.json({
      id: releaseID,
      tag_name: tag,
      draft: false,
      assets,
    }),
    ['https://api.github.com/repos/owner/sample/git/ref/tags/' + tag]: Response.json({
      ref: 'refs/tags/' + tag,
      object: {type: 'tag', sha: 'b'.repeat(40)},
    }),
    ['https://api.github.com/repos/owner/sample/git/tags/' + 'b'.repeat(40)]: Response.json({
      object: {type: 'commit', sha: revision},
    }),
    ...Object.fromEntries(
      Object.entries({
        'extension-package.json': descriptor,
        'extension-manifest.json': api,
        [filename]: bundle,
      }).map(([file, bytes]) => [
        'https://raw.githubusercontent.com/owner/sample/' + revision + '/dist/' + file,
        new Response(bytes),
      ]),
    ),
  };
  return {
    fetchImpl: vi.fn<typeof fetch>(
      async (url) => route[String(url)] ?? new Response('', {status: 404}),
    ),
  };
}

describe('published extension resolution', () => {
  it('returns the same checked bytes for the npm archive and the Release assets', async () => {
    const [npm, github] = await Promise.all([
      resolvePublishedExtension(packageName + '@' + version, npmFixture()),
      resolvePublishedExtension(
        'https://github.com/owner/sample/releases/tag/' + tag,
        releaseFixture(),
      ),
    ]);
    expect(npm.distribution).toEqual(github.distribution);
    expect(npm.bytes).toEqual(github.bytes);
    expect(new TextDecoder().decode(github.bytes)).toBe(bundle);
    expect(github.source).toMatchObject({commit, releaseID: 123});
  });

  it('pins Release identity and all observed asset names, IDs and digests on re-resolution', async () => {
    const reference = 'https://github.com/owner/sample/releases/tag/' + tag;
    const first = await resolvePublishedExtension(reference, releaseFixture());
    expect(first.source).toMatchObject({
      commit,
      releaseID: 123,
      assets: {
        descriptor: {id: 101, name: 'extension-package.json', sha256: sha256(descriptor)},
        bundle: {id: 102, name: filename, sha256: sha256(bundle)},
        api: {id: 103, name: 'extension-manifest.json', sha256: sha256(api)},
      },
    });
    await expect(
      resolvePublishedExtension(reference, {...releaseFixture(), expectedSource: first.source}),
    ).resolves.toMatchObject({source: first.source});
    for (const changes of [{changedAssetID: true}, {commit: 'f'.repeat(40)}, {releaseID: 124}]) {
      const fixture = releaseFixture(changes);
      await expect(
        resolvePublishedExtension(reference, {...fixture, expectedSource: first.source}),
      ).rejects.toMatchObject({code: 'SOURCE_CHANGED'});
      expect(
        fixture.fetchImpl.mock.calls
          .map(([url]) => String(url))
          .some((url) => url.endsWith('/' + filename)),
      ).toBe(false);
    }
    await expect(
      resolvePublishedExtension(reference, {
        ...releaseFixture({missingAsset: true}),
        expectedSource: first.source,
      }),
    ).rejects.toMatchObject({code: 'MISSING_RELEASE_ASSET'});
    const otherProvider = npmFixture();
    await expect(
      resolvePublishedExtension(packageName + '@' + version, {
        ...otherProvider,
        expectedSource: first.source,
      }),
    ).rejects.toMatchObject({code: 'SOURCE_CHANGED'});
    expect(otherProvider.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not download an npm archive after its published integrity changed from the receipt', async () => {
    const reference = packageName + '@' + version;
    const first = await resolvePublishedExtension(reference, npmFixture());
    const changed = npmFixture(bundle, true);
    await expect(
      resolvePublishedExtension(reference, {...changed, expectedSource: first.source}),
    ).rejects.toMatchObject({code: 'SOURCE_CHANGED'});
    expect(changed.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves a repository only through its latest stable published GitHub release', async () => {
    const reference = 'https://github.com/owner/sample';
    const fixture = releaseFixture();
    const resolved = await resolvePublishedExtension(reference, fixture);
    expect(resolved.source).toMatchObject({tag, commit, releaseID: 123});
    expect(fixture.fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/owner/sample/releases/latest',
      expect.objectContaining({credentials: 'omit', redirect: 'error'}),
    );
    expect(fixture.fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://api.github.com/repos/owner/sample/releases/tags/' + tag,
    );
    const next = releaseFixture({latestTag: 'v1.2.4'});
    await expect(
      resolvePublishedExtension(reference, {...next, expectedSource: resolved.source}),
    ).rejects.toMatchObject({code: 'SOURCE_CHANGED'});
    expect(next.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{latestTag: 'v1.2.3-rc.1'}, {latestPrerelease: true}])(
    'rejects non-stable repository metadata %o before requesting other artifacts',
    async (changes) => {
      const fixture = releaseFixture(changes);
      await expect(
        resolvePublishedExtension('https://github.com/owner/sample', fixture),
      ).rejects.toMatchObject({code: 'RELEASE_METADATA'});
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('does not fall back to source or other releases if the repository has no latest release', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {status: 404}));
    await expect(
      resolvePublishedExtension('https://github.com/owner/sample', {fetchImpl}),
    ).rejects.toMatchObject({code: 'HTTP_ERROR'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves npm dist-tags to exact versions and does not follow a moved tag under a lock', async () => {
    const fixture = npmFixture();
    const reference = packageName + '@next';
    const resolved = await resolvePublishedExtension(reference, fixture);
    expect(resolved.source).toMatchObject({provider: 'npm', version});
    const root = 'https://registry.npmjs.org/' + encodeURIComponent(packageName);
    expect(fixture.fetchImpl.mock.calls[0]?.[0]).toEqual(root + '/next');
    const bare = npmFixture();
    await expect(resolvePublishedExtension(packageName, bare)).resolves.toMatchObject({
      source: resolved.source,
    });
    expect(bare.fetchImpl.mock.calls[0]?.[0]).toEqual(root + '/latest');
    const moved = npmFixture(bundle, false, bundle, '1.2.4');
    await expect(
      resolvePublishedExtension(reference, {...moved, expectedSource: resolved.source}),
    ).rejects.toMatchObject({code: 'SOURCE_CHANGED'});
    expect(moved.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('can resolve another package after a bundle whose header sample cuts a UTF-8 character', async () => {
    const split = bundle + 'a'.repeat(4095 - Buffer.byteLength(bundle)) + '界';
    await resolvePublishedExtension(packageName + '@' + version, npmFixture(split, false, split));
    const next = await resolvePublishedExtension(packageName + '@' + version, npmFixture());
    expect(new TextDecoder().decode(next.bytes)).toBe(bundle);
  });

  it('reports malformed npm tarball metadata before fetching an archive', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        name: packageName,
        version,
        dist: {
          tarball: 'https://registry.npmjs.org/%ZZ',
          integrity: 'sha512-' + 'a'.repeat(86) + '==',
        },
      }),
    );
    await expect(
      resolvePublishedExtension(packageName + '@' + version, {fetchImpl}),
    ).rejects.toMatchObject({code: 'NPM_METADATA'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects tarball and artifact integrity mismatches independently', async () => {
    await expect(
      resolvePublishedExtension(packageName + '@' + version, npmFixture(bundle, true)),
    ).rejects.toMatchObject({code: 'ARCHIVE_INTEGRITY'});
    await expect(
      resolvePublishedExtension(packageName + '@' + version, npmFixture(bundle + 'changed')),
    ).rejects.toMatchObject({code: 'ARTIFACT_MISMATCH'});
    await expect(
      resolvePublishedExtension(
        'https://github.com/owner/sample/releases/tag/' + tag,
        releaseFixture({changedAsset: true}),
      ),
    ).rejects.toMatchObject({code: 'RELEASE_METADATA'});
  });

  it.each([
    '1.0.0',
    packageName + '@^1.0.0',
    'https://github.com/owner/../releases/tag/v1.2.3',
    'https://github.com/owner/sample/tree/main',
    'https://github.com/owner/sample/releases/tag/..',
  ])('rejects %s before making requests', async (reference) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(resolvePublishedExtension(reference, {fetchImpl})).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
