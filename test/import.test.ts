// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {strToU8, zipSync} from 'fflate';

import {parseCliArguments} from '../src/cli.js';
import {
  decodeExtensionDataUrl,
  extensionApiManifestIntegrity,
  extensionIntegrity,
  importSb3,
  validateArchiveEntryName,
  validateOutputDirectoryPath,
} from '../src/index.js';

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-import-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeSb3(filePath, entries) {
  await writeFile(filePath, zipSync(entries, {level: 0}));
}

function git(arguments_, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', arguments_, {cwd, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function initializeGitRepository(directory) {
  await git(['init', '--quiet'], directory);
  await git(['config', 'user.name', 'SB3 Import Test'], directory);
  await git(['config', 'user.email', 'sb3-import-test@example.invalid'], directory);
}

async function commitOutput(directory, message = 'track imported output') {
  await git(['add', 'app'], directory);
  await git(['commit', '--quiet', '-m', message], directory);
}

async function writeProjectSb3(filePath, extraProjectProperties = {}) {
  await writeSb3(filePath, {
    'project.json': strToU8(
      JSON.stringify({
        targets: [],
        extensionURLs: {},
        ...extraProjectProperties,
      }),
    ),
  });
}

test('imports assets and extracts embedded extensions without changing external URLs', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    const extensionSource = 'Scratch.extensions.register(new Example());\n';
    const project = {
      targets: [],
      extensionURLs: {
        custom: `data:text/javascript;charset=utf-8;base64,${Buffer.from(extensionSource).toString('base64')}`,
        external: 'https://extensions.turbowarp.org/Lily/AllMenus.js',
      },
      meta: {semver: '3.0.0'},
    };
    const asset = new Uint8Array([0, 1, 2, 254, 255]);
    await writeSb3(inputPath, {
      'project.json': strToU8(JSON.stringify(project)),
      'asset.svg': asset,
    });

    const result = await importSb3({inputPath, outputDirectory});

    assert.deepEqual(result, {
      archiveEntryCount: 2,
      assetCount: 1,
      embeddedExtensionCount: 1,
      changed: true,
      differenceCounts: null,
      inputPath,
      outputDirectory,
      rollbackCleanupWarning: null,
    });
    const importedProjectText = await readFile(
      path.join(outputDirectory, 'project.source.json'),
      'utf8',
    );
    const importedProject = JSON.parse(importedProjectText);
    assert.equal(importedProjectText.endsWith('\n'), true);
    assert.equal(importedProject.extensionURLs.custom, 'embedded-extension:extensions/custom.js');
    assert.equal(importedProject.extensionURLs.external, project.extensionURLs.external);
    assert.equal(
      await readFile(path.join(outputDirectory, 'extensions/custom.js'), 'utf8'),
      extensionSource,
    );
    assert.deepEqual(
      await readFile(path.join(outputDirectory, 'assets/asset.svg')),
      Buffer.from(asset),
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(outputDirectory, 'embedded-extensions.json'), 'utf8')),
      {
        formatVersion: 1,
        extensions: [
          {
            id: 'custom',
            path: 'extensions/custom.js',
            mediaType: 'text/javascript',
            parameters: ['charset=utf-8'],
            encoding: 'base64',
          },
        ],
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(outputDirectory, 'sb3-source.json'), 'utf8')),
      {
        formatVersion: 1,
        project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json',
        assetsDirectory: 'assets',
        archiveEntries: ['project.json', 'asset.svg'],
      },
    );
  });
});

test('leaves an identical existing output unchanged without Git or confirmation', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    let confirmationCalled = false;

    const result = await importSb3({
      inputPath,
      outputDirectory,
      confirmReplace: async () => {
        confirmationCalled = true;
        return false;
      },
    });

    assert.equal(result.changed, false);
    assert.deepEqual(result.differenceCounts, {added: 0, modified: 0, removed: 0});
    assert.equal(confirmationCalled, false);
  });
});

