// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const loader = process.env.SB3_TOOLCHAIN_LOADER_ROOT;
assert(loader, 'Set SB3_TOOLCHAIN_LOADER_ROOT to a trusted, built Loader #55 checkout');
const toolchain = path.resolve(import.meta.dirname, '..');
const importFile = (root: string, name: string) =>
  import(pathToFileURL(path.join(root, 'dist', name)).href);
const {buildStandardExtension, resolveGitHubExtensionSnapshot} = await importFile(
  toolchain,
  'standard-extension-build.js',
);
const {lockStandardExtensionBuild, createDeterministicSb3} = await importFile(
  toolchain,
  'index.js',
);
const {unpackSb3} = await importFile(toolchain, 'browser.js');
const {prepareExtensionAddition} = await importFile(loader, 'project-authoring.js');
const {prepareCatalogExtensionChanges} = await importFile(loader, 'project-catalog.js');
const {createProjectIO} = await importFile(loader, 'project-codec.js');
const Zip = createRequire(path.join(loader, 'package.json'))('@turbowarp/jszip');
const source = await resolveGitHubExtensionSnapshot(
  'https://github.com/kubohiroya/turbowarp-extension-template',
  {
    ref: 'v0.13.0',
    expectedCommit: 'b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a',
  },
);
const built = await buildStandardExtension(source.files, {source: source.source});
const artifactLock = lockStandardExtensionBuild(built);
const descriptor = JSON.parse(
  new TextDecoder().decode(built.files.get('extension-development.json')),
);
const bytes = built.files.get(descriptor.bundle.file);
let approvals = 0;
const ports = {
  trustProvider: {
    async authorize(spec: {sha256: string}) {
      approvals++;
      return {allowed: true, scope: 'digest', sha256: spec.sha256};
    },
  },
  fetcher: {
    async fetch(url: string) {
      return {bytes, finalURL: url, redirects: []};
    },
  },
};
const added = await prepareExtensionAddition(
  {targets: [{isStage: true, name: 'Stage', blocks: {}, costumes: [], sounds: []}], extensions: []},
  {id: descriptor.id, execution: 'sandboxed', source: {type: 'embedded-file'}, bytes, artifactLock},
  ports,
  {zip: Zip},
);
const results = [];
for (const storage of ['embedded-file', 'embedded-data']) {
  const candidate =
    storage === 'embedded-file'
      ? added
      : await prepareCatalogExtensionChanges(
          added.projectBytes,
          [
            {
              id: descriptor.id,
              url: 'https://example.test/fixture.js',
              execution: 'sandboxed',
              distribution: 'embedded-data',
            },
          ],
          ports,
          {zip: Zip},
        );
  const unpacked = unpackSb3(candidate.projectBytes);
  const fixtures = path.join(toolchain, 'dist/plus-loader-fixtures');
  await mkdir(fixtures, {recursive: true});
  await writeFile(path.join(fixtures, storage + '.sb3'), candidate.projectBytes);
  const root = await mkdtemp(path.join(tmpdir(), 'loader-plus-roundtrip-'));
  try {
    for (const [name, content] of unpacked.files) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), {recursive: true});
      await writeFile(file, content);
    }
    const rebuilt = await createDeterministicSb3(root);
    const io = createProjectIO({zip: Zip});
    const prepared = await io.prepare(rebuilt.archive);
    assert.equal(
      prepared.manifest.extensions.find((spec: {id: string}) => spec.id === descriptor.id).source
        .type,
      storage,
    );
    const restored = new Zip().file(
      'project.json',
      io.restoreJSON('{"targets":[]}', prepared.context),
    );
    io.restoreArchive(restored, prepared.context);
    const metadata = JSON.parse(
      await restored.file('tw-plus/extension-locks.json').async('string'),
    );
    assert.deepEqual(
      metadata.extensions.find((spec: {id: string}) => spec.id === descriptor.id).artifactLock,
      artifactLock,
    );
    assert.deepEqual(
      unpackSb3(rebuilt.archive).files.get('embedded-extensions.json'),
      unpacked.files.get('embedded-extensions.json'),
    );
    results.push({storage, receiptEqual: true, loaderReopened: true, sourceRoundtripEqual: true});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}
assert.equal(approvals, 2);
const evidence = {
  at: new Date().toISOString(),
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  loaderRevision: execFileSync('git', ['-C', loader, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  toolchainRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: toolchain,
    encoding: 'utf8',
  }).trim(),
  toolchainDirty:
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: toolchain,
      encoding: 'utf8',
    }).trim() !== '',
  source: source.source,
  compiler: built.receipt.compiler,
  results,
  approvals,
  validationScope:
    'Real public Template, Node compiler and Loader #55 APIs; no renderer or native Electron execution.',
};
await mkdir(path.join(toolchain, 'dist'), {recursive: true});
await writeFile(
  path.join(toolchain, 'dist/plus-loader-roundtrip.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
