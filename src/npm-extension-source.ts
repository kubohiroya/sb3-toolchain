// SPDX-License-Identifier: MPL-2.0

import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

import {validateExtensionApiManifestSourceMetadata} from './extension-api-manifest.js';
import {extensionHeaderId, validateExtensionSourceMetadata} from './extension-dependencies.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function packageSegments(packageName) {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName];
}

async function findPackageDirectory(sourceDirectory, packageName) {
  let current = path.resolve(sourceDirectory);
  while (true) {
    const candidate = path.join(current, 'node_modules', ...packageSegments(packageName));
    try {
      await lstat(path.join(candidate, 'package.json'));
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Installed npm package was not found for managed extension: ${packageName}. Run the project's package manager install command.`,
  );
}

async function readPackageArtifact(packageDirectory, artifact, maximumBytes, description) {
  const [resolvedPackageDirectory, resolvedArtifact] = await Promise.all([
    realpath(packageDirectory),
    realpath(path.join(packageDirectory, ...artifact.split('/'))),
  ]);
  const relativeArtifact = path.relative(resolvedPackageDirectory, resolvedArtifact);
  assert(
    relativeArtifact !== '' &&
      relativeArtifact !== '..' &&
      !relativeArtifact.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeArtifact),
    `${description} resolves outside its npm package: ${artifact}`,
  );
  const stats = await lstat(resolvedArtifact);
  assert(stats.isFile(), `${description} must be a regular file: ${artifact}`);
  assert(stats.size <= maximumBytes, `${description} exceeds the ${maximumBytes}-byte limit.`);
  return readFile(resolvedArtifact);
}

export async function readNpmExtensionSource(
  extension,
  sourceDirectory,
  {allowVersionMismatch = false, maximumArtifactBytes, maximumManifestBytes},
) {
  const source = validateExtensionSourceMetadata(extension);
  assert(source?.provider === 'npm', `Extension is not managed by npm: ${extension.id}`);
  const packageDirectory = await findPackageDirectory(sourceDirectory, source.package);
  let packageManifest;
  try {
    packageManifest = JSON.parse(
      await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
    );
  } catch (error) {
    throw new Error(`Invalid package.json for npm extension ${extension.id}: ${error.message}`, {
      cause: error,
    });
  }
  assert(
    packageManifest?.name === source.package,
    `npm package name mismatch for extension ${extension.id}: expected ${source.package}, got ${packageManifest?.name ?? '(missing)'}`,
  );
  assert(
    typeof packageManifest.version === 'string' &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        packageManifest.version,
      ),
    `npm package has an invalid semantic version for extension ${extension.id}: ${packageManifest?.version ?? '(missing)'}`,
  );
  if (!allowVersionMismatch) {
    assert(
      packageManifest.version === source.version,
      `npm package version mismatch for extension ${extension.id}: expected ${source.version}, got ${packageManifest?.version ?? '(missing)'}`,
    );
  }
  const contents = await readPackageArtifact(
    packageDirectory,
    source.artifact,
    maximumArtifactBytes,
    `npm extension artifact for ${extension.id}`,
  );
  const actualId = extensionHeaderId(contents);
  assert(
    actualId === extension.id,
    `npm extension header ID mismatch for ${extension.id}: expected ${extension.id}, got ${actualId ?? '(missing)'}`,
  );
  const apiMetadata = validateExtensionApiManifestSourceMetadata(extension);
  const apiManifestContents = apiMetadata
    ? await readPackageArtifact(
        packageDirectory,
        apiMetadata.artifact,
        maximumManifestBytes,
        `npm extension API manifest for ${extension.id}`,
      )
    : null;
  return {apiManifestContents, contents, packageDirectory, version: packageManifest.version};
}
