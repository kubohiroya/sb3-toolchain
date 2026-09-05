// SPDX-License-Identifier: MPL-2.0

import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {strToU8, zipSync} from 'fflate';
import {expect, test} from 'vitest';

import {parseCliArguments} from '../src/cli';
import {
  decodeExtensionDataUrl,
  extensionApiManifestIntegrity,
  extensionIntegrity,
  importSb3,
  validateArchiveEntryName,
  validateOutputDirectoryPath,
} from '../src/index';
import type {OutputReplacementContext} from '../src/index';

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-import-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeSb3(filePath: string, entries: Record<string, Uint8Array>): Promise<void> {
  await writeFile(filePath, zipSync(entries, {level: 0}));
}

function git(arguments_: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', arguments_, {cwd, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, {stdout, stderr});
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function initializeGitRepository(directory: string): Promise<void> {
  await git(['init', '--quiet'], directory);
  await git(['config', 'user.name', 'SB3 Import Test'], directory);
  await git(['config', 'user.email', 'sb3-import-test@example.invalid'], directory);
}

async function commitOutput(directory: string, message = 'track imported output'): Promise<void> {
  await git(['add', 'app'], directory);
  await git(['commit', '--quiet', '-m', message], directory);
}

async function writeProjectSb3(
  filePath: string,
  extraProjectProperties: Record<string, unknown> = {},
): Promise<void> {
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

    expect(result).toStrictEqual({
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
    expect(importedProjectText.endsWith('\n')).toBe(true);
    expect(importedProject.extensionURLs.custom).toBe('embedded-extension:extensions/custom.js');
    expect(importedProject.extensionURLs.external).toBe(project.extensionURLs.external);
    expect(await readFile(path.join(outputDirectory, 'extensions/custom.js'), 'utf8')).toBe(
      extensionSource,
    );
    expect(await readFile(path.join(outputDirectory, 'assets/asset.svg'))).toStrictEqual(
      Buffer.from(asset),
    );
    expect(
      JSON.parse(await readFile(path.join(outputDirectory, 'embedded-extensions.json'), 'utf8')),
    ).toStrictEqual({
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
    });
    expect(
      JSON.parse(await readFile(path.join(outputDirectory, 'sb3-source.json'), 'utf8')),
    ).toStrictEqual({
      formatVersion: 1,
      project: 'project.source.json',
      embeddedExtensions: 'embedded-extensions.json',
      assetsDirectory: 'assets',
      archiveEntries: ['project.json', 'asset.svg'],
    });
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

    expect(result.changed).toBe(false);
    expect(result.differenceCounts).toStrictEqual({added: 0, modified: 0, removed: 0});
    expect(confirmationCalled).toBe(false);
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
    expect(unchanged.changed).toBe(false);
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).extensions[0].source).toStrictEqual(
      manifest.extensions[0].source,
    );
    expect(
      await readFile(path.join(outputDirectory, 'extensions/managed.manifest.json')),
    ).toStrictEqual(apiManifestContents);

    const changedExtensionSource =
      '// Name: Managed\n// ID: managed\nScratch.extensions.register(new ManagedV2());\n';
    await writeProjectSb3(inputPath, {
      extensionURLs: {
        managed: `data:text/javascript;base64,${Buffer.from(changedExtensionSource).toString('base64')}`,
      },
    });
    await expect(importSb3({inputPath, outputDirectory, yes: true})).rejects.toThrow(
      /integrity mismatch/u,
    );
    expect(await readFile(path.join(outputDirectory, 'extensions/managed.js'), 'utf8')).toBe(
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

    await expect(importSb3({inputPath, outputDirectory, yes: true})).rejects.toThrow(
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
    expect(result.changed).toBe(true);
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).extensions).toStrictEqual([]);
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

    expect(result.changed).toBe(true);
    expect(result.differenceCounts).toStrictEqual({added: 0, modified: 1, removed: 0});
    expect(
      JSON.parse(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')),
    ).toStrictEqual({targets: [], extensionURLs: {}, updated: true});
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
    let confirmationContext: OutputReplacementContext | undefined;

    await expect(
      importSb3({
        inputPath,
        outputDirectory,
        confirmReplace: async (context) => {
          confirmationContext = context;
          return false;
        },
      }),
    ).rejects.toThrow(/cancelled/u);

    expect(confirmationContext?.outputDirectory).toBe(outputDirectory);
    expect(confirmationContext?.gitState.clean).toBe(true);
    expect(confirmationContext?.comparison.differences).toStrictEqual({
      added: [],
      modified: ['project.source.json'],
      removed: [],
    });
    expect(
      JSON.parse(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')).updated,
    ).toBe(undefined);
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

    await expect(importSb3({inputPath, outputDirectory})).rejects.toThrow(
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

    await expect(importSb3({inputPath, outputDirectory, yes: true})).rejects.toThrow(
      /uncommitted Git changes/u,
    );
    expect(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')).toBe(
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

    expect(result.changed).toBe(true);
    await expect(readFile(path.join(outputDirectory, 'untracked.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      JSON.parse(await readFile(path.join(outputDirectory, 'project.source.json'), 'utf8')),
    ).toStrictEqual({targets: [], extensionURLs: {}});
  });
});

test('refuses to replace differing output that is not Git-managed', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'app');
    await writeProjectSb3(inputPath);
    await importSb3({inputPath, outputDirectory});
    await writeProjectSb3(inputPath, {updated: true});

    await expect(
      importSb3({discardLocalChanges: true, inputPath, outputDirectory, yes: true}),
    ).rejects.toThrow(/not tracked by Git/u);
  });
});