test('preserves managed extension source metadata during import and rejects content drift', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    const extensionSource =
      '// Name: Managed\n// ID: managed\nScratch.extensions.register(new Managed());\n';
    await writeProjectSb3(inputPath, {
      extensionURLs: {
        managed: `data:text/javascript;base64,${Buffer.from(extensionSource).toString('base64')}`,
      },
    });
    await importSb3({inputPath, outputDirectory});

    const manifestPath = path.join(outputDirectory, 'embedded-extensions.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const apiManifestContents = Buffer.from(
      `${JSON.stringify({formatVersion: 1, id: 'managed', blocks: [], menus: []}, null, 2)}\n`,
    );
    manifest.extensions[0].source = {
      provider: 'github',
      repository: 'example/managed-extension',
      ref: 'main',
      resolvedCommit: '1234567890abcdef1234567890abcdef12345678',
      artifact: 'dist/managed.js',
      integrity: extensionIntegrity(Buffer.from(extensionSource)),
      apiManifest: {
        artifact: 'dist/extension-manifest.json',
        formatVersion: 1,
        integrity: extensionApiManifestIntegrity(apiManifestContents),
        path: 'extensions/managed.manifest.json',
      },
    };
    await Promise.all([
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
      writeFile(
        path.join(outputDirectory, 'extensions/managed.manifest.json'),
        apiManifestContents,
      ),
    ]);
    await commitOutput(directory);

    const unchanged = await importSb3({inputPath, outputDirectory});
    assert.equal(unchanged.changed, false);
    assert.deepEqual(
      JSON.parse(await readFile(manifestPath, 'utf8')).extensions[0].source,
      manifest.extensions[0].source,
    );
    assert.deepEqual(
      await readFile(path.join(outputDirectory, 'extensions/managed.manifest.json')),
      apiManifestContents,
    );

    const changedExtensionSource =
      '// Name: Managed\n// ID: managed\nScratch.extensions.register(new ManagedV2());\n';
    await writeProjectSb3(inputPath, {
      extensionURLs: {
        managed: `data:text/javascript;base64,${Buffer.from(changedExtensionSource).toString('base64')}`,
      },
    });
    await assert.rejects(importSb3({inputPath, outputDirectory, yes: true}), /integrity mismatch/u);
    assert.equal(
      await readFile(path.join(outputDirectory, 'extensions/managed.js'), 'utf8'),
      extensionSource,
    );
  });
});

test('validates a matching API manifest path before reading it', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    const extensionSource =
      '// Name: Managed\n// ID: managed\nScratch.extensions.register(new Managed());\n';
    await writeProjectSb3(inputPath, {
      extensionURLs: {
        managed: `data:text/javascript;base64,${Buffer.from(extensionSource).toString('base64')}`,
      },
    });
    await importSb3({inputPath, outputDirectory});

    const manifestPath = path.join(outputDirectory, 'embedded-extensions.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.extensions[0].source = {
      provider: 'github',
      repository: 'example/managed-extension',
      ref: 'main',
      resolvedCommit: '1'.repeat(40),
      artifact: 'dist/managed.js',
      integrity: extensionIntegrity(Buffer.from(extensionSource)),
      apiManifest: {
        artifact: 'dist/extension-manifest.json',
        formatVersion: 1,
        integrity: `sha256-${'A'.repeat(43)}=`,
        path: '../outside.json',
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await commitOutput(directory);

    await assert.rejects(
      importSb3({inputPath, outputDirectory, yes: true}),
      /API manifest path must match its ID/u,
    );
  });
});

test('does not read API manifest metadata for an extension absent from the imported SB3', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});

    const manifestPath = path.join(outputDirectory, 'embedded-extensions.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.extensions.push({
      id: 'stale',
      path: 'extensions/stale.js',
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
      source: {
        provider: 'github',
        repository: 'example/stale-extension',
        ref: 'main',
        resolvedCommit: '1'.repeat(40),
        artifact: 'dist/stale.js',
        integrity: `sha256-${'A'.repeat(43)}=`,
        apiManifest: {
          artifact: 'dist/extension-manifest.json',
          formatVersion: 1,
          integrity: `sha256-${'A'.repeat(43)}=`,
          path: '../should-not-be-read.json',
        },
      },
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await commitOutput(directory);

    const result = await importSb3({inputPath, outputDirectory, yes: true});
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).extensions, []);
  });
});

