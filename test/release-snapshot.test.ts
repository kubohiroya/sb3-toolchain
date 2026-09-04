// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {test} from 'vitest';

import {
  computeReleaseSourceIdentity,
  createSb3ReleaseSnapshot,
  freezeSb3ReleaseSnapshot,
  readSb3ReleaseSnapshotMetadata,
  recordPublishedSb3ReleaseSnapshot,
  verifySb3ReleaseSnapshot,
  writeSb3ReleaseCandidate,
} from '../src/index';

const sourceFiles = () =>
  new Map([
    ['assets/example.svg', Buffer.from('<svg/>\n')],
    ['project.source.json', Buffer.from('{"targets":[]}\n')],
  ]);

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-release-snapshot-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('derives a stable release source identity from sorted paths and bytes', () => {
  const ordered = sourceFiles();
  const reversed = new Map([...ordered].reverse());
  const modified = sourceFiles();
  modified.set('project.source.json', Buffer.from('{"targets":[1]}\n'));

  assert.equal(computeReleaseSourceIdentity(ordered), computeReleaseSourceIdentity(reversed));
  assert.notEqual(computeReleaseSourceIdentity(ordered), computeReleaseSourceIdentity(modified));
});

test('creates and verifies a deterministic release snapshot candidate', async () => {
  const archive = Buffer.from('deterministic-sb3');
  const createSb3 = async () => ({archive});
  const snapshot = await createSb3ReleaseSnapshot({
    artifact: {
      filename: 'example.sb3',
      url: 'https://example.com/downloads/example.sb3',
    },
    createSb3,
    metadata: {version: '1.0.0'},
    publication: {npm: {distTag: 'next'}},
    sourceFiles: sourceFiles(),
  });

  assert.equal(snapshot.metadata.formatVersion, 1);
  assert.equal(snapshot.metadata.version, '1.0.0');
  assert.equal(snapshot.metadata.state, 'candidate');
  assert.equal(snapshot.metadata.artifact.filename, 'example.sb3');
  assert.equal(snapshot.metadata.artifact.size, archive.byteLength);

  await assert.doesNotReject(
    verifySb3ReleaseSnapshot({
      createSb3,
      metadata: snapshot.metadata,
      sourceFiles: sourceFiles(),
    }),
  );
});

test('detects stale sources, stale artifacts, and nondeterministic builds', async () => {
  const snapshot = await createSb3ReleaseSnapshot({
    artifact: {filename: 'example.sb3'},
    createSb3: async () => ({archive: Buffer.from('deterministic-sb3')}),
    sourceFiles: sourceFiles(),
  });

  const changedFiles = sourceFiles();
  changedFiles.set('changed.txt', Buffer.from('changed\n'));
  await assert.rejects(
    verifySb3ReleaseSnapshot({
      createSb3: async () => ({archive: Buffer.from('deterministic-sb3')}),
      metadata: snapshot.metadata,
      sourceFiles: changedFiles,
    }),
    /source changed/u,
  );

  await assert.rejects(
    verifySb3ReleaseSnapshot({
      createSb3: async () => ({archive: Buffer.from('other-sb3')}),
      metadata: snapshot.metadata,
      sourceFiles: sourceFiles(),
    }),
    /SHA-256 is stale/u,
  );

  let buildCount = 0;
  await assert.rejects(
    verifySb3ReleaseSnapshot({
      createSb3: async () => {
        buildCount += 1;
        return {archive: Buffer.from(`sb3-${buildCount}`)};
      },
      metadata: snapshot.metadata,
      sourceFiles: sourceFiles(),
    }),
    /not deterministic/u,
  );
});

test('writes and reads release candidate metadata and artifact atomically', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = Buffer.from('deterministic-sb3');
    const snapshot = await createSb3ReleaseSnapshot({
      artifact: {filename: 'example.sb3'},
      createSb3: async () => ({archive}),
      sourceFiles: sourceFiles(),
    });
    const metadataPath = path.join(directory, 'release-metadata/1.0.0.json');
    const artifactPath = path.join(directory, 'tmp/release-candidates/example.sb3');

    await writeSb3ReleaseCandidate({
      archive,
      artifactPath,
      metadata: snapshot.metadata,
      metadataPath,
    });

    assert.deepEqual(await readSb3ReleaseSnapshotMetadata(metadataPath), snapshot.metadata);
    assert.deepEqual(await readFile(artifactPath), archive);
    await assert.rejects(
      writeSb3ReleaseCandidate({
        archive: Buffer.from('tampered'),
        artifactPath,
        metadata: snapshot.metadata,
        metadataPath,
      }),
      /does not match metadata/u,
    );
  });
});

test('freezes and records published release snapshots with remote artifact verification', async () => {
  const archive = Buffer.from('deterministic-sb3');
  const snapshot = await createSb3ReleaseSnapshot({
    artifact: {
      filename: 'example.sb3',
      url: 'https://example.com/downloads/example.sb3',
    },
    createSb3: async () => ({archive}),
    sourceFiles: sourceFiles(),
  });
  const frozen = freezeSb3ReleaseSnapshot(snapshot.metadata);
  assert.equal(frozen.state, 'frozen');
  assert.throws(() => freezeSb3ReleaseSnapshot({...frozen, state: 'published'}), /Only candidate/u);

  const published = await recordPublishedSb3ReleaseSnapshot(
    frozen,
    {
      githubRelease: 'https://github.com/example/project/releases/tag/v1.0.0',
      npm: 'https://www.npmjs.com/package/example/v/1.0.0',
    },
    {fetchPublishedArtifact: async () => archive},
  );
  assert.equal(published.state, 'published');

  await assert.rejects(
    verifySb3ReleaseSnapshot({
      fetchPublishedArtifact: async () => Buffer.from('tampered'),
      metadata: published,
    }),
    /size is invalid|SHA-256 is invalid/u,
  );
});