test('refuses to replace an unrecognized directory with any override', async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = path.join(directory, 'input.sb3');
    const outputDirectory = path.join(directory, 'unrelated');
    await writeProjectSb3(inputPath);
    await mkdir(outputDirectory);
    await writeFile(path.join(outputDirectory, 'marker.txt'), 'preserved');

    await expect(
      importSb3({discardLocalChanges: true, inputPath, outputDirectory, yes: true}),
    ).rejects.toThrow(/unrecognized directory/u);
    expect(await readFile(path.join(outputDirectory, 'marker.txt'), 'utf8')).toBe('preserved');
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

    await expect(importSb3({inputPath, outputDirectory})).rejects.toThrow(
      /interrupted SB3 import rollback/u,
    );
    expect(await readFile(path.join(rollbackDirectory, 'marker.txt'), 'utf8')).toBe('preserved');
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

    await expect(importSb3({inputPath, outputDirectory})).rejects.toThrow(/unsafe path segment/u);
    expect(await readFile(path.join(outputDirectory, 'marker.txt'), 'utf8')).toBe('preserved');
    await expect(readFile(path.join(directory, 'escape.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

test('validates archive names, extension data URLs, and CLI arguments', () => {
  expect(parseCliArguments([])).toStrictEqual({command: 'help'});
  expect(validateArchiveEntryName('nested/asset.svg')).toBe('nested/asset.svg');
  for (const unsafeName of ['', '/absolute', 'C:/absolute', './asset', 'a/../asset', 'a\\asset']) {
    expect(() => validateArchiveEntryName(unsafeName)).toThrow();
  }

  expect(decodeExtensionDataUrl('data:text/javascript;base64,YQ').source.toString()).toBe('a');
  expect(
    decodeExtensionDataUrl('data:text/javascript,let%20answer%20%3D%2042%3B').source.toString(),
  ).toBe('let answer = 42;');
  expect(() => decodeExtensionDataUrl('data:text/javascript;base64,a')).toThrow(/invalid base64/u);
  expect(() => decodeExtensionDataUrl('data:text/javascript,%XY')).toThrow(
    /invalid percent encoding/u,
  );

  expect(parseCliArguments(['--', '--help'])).toStrictEqual({command: 'help'});
  expect(
    parseCliArguments([
      'import',
      'project.sb3',
      '--output',
      'generated',
      '--yes',
      '--discard-local-changes',
    ]),
  ).toStrictEqual({
    command: 'import',
    discardLocalChanges: true,
    inputPath: path.resolve('project.sb3'),
    outputDirectory: path.resolve('generated'),
    yes: true,
  });
  expect(() => parseCliArguments(['import', 'project.sb3', '--output'])).toThrow(
    /requires a value/u,
  );
  expect(() => parseCliArguments(['import', 'project.sb3', '--output', 'app', '--force'])).toThrow(
    /intentionally unsupported/u,
  );
  expect(() => parseCliArguments(['import', 'one.sb3', 'two.sb3', '--output', 'app'])).toThrow(
    /Only one input/u,
  );
});

test('rejects repository roots, ancestors, filesystem roots, and .git paths as output', () => {
  const protectedRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'project');
  expect(validateOutputDirectoryPath(path.join(protectedRoot, 'app'), protectedRoot)).toBe(
    path.join(protectedRoot, 'app'),
  );
  for (const dangerousPath of [
    path.parse(protectedRoot).root,
    protectedRoot,
    path.dirname(protectedRoot),
    path.join(protectedRoot, '.git'),
    path.join(protectedRoot, '.git', 'objects'),
  ]) {
    expect(() => validateOutputDirectoryPath(dangerousPath, protectedRoot)).toThrow();
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

    await expect(
      importSb3({inputPath, outputDirectory: path.join(directory, 'app')}),
    ).rejects.toThrow(/cannot be used as a filename/u);
  });
});
