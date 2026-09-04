// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const releaseSnapshotFormatVersion = 1;
const releaseSnapshotStates = new Set(['candidate', 'frozen', 'published']);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function asBuffer(contents, description) {
  if (Buffer.isBuffer(contents)) return contents;
  if (contents instanceof Uint8Array) return Buffer.from(contents);
  if (typeof contents === 'string') return Buffer.from(contents);
  throw new TypeError(`${description} must be a string, Buffer, or Uint8Array.`);
}

function normalizedSourceEntries(sourceFiles) {
  assert(sourceFiles instanceof Map, 'Release source files must be provided as a Map.');
  const entries = [...sourceFiles.entries()].map(([relativePath, contents]) => {
    assert(
      typeof relativePath === 'string' &&
        relativePath.length > 0 &&
        !path.isAbsolute(relativePath) &&
        !relativePath.split(/[\\/]+/u).includes('..'),
      `Release source path must be a safe relative path: ${relativePath}`,
    );
    return [relativePath.split(path.sep).join('/'), asBuffer(contents, relativePath)];
  });
  entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
  return entries;
}

export function computeReleaseSourceIdentity(sourceFiles) {
  const hash = createHash('sha256');
  for (const [relativePath, contents] of normalizedSourceEntries(sourceFiles)) {
    const pathBytes = Buffer.from(relativePath);
    hash.update(Buffer.from(`${pathBytes.byteLength}:`));
    hash.update(pathBytes);
    hash.update(Buffer.from(`:${contents.byteLength}:`));
    hash.update(contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function createSb3ReleaseSnapshotMetadata({
  artifact,
  metadata = {},
  publication = {},
  sourceFiles,
  state = 'candidate',
}) {
  assert(releaseSnapshotStates.has(state), `Unsupported SB3 release snapshot state: ${state}`);
  const archive = asBuffer(artifact.archive, 'SB3 release artifact archive');
  const filename = artifact.filename;
  assert(
    typeof filename === 'string' && filename.endsWith('.sb3'),
    'Artifact filename is required.',
  );
  const normalizedArtifact = {
    filename,
    sha256: sha256(archive),
    size: archive.byteLength,
  };
  if (artifact.url !== undefined) {
    const url = new URL(artifact.url);
    assert(url.protocol === 'https:', 'Artifact URL must use HTTPS.');
    normalizedArtifact.url = url.href;
  }
  return {
    formatVersion: releaseSnapshotFormatVersion,
    ...metadata,
    state,
    sourceIdentity: computeReleaseSourceIdentity(sourceFiles),
    artifact: normalizedArtifact,
    publication: {...publication},
  };
}

export function assertSb3ReleaseSnapshotMetadata(metadata) {
  assert(
    metadata?.formatVersion === releaseSnapshotFormatVersion,
    'SB3 release snapshot metadata format is invalid.',
  );
  assert(releaseSnapshotStates.has(metadata.state), 'SB3 release snapshot state is invalid.');
  assert(
    typeof metadata.sourceIdentity === 'string' &&
      /^sha256:[0-9a-f]{64}$/u.test(metadata.sourceIdentity),
    'SB3 release snapshot source identity is invalid.',
  );
  assert(
    typeof metadata.artifact?.filename === 'string' && metadata.artifact.filename.endsWith('.sb3'),
    'SB3 release snapshot artifact filename is invalid.',
  );
  assert(
    typeof metadata.artifact?.sha256 === 'string' &&
      /^[0-9a-f]{64}$/u.test(metadata.artifact.sha256),
    'SB3 release snapshot artifact SHA-256 is invalid.',
  );
  assert(
    Number.isSafeInteger(metadata.artifact?.size) && metadata.artifact.size > 0,
    'SB3 release snapshot artifact size is invalid.',
  );
  if (metadata.artifact.url !== undefined) {
    const url = new URL(metadata.artifact.url);
    assert(url.protocol === 'https:', 'SB3 release snapshot artifact URL must use HTTPS.');
  }
  if (metadata.publication?.urls !== undefined) {
    for (const [name, value] of Object.entries(metadata.publication.urls)) {
      const url = new URL(value);
      assert(
        url.protocol === 'https:',
        `SB3 release snapshot publication URL must use HTTPS: ${name}`,
      );
    }
  }
  return metadata;
}

export async function createSb3ReleaseSnapshot({
  artifact,
  createSb3,
  metadata,
  publication,
  sourceFiles,
  state,
}) {
  assert(typeof createSb3 === 'function', 'A createSb3 function is required.');
  const built = await createSb3();
  const archive = asBuffer(built.archive, 'SB3 release artifact archive');
  const snapshot = createSb3ReleaseSnapshotMetadata({
    artifact: {...artifact, archive},
    metadata,
    publication,
    sourceFiles,
    state,
  });
  return {archive, metadata: assertSb3ReleaseSnapshotMetadata(snapshot), sourceFiles};
}

export async function verifySb3ReleaseSnapshot(options) {
  const {createSb3, fetchPublishedArtifact, metadata, sourceFiles} = options;
  const snapshot = assertSb3ReleaseSnapshotMetadata(metadata);
  if (snapshot.state === 'published') {
    assert(
      typeof fetchPublishedArtifact === 'function',
      'A published artifact fetcher is required.',
    );
    const archive = asBuffer(
      await fetchPublishedArtifact(snapshot),
      'Published SB3 release artifact',
    );
    assert(
      archive.byteLength === snapshot.artifact.size,
      'Published SB3 release artifact size is invalid.',
    );
    assert(
      sha256(archive) === snapshot.artifact.sha256,
      'Published SB3 release artifact SHA-256 is invalid.',
    );
    return snapshot;
  }

  assert(
    computeReleaseSourceIdentity(sourceFiles) === snapshot.sourceIdentity,
    'SB3 release source changed. Update the release snapshot.',
  );
  assert(typeof createSb3 === 'function', 'A createSb3 function is required.');
  const [first, second] = await Promise.all([createSb3(), createSb3()]);
  const firstArchive = asBuffer(first.archive, 'First SB3 release artifact archive');
  const secondArchive = asBuffer(second.archive, 'Second SB3 release artifact archive');
  assert(
    firstArchive.equals(secondArchive),
    'SB3 release artifact generation is not deterministic.',
  );
  assert(
    sha256(firstArchive) === snapshot.artifact.sha256,
    'SB3 release artifact SHA-256 is stale.',
  );
  assert(firstArchive.byteLength === snapshot.artifact.size, 'SB3 release artifact size is stale.');
  return snapshot;
}

async function writeAtomically(filename, contents) {
  await mkdir(path.dirname(filename), {recursive: true});
  const temporaryPath = `${filename}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, filename);
  } catch (error) {
    await rm(temporaryPath, {force: true});
    throw error;
  }
}

export async function writeSb3ReleaseCandidate({artifactPath, archive, metadata, metadataPath}) {
  assertSb3ReleaseSnapshotMetadata(metadata);
  const artifactArchive = asBuffer(archive, 'SB3 release candidate archive');
  assert(
    sha256(artifactArchive) === metadata.artifact.sha256 &&
      artifactArchive.byteLength === metadata.artifact.size,
    'SB3 release candidate archive does not match metadata.',
  );
  await writeAtomically(artifactPath, artifactArchive);
  await writeAtomically(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return {artifactPath, metadataPath};
}

export function freezeSb3ReleaseSnapshot(metadata) {
  const snapshot = assertSb3ReleaseSnapshotMetadata(metadata);
  if (snapshot.state === 'frozen') return snapshot;
  assert(snapshot.state === 'candidate', 'Only candidate SB3 release snapshots can be frozen.');
  return assertSb3ReleaseSnapshotMetadata({...snapshot, state: 'frozen'});
}

export async function readSb3ReleaseSnapshotMetadata(metadataPath) {
  return assertSb3ReleaseSnapshotMetadata(JSON.parse(await readFile(metadataPath, 'utf8')));
}

export async function recordPublishedSb3ReleaseSnapshot(metadata, urls, options = {}) {
  const {fetchPublishedArtifact} = options;
  const snapshot = assertSb3ReleaseSnapshotMetadata(metadata);
  assert(snapshot.state === 'frozen', 'Only frozen SB3 release snapshots can be published.');
  const published = assertSb3ReleaseSnapshotMetadata({
    ...snapshot,
    state: 'published',
    publication: {
      ...snapshot.publication,
      urls,
    },
  });
  await verifySb3ReleaseSnapshot({
    fetchPublishedArtifact,
    metadata: published,
  });
  return published;
}
