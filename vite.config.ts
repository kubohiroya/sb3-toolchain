// SPDX-License-Identifier: MPL-2.0

import {builtinModules, createRequire} from 'node:module';

import {defineConfig} from 'vitest/config';
import dts from 'vite-plugin-dts';

const require = createRequire(import.meta.url);
const packageJson = require('./package.json') as {dependencies: Record<string, string>};

const externalModules = [
  ...Object.keys(packageJson.dependencies),
  '@kubohiroya/turbowarp-extension-manifest/distribution',
  '@kubohiroya/turbowarp-extension-manifest/resources',
  '@kubohiroya/turbowarp-extension-manifest/build-profile',
  '@kubohiroya/turbowarp-plus-editor-test/test-discovery',
  '@kubohiroya/turbowarp-plus-editor-test/junit',
  '@noble/hashes/legacy.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  'rolldown/parseAst',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist',
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        bin: 'src/bin.ts',
        browser: 'src/browser.ts',
        cli: 'src/cli.ts',
        index: 'src/index.ts',
        'standard-extension-build': 'src/standard-extension-build.ts',
        'web-distribution': 'src/web-distribution.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: externalModules,
      output: {
        banner: (chunk) => (chunk.name === 'bin' ? '#!/usr/bin/env node' : ''),
        entryFileNames: '[name].js',
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
  plugins: [
    dts({
      include: ['src'],
      outDirs: ['dist'],
      entryRoot: 'src',
      // Consumers that resolve modules as NodeNext need the extension on relative declaration imports.
      beforeWriteFile: (filePath, content) => ({
        filePath,
        content: content.replace(
          /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+?)(['"])/gu,
          (match, start: string, specifier: string, end: string) =>
            /\.[cm]?js$/u.test(specifier) ? match : `${start}${specifier}.js${end}`,
        ),
      }),
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
