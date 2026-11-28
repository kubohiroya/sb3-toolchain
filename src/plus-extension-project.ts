// SPDX-License-Identifier: MPL-2.0
import {assert} from './assert';
import {readProjectManifest} from './project-extension-manifest';
import {validateExtensionArtifactLock} from './extension-artifact-lock';
import type {EmbeddedExtension, ProjectJson, UnknownRecord} from './types';

/** A deliberately narrow, lossless subset. Unsupported Plus projects remain explicit failures. */
export function readPlusExtensions(project: ProjectJson) {
  const manifest = readProjectManifest(project);
  if (!manifest) return [];
  assert(manifest.extensions.length > 0, 'Unsupported empty Plus manifest.');
  assert(Array.isArray(project.extensions), 'Plus extension IDs must be listed in the project.');
  const raw = (project.turboWarpPlus as UnknownRecord).extensions as UnknownRecord[];
  for (const spec of manifest.extensions) {
    const entry = raw.find((entry) => entry.id === spec.id)!;
    assert(
      spec.execution === 'sandboxed' && spec.artifactLockFormatVersion === 1,
      'Plus source roundtrip requires sandboxed extensions with artifact lock format 1.',
    );
    assert(
      spec.source.type === 'embedded-file' || spec.source.type === 'embedded-data',
      'Plus source roundtrip supports only embedded extensions.',
    );
    if (spec.source.type === 'embedded-file')
      assert(
        spec.source.path === `extensions/${spec.id}.js`,
        'Plus embedded file paths must use the canonical extension ID.',
      );
    assert(project.extensions.includes(spec.id), 'Plus manifest has an unlisted extension ID.');
    for (const name of ['capabilities', 'dependencies'])
      assert(
        entry[name] === undefined || (Array.isArray(entry[name]) && entry[name].length === 0),
        'Plus source roundtrip does not support capabilities or dependencies.',
      );
    for (const name of ['version', 'publisher'])
      assert(
        entry[name] === undefined ||
          (typeof entry[name] === 'string' && entry[name].length > 0 && entry[name].length <= 1024),
        'Invalid Plus extension metadata.',
      );
  }
  return manifest.extensions;
}

export function plusFilePaths(project: ProjectJson): Set<string> {
  return new Set(
    readPlusExtensions(project).flatMap((spec) =>
      spec.source.type === 'embedded-file' ? [spec.source.path] : [],
    ),
  );
}

/** Bind the retained manifest, storage, execution mode and receipt to the actual immutable bytes. */
export function validatePlusArtifacts(
  project: ProjectJson,
  extensions: readonly EmbeddedExtension[],
  contents: ReadonlyMap<string, Uint8Array>,
): void {
  const specs = readPlusExtensions(project);
  if (specs.length) {
    assert(
      extensions.every(
        (extension) =>
          extension.artifactLock === undefined || specs.some((spec) => spec.id === extension.id),
      ),
      'Plus sidecar contains an orphan artifact lock.',
    );
    const document = {
      formatVersion: 1,
      extensions: extensions
        .filter((extension) => extension.artifactLock !== undefined)
        .map(({id, artifactLock}) => ({id, artifactLock})),
    };
    assert(
      new TextEncoder().encode(JSON.stringify(document)).length <= 1024 * 1024,
      'Plus artifact locks exceed the Loader size limit.',
    );
  }
  for (const spec of specs) {
    const extension = extensions.find((entry) => entry.id === spec.id);
    assert(extension?.artifactLock, 'Plus artifact lock is missing.');
    const bytes = contents.get(extension.path) ?? contents.get(extension.id);
    assert(
      bytes && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024,
      'Plus embedded bytes are missing or oversized.',
    );
    validateExtensionArtifactLock(extension.artifactLock, spec.id, bytes);
    const lock = extension.artifactLock;
    assert(lock.bundleSHA256 === spec.sha256, 'Plus manifest and artifact lock hash differ.');
    const execution =
      lock.provenance.kind === 'build'
        ? lock.provenance.receipt.execution
        : lock.provenance.distribution.execution;
    assert(execution === spec.execution, 'Plus manifest and artifact execution differ.');
  }
}