test('replaces differing Git-clean output with --yes', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await commitOutput(directory);
    await writeProjectSb3(inputPath, {updated: true});

    const result = await importSb3({inputPath, outputDirectory, yes: true});

    assert.equal(result.changed, true);
    assert.deepEqual(result.differenceCounts, {added: 0, modified: 1, removed: 0});
    assert.deepEqual(
      JSON.parse(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')),
      {targets: [], extensionURLs: {}, updated: true},
    );
  });
});

test('shows candidate and Git comparison context and preserves clean output when declined', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await commitOutput(directory);
    await writeProjectSb3(inputPath, {updated: true});
    let confirmationContext;

    await assert.rejects(
      importSb3({
        inputPath,
        outputDirectory,
        confirmReplace: async (context) => {
          confirmationContext = context;
          return false;
        },
      }),
      /cancelled/u,
    );

    assert.equal(confirmationContext.outputDirectory, outputDirectory);
    assert.equal(confirmationContext.gitState.clean, true);
    assert.deepEqual(confirmationContext.comparison.differences, {
      added: [],
      modified: ['project.source.json'],
      removed: [],
    });
    assert.equal(
      JSON.parse(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')).updated,
      undefined,
    );
  });
});

test('refuses non-interactive replacement of differing output without --yes', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await commitOutput(directory);
    await writeProjectSb3(inputPath, {updated: true});

    await assert.rejects(
      importSb3({inputPath, outputDirectory}),
      /interactive confirmation or --yes/u,
    );
  });
});

test('refuses to discard uncommitted output changes with --yes alone', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await commitOutput(directory);
    await writeFile(path.join(outputDirectory, 'project.source.json'), '{"manual":true}\n');
    await git(['add', 'app/project.source.json'], directory);

    await assert.rejects(
      importSb3({inputPath, outputDirectory, yes: true}),
      /uncommitted Git changes/u,
    );
    assert.equal(
      await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8'),
      '{"manual":true}\n',
    );
  });
});

test('requires a separate explicit option to discard uncommitted output changes', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await commitOutput(directory);
    await writeFile(path.join(outputDirectory, 'project.source.json'), '{"manual":true}\n');
    await writeFile(path.join(outputDirectory, 'untracked.txt'), 'remove me');

    const result = await importSb3({
      discardLocalChanges: true,
      inputPath,
      outputDirectory,
      yes: true,
    });

    assert.equal(result.changed, true);
    await assert.rejects(readFile(path.join(outputDirectory, 'untracked.txt')), {code: 'ENOENT'});
    assert.deepEqual(
      JSON.parse(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')),
      {targets: [], extensionURLs: {}},
    );
  });
});

test('refuses to replace differing output that is not Git-managed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await writeProjectSb3(inputPath, {updated: true});

    await assert.rejects(
      importSb3({discardLocalChanges: true, inputPath, outputDirectory, yes: true}),
      /not tracked by Git/u,
    );
  });
});

test('refuses to replace an unrecognized directory with any override', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'unrelated');
    await writeProjectSb3(inputPath);
    await mkdir(outputDirectory);
    await writeFile(path.join(outputDirectory, 'marker.txt'), 'preserved');

    await assert.rejects(
      importSb3({discardLocalChanges: true, inputPath, outputDirectory, yes: true}),
      /unrecognized directory/u,
    );
    assert.equal(await readFile(path.join(outputDirectory, 'marker.txt'), 'utf8'), 'preserved');
  });
});

test('reports an interrupted rollback before treating identical output as up to date', async () => {
  await withTemporaryDirectory(async (directory) => {
    await initializeGitRepository(directory);
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    const rollbackDirectory = path.join(directory, '.app.rollback-preserved');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await commitOutput(directory);
    await mkdir(rollbackDirectory);
    await writeFile(path.join(rollbackDirectory, 'marker.txt'), 'preserved');

    await assert.rejects(
      importSb3({inputPath, outputDirectory}),
      /interrupted SB3 import rollback/u,
    );
    assert.equal(await readFile(path.join(rollbackDirectory, 'marker.txt'), 'utf8'), 'preserved');
  });
});

