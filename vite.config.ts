// SPDX-License-Identifier: MPL-2.0

import {builtinModules, createRequire} from 'node:module';

import {defineConfig} from 'vitest/config';
import dts from 'vite-plugin-dts';

const require = createRequire(import.meta.url);
const packageJson = require('./package.json') as {dependencies: Record<string, string>};

const externalModules = [
  ...Object.keys(packageJson.dependencies),
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
        cli: 'src/cli.ts',
        index: 'src/index.ts',
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
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
