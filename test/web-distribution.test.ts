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

function npmFixture(file = bundle, changeIntegrity = false) {
  const archive = npmArchive({
    'package.json': JSON.stringify({
      name: packageName,
      version,
      license: 'MIT',
      turbowarpExtension: {resourceDeclaration: resources},
    }),
    'dist/extension-package.json': descriptor,
    'dist/extension-manifest.json': api,
    'dist/sample.js': file,
  });
  const tarball = 'https://registry.npmjs.org/' + packageName + '/-/sample-' + version + '.tgz';
  const integrity =
    'sha512-' +
    createHash('sha512')
      .update(changeIntegrity ? 'incorrect' : archive)
      .digest('base64');
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    url === tarball
      ? new Response(archive)
      : Response.json({name: packageName, version, dist: {tarball, integrity}}),
  );
  return {fetchImpl};
}

function releaseFixture(changedAsset = false) {
  const assets = [
    artifact('extension-package.json', descriptor),
    distribution.bundle,
    distribution.api,
  ].map(({file, sha256}) => ({
    name: file,
    state: 'uploaded',
    digest: 'sha256:' + (changedAsset && file === filename ? '0'.repeat(64) : sha256),
  }));
  const route = {
    ['https://api.github.com/repos/owner/sample/releases/tags/' + tag]: Response.json({
      id: 123,
      tag_name: tag,
      draft: false,
      assets,
    }),
    ['https://api.github.com/repos/owner/sample/git/ref/tags/' + tag]: Response.json({
      ref: 'refs/tags/' + tag,
      object: {type: 'tag', sha: 'b'.repeat(40)},
    }),
    ['https://api.github.com/repos/owner/sample/git/tags/' + 'b'.repeat(40)]: Response.json({
      object: {type: 'commit', sha: commit},
    }),
    ...Object.fromEntries(
      Object.entries({
        'extension-package.json': descriptor,
        'extension-manifest.json': api,
        [filename]: bundle,
      }).map(([file, bytes]) => [
        'https://raw.githubusercontent.com/owner/sample/' + commit + '/dist/' + file,
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
        releaseFixture(true),
      ),
    ).rejects.toMatchObject({code: 'RELEASE_METADATA'});
  });

  it.each([
    '1.0.0',
    packageName + '@latest',
    'https://github.com/owner/../releases/tag/v1.2.3',
    'https://github.com/owner/sample',
    'https://github.com/owner/sample/releases/tag/..',
  ])('rejects %s before making requests', async (reference) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(resolvePublishedExtension(reference, {fetchImpl})).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