test('rejects unsafe archive paths and preserves the existing output', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'unsafe.sb3');
    const outputDirectory = path.join(directory, 'app');
    await mkdir(outputDirectory);
    await writeFile(path.join(outputDirectory, 'marker.txt'), 'preserved');
    await writeSb3(inputPath, {
      'project.json': strToU8('{}'),
      '../escape.txt': strToU8('unsafe'),
    });

    await assert.rejects(importSb3({inputPath, outputDirectory}), /unsafe path segment/u);
    assert.equal(await readFile(path.join(outputDirectory, 'marker.txt'), 'utf8'), 'preserved');
    await assert.rejects(readFile(path.join(directory, 'escape.txt')), {code: 'ENOENT'});
  });
});

test('validates archive names, extension data URLs, and CLI arguments', () => {
  assert.deepEqual(parseCliArguments([]), {command: 'help'});
  assert.equal(validateArchiveEntryName('nested/asset.svg'), 'nested/asset.svg');
  for (const unsafeName of ['', '/absolute', 'C:/absolute', './asset', 'a/../asset', 'a\\asset']) {
    assert.throws(() => validateArchiveEntryName(unsafeName));
  }

  assert.equal(decodeExtensionDataUrl('data:text/javascript;base64,YQ').source.toString(), 'a');
  assert.equal(
    decodeExtensionDataUrl('data:text/javascript,let%20answer%20%3D%2042%3B').source.toString(),
    'let answer = 42;',
  );
  assert.throws(() => decodeExtensionDataUrl('data:text/javascript;base64,a'), /invalid base64/u);
  assert.throws(
    () => decodeExtensionDataUrl('data:text/javascript,%XY'),
    /invalid percent encoding/u,
  );

  assert.deepEqual(parseCliArguments(['--', '--help']), {command: 'help'});
  assert.deepEqual(
    parseCliArguments([
      'import',
      'project.sb3',
      '--output',
      'generated',
      '--yes',
      '--discard-local-changes',
    ]),
    {
      command: 'import',
      discardLocalChanges: true,
      inputPath: path.resolve('project.sb3'),
      outputDirectory: path.resolve('generated'),
      yes: true,
    },
  );
  assert.throws(
    () => parseCliArguments(['import', 'project.sb3', '--output']),
    /requires a value/u,
  );
  assert.throws(
    () => parseCliArguments(['import', 'project.sb3', '--output', 'app', '--force']),
    /intentionally unsupported/u,
  );
  assert.throws(
    () => parseCliArguments(['import', 'one.sb3', 'two.sb3', '--output', 'app']),
    /Only one input/u,
  );
});

test('rejects repository roots, ancestors, filesystem roots, and .git paths as output', () => {
  const protectedRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'project');
  assert.equal(
    validateOutputDirectoryPath(path.join(protectedRoot, 'app'), protectedRoot),
    path.join(protectedRoot, 'app'),
  );
  for (const dangerousPath of [
    path.parse(protectedRoot).root,
    protectedRoot,
    path.dirname(protectedRoot),
    path.join(protectedRoot, '.git'),
    path.join(protectedRoot, '.git', 'objects'),
  ]) {
    assert.throws(() => validateOutputDirectoryPath(dangerousPath, protectedRoot));
  }
});

test('rejects an embedded extension ID that cannot become a safe filename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'unsafe-extension.sb3');
    await writeSb3(inputPath, {
      'project.json': strToU8(
        JSON.stringify({
          targets: [],
          extensionURLs: {'../escape': 'data:text/javascript;base64,YQ=='},
        }),
      ),
    });

    await assert.rejects(
      importSb3({inputPath, outputDirectory: path.join(directory, 'app')}),
      /cannot be used as a filename/u,
    );
  });
});
