// SPDX-License-Identifier: MPL-2.0

import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const [destination, ...checkouts] = process.argv.slice(2);
if (!destination || checkouts.length !== 3)
  throw new Error(
    'Usage: node scripts/prepare-module-owner-fixture.mjs NEW_DIRECTORY STRUCTURED_DATA_CHECKOUT YAML_JSON_CHECKOUT SCENE_RUNTIME_CHECKOUT',
  );
const root = path.resolve(destination);
await mkdir(root);
await mkdir(path.join(root, 'packages'));
const integrity = (bytes) => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const owners = [
  {
    id: 'kubohiroyastructureddata',
    package: '@kubohiroya/turbowarp-structured-data',
    artifact: 'dist/structured-data.js',
    unsandboxed: 'required',
  },
  {
    id: 'kubohiroyayamljson',
    package: '@kubohiroya/turbowarp-yaml-json',
    artifact: 'dist/turbowarp-yaml-json.js',
    unsandboxed: 'not-needed',
  },
  {
    id: 'kubohiroya3dsceneruntime',
    package: '@kubohiroya/turbowarp-3d-scene-runtime',
    artifact: 'dist/3d-scene-runtime.js',
    unsandboxed: 'required',
  },
];
const dependencies = {yaml: '2.9.1', '@kubohiroya/turbowarp-named-data': '0.4.0'};
const provenance = [];
for (const [index, owner] of owners.entries()) {
  const cwd = path.resolve(checkouts[index]);
  const metadata = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  if (metadata.name !== owner.package) throw new Error('Unexpected owner: ' + metadata.name);
  const {stdout: status} = await run('git', ['status', '--porcelain'], {cwd});
  if (status.trim()) throw new Error('Owner checkout must be clean: ' + cwd);
  const {stdout: revision} = await run('git', ['rev-parse', 'HEAD'], {cwd});
  await readFile(path.join(cwd, 'lib-module/src/bundle-module.js'));
  const previous = new Set(await readdir(path.join(root, 'packages')));
  await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', path.join(root, 'packages')],
    {cwd},
  );
  // Inspect the new file rather than parsing npm output that may contain prepare logs.
  const tarballs = (await readdir(path.join(root, 'packages'))).filter(
    (file) => file.endsWith('.tgz') && !previous.has(file),
  );
  if (tarballs.length !== 1)
    throw new Error('Expected one new packed owner artifact: ' + owner.package);
  const packed = {filename: tarballs[0]};
  dependencies[owner.package] = './packages/' + packed.filename;
  provenance.push({
    package: owner.package,
    version: metadata.version,
    commit: revision.trim(),
    tarballIntegrity: integrity(await readFile(path.join(root, 'packages', packed.filename))),
  });
}
await writeFile(
  path.join(root, 'package.json'),
  JSON.stringify(
    {name: 'sb3-module-owner-fixture', version: '1.0.0', private: true, dependencies},
    null,
    2,
  ),
);
// Install only fixed artifacts and their production dependencies; never run package lifecycle scripts.
await run(
  'npm',
  [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    path.join(root, 'cache'),
  ],
  {cwd: root},
);
const app = path.join(root, 'app');
await cp(new URL('../test/fixtures/minimal-source/', import.meta.url), app, {recursive: true});
await rm(path.join(app, 'extensions/example.js'));
const extensions = [];
for (const owner of owners) {
  const installed = path.join(root, 'node_modules', owner.package);
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  const classic = await readFile(path.join(installed, owner.artifact));
  const module = await readFile(path.join(installed, 'lib-module/src/bundle-module.js'));
  const file = 'extensions/' + owner.id + '.js';
  await writeFile(path.join(app, file), classic);
  extensions.push({
    id: owner.id,
    path: file,
    mediaType: 'text/javascript',
    parameters: [],
    encoding: 'base64',
    source: {
      provider: 'npm',
      package: owner.package,
      version: metadata.version,
      artifact: owner.artifact,
      integrity: integrity(classic),
      module: {
        artifact: 'lib-module/src/bundle-module.js',
        formatVersion: 1,
        integrity: integrity(module),
        unsandboxed: owner.unsandboxed,
      },
    },
  });
}
const manifest = {
  formatVersion: 1,
  extensions,
  extensionBundles: [
    {
      id: 'projectbundle',
      name: 'Shared YAML',
      members: owners.map((owner) => owner.id),
      blockEditorRegistrations: true,
      buildMode: 'module',
      sharedDependencies: {yaml: '2.9.1'},
    },
  ],
};
await writeFile(path.join(app, 'embedded-extensions.json'), JSON.stringify(manifest, null, 2));
const project = JSON.parse(await readFile(path.join(app, 'project.source.json'), 'utf8'));
project.extensions = owners.map((owner) => owner.id);
project.extensionURLs = Object.fromEntries(
  extensions.map((extension) => [extension.id, 'embedded-extension:' + extension.path]),
);
await writeFile(path.join(app, 'project.source.json'), JSON.stringify(project, null, 2));
await writeFile(path.join(root, 'owner-provenance.json'), JSON.stringify(provenance, null, 2));
process.stdout.write(JSON.stringify({sourceDirectory: app, provenance}, null, 2) + '\n');
