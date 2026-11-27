// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {SourceMap} from 'node:module';
import {runInNewContext} from 'node:vm';

import {describe, expect, it} from 'vitest';

import {buildStandardExtension} from '../src/standard-extension-build.js';
import {standardBuildFixture as fixture} from './standard-build-fixture';

describe('standard extension build', () => {
  it('reproduces an offline bundle, API, verified marker and original position from an input snapshot', async () => {
    const snapshot = fixture();
    const first = await buildStandardExtension(snapshot);
    const again = await buildStandardExtension(new Map([...snapshot].reverse()));
    expect(first).toEqual(again);
    const text = (name: string) => Buffer.from(first.files.get(name)!).toString();
    const marker = JSON.parse(text('extension-development.json'));
    expect(marker.id).toBe('recipefixture');
    expect(JSON.parse(text(marker.api.file)).blocks[0].opcode).toBe('greet');
    for (const artifact of [marker.bundle, marker.api, marker.sourceMap]) {
      expect(artifact.sha256).toBe(
        createHash('sha256').update(first.files.get(artifact.file)!).digest('hex'),
      );
    }
    const code = text(marker.bundle.file);
    expect(code).toMatch(/["']use strict["']/u);
    expect(code).not.toContain('sourceMappingURL=');
    const registered: Array<{greet(): string}> = [];
    runInNewContext(code, {
      Scratch: {extensions: {register: (item: never) => registered.push(item)}},
    });
    expect(registered).toHaveLength(1);
    expect(() => registered[0].greet()).toThrow('Hello, Scratch!');
    const payload = JSON.parse(text(marker.sourceMap.file));
    expect(payload.sourcesContent).toBeUndefined();
    expect(payload.sources).toEqual(['[external]', 'src/greeting.ts', 'src/index.ts']);
    const lines = code.split('\n');
    const generatedLine = lines.findIndex((line) => line.includes('throw new Error'));
    expect(
      new SourceMap(payload).findEntry(generatedLine, lines[generatedLine].indexOf('throw')),
    ).toMatchObject({originalSource: 'src/greeting.ts', originalLine: 2, originalColumn: 2});
  });

  it('rejects an extension ID that Scratch VM cannot register', async () => {
    await expect(buildStandardExtension(fixture({id: '7greet'}))).rejects.toThrow(
      'The extension ID must start with an ASCII letter',
    );
  });

  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9'])(
    'rejects the Windows device name %s before generating artifacts',
    async (slug) => {
      await expect(buildStandardExtension(fixture({slug}))).rejects.toThrow(
        'The extension slug is a reserved Windows device name',
      );
    },
  );

  it('allows slugs that merely start like a Windows device name', async () => {
    const build = await buildStandardExtension(fixture({slug: 'com10'}));
    expect(build.files.has('com10.js')).toBe(true);
  });

  it('allows require as a block method, property and local binding', async () => {
    const snapshot = fixture();
    snapshot.set(
      'src/block-definitions.json',
      Buffer.from(
        JSON.stringify({blocks: [{opcode: 'require', blockType: 'REPORTER', text: 'require'}]}),
      ),
    );
    snapshot.set(
      'src/index.ts',
      Buffer.from(`
        import {format} from './helper.js';
        const config = {require: 'hello'};
        const require = (value: string) => format(value);
        Scratch.extensions.register({require() { return require(config.require); }});
      `),
    );
    snapshot.set(
      'src/helper.js',
      Buffer.from('export const format = value => value.toUpperCase();'),
    );
    const build = await buildStandardExtension(snapshot);
    const registered: Array<{require(): string}> = [];
    runInNewContext(Buffer.from(build.files.get('recipe-fixture.js')!).toString(), {
      Scratch: {extensions: {register: (item: {require(): string}) => registered.push(item)}},
    });
    expect(registered[0].require()).toBe('HELLO');
  });

  it.each([
    ['direct TypeScript call', 'ts', 'return require(name);'],
    ['aliased JavaScript call', 'js', 'const load = require; return load(name);'],
  ])(
    'rejects an unbound CommonJS require used in a %s',
    async (_label, extension, implementation) => {
      const snapshot = fixture();
      snapshot.set(
        'src/index.ts',
        Buffer.from("import {greet} from './helper.js'; Scratch.extensions.register({greet});"),
      );
      snapshot.set(
        `src/helper.${extension}`,
        Buffer.from(`export function greet(name) { ${implementation} }`),
      );
      await expect(buildStandardExtension(snapshot)).rejects.toThrow('CommonJS require');
    },
  );

  it.each([
    "'node:fs'",
    "'https://example.test/module.js'",
    "'an-external-package'",
    "'../private.js'",
  ])('rejects imports outside the snapshot (%s)', async (specifier) => {
    const snapshot = fixture();
    snapshot.set(
      'src/index.ts',
      Buffer.from(`import ${specifier};\nScratch.extensions.register({});`),
    );
    await expect(buildStandardExtension(snapshot)).rejects.toThrow(
      /static relative|inside the source snapshot/u,
    );
  });

  it('rejects executable configuration and traversal before invoking the compiler', async () => {
    const snapshot = fixture();
    snapshot.set('vite.config.ts', Buffer.from("throw new Error('config ran');"));
    await expect(buildStandardExtension(snapshot)).rejects.toThrow('Unexpected or ambiguous file');
    snapshot.delete('vite.config.ts');
    snapshot.set('src/../passwords.js', Buffer.from('private'));
    await expect(buildStandardExtension(snapshot)).rejects.toThrow('Unexpected or ambiguous file');
  });

  it('rejects oversized source input before compilation', async () => {
    const snapshot = fixture();
    snapshot.set('src/index.ts', Buffer.alloc(1024 * 1024 + 1));
    await expect(buildStandardExtension(snapshot)).rejects.toThrow('exceeds its input limit');
  });

  it('keeps the extension entry unevaluated during the build and rejects late dynamic imports', async () => {
    const snapshot = fixture();
    const entry = snapshot.get('src/index.ts')!;
    snapshot.set(
      'src/index.ts',
      Buffer.concat([entry, Buffer.from("\nthrow new Error('runtime only');")]),
    );
    await expect(buildStandardExtension(snapshot)).resolves.toHaveProperty('files');
    snapshot.set(
      'src/index.ts',
      Buffer.concat([entry, Buffer.from('\nimport(globalThis.remoteSource);')]),
    );
    await expect(buildStandardExtension(snapshot)).rejects.toThrow(/dynamic imports/u);
  });

  it('rejects declared runtime resources until the host can carry the declaration', async () => {
    const snapshot = fixture();
    snapshot.set(
      'package.json',
      Buffer.from(
        JSON.stringify({
          turbowarpExtension: {
            resourceDeclaration: {
              schemaVersion: 1,
              resources: [
                {
                  type: 'network',
                  usage: 'required',
                  purpose: {en: 'Load test data'},
                  data: {direction: 'download', content: {en: 'Fixture'}},
                },
              ],
            },
          },
        }),
      ),
    );
    await expect(buildStandardExtension(snapshot)).rejects.toThrow('declared runtime resources');
  });
});
