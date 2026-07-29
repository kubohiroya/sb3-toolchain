// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  createDeterministicSb3,
  extensionHeaderId,
  extensionIntegrity,
  validateExtensionSourceMetadata,
  validateManagedExtensionContents,
  validateSb3Source,
} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-extension-source-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function managedExtension(contents) {
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
      resolvedCommit: '1234567890abcdef1234567890abcdef12345678',
      artifact: 'dist/example.js',
      integrity: extensionIntegrity(contents),
    },
  };
}

test('computes extension integrity and reads Extension Gallery metadata', () => {
  const contents = Buffer.from('// Name: Example\n// ID: example\n');
  assert.equal(extensionHeaderId(contents), 'example');
  assert.equal(extensionHeaderId(Buffer.from('const id = "example";\n')), null);
  assert.match(extensionIntegrity(contents), /^sha256-[A-Za-z0-9+/]{43}=$/u);
  assert.deepEqual(validateManagedExtensionContents(managedExtension(contents), contents), {
    actualId: 'example',
    integrity: extensionIntegrity(contents),
    source: managedExtension(contents).source,
  });
});

test('validates managed GitHub extension metadata', () => {
  const contents = Buffer.from('// ID: example\n');
  const extension = managedExtension(contents);
  assert.equal(validateExtensionSourceMetadata({...extension, source: undefined}), null);
  assert.equal(validateExtensionSourceMetadata(extension), extension.source);

  for (const [property, value, message] of [
    ['provider', 'url', /provider/u],
    ['repository', '../escape', /repository/u],
    ['ref', 'bad ref', /Git ref/u],
    ['resolvedCommit', 'main', /40-character/u],
    ['artifact', '../example.js', /unsafe path segment/u],
    ['integrity', 'sha256-invalid', /SHA-256/u],
  ]) {
    assert.throws(
      () =>
        validateExtensionSourceMetadata({
          ...extension,
          source: {...extension.source, [property]: value},
        }),
      message,
    );
  }
});

test('rejects managed extension content or ID drift without changing unmanaged sources', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
    const extensionPath = path.join(sourceDirectory, 'extensions/example.js');
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const contents = Buffer.from(
      '// Name: Example\n// ID: example\nScratch.extensions.register(new ExampleExtension());\n',
    );
    await writeFile(extensionPath, contents);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.extensions[0] = managedExtension(contents);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const validated = await validateSb3Source(sourceDirectory);
    assert.equal(validated.extensions[0].source.integrity, extensionIntegrity(contents));
    await createDeterministicSb3(sourceDirectory);

    await writeFile(extensionPath, Buffer.concat([contents, Buffer.from('// drift\n')]));
    await assert.rejects(validateSb3Source(sourceDirectory), /integrity mismatch/u);

    const wrongIdContents = Buffer.from('// ID: another\n');
    manifest.extensions[0].source.integrity = extensionIntegrity(wrongIdContents);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(extensionPath, wrongIdContents);
    await assert.rejects(validateSb3Source(sourceDirectory), /header ID mismatch/u);
  });
});
