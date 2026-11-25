// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {SourceMap} from 'node:module';
import {runInNewContext} from 'node:vm';

import {STANDARD_BUILD_PROFILE} from '@kubohiroya/turbowarp-extension-manifest/build-profile';
import {describe, expect, it} from 'vitest';

import {buildStandardExtension} from '../src/standard-extension-build.js';

function fixture() {
  return new Map(
    Object.entries({
      'extension-build.json': JSON.stringify(STANDARD_BUILD_PROFILE),
      'package.json': JSON.stringify({
        scripts: {prepare: 'node ./must-not-run.js', build: 'node ./must-not-run.js'},
      }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'src/extension-config.json': JSON.stringify({
        id: 'recipefixture',
        slug: 'recipe-fixture',
        name: 'Recipe Fixture',
        description: 'A source build fixture.',
        author: 'Fixture',
        license: 'MPL-2.0',
        unsandboxed: false,
        docsURI: 'https://example.test/fixture',
        blockIconURI: 'data:image/svg+xml;base64,PHN2Zy8+',
      }),
      'src/block-definitions.json': JSON.stringify({
        blocks: [{opcode: 'greet', blockType: 'REPORTER', text: 'greet'}],
      }),
      'src/index.ts':
        "import {greeting} from './greeting.js';\nScratch.extensions.register({greet: greeting});",
      'src/greeting.ts':
        "import message from './message.json' with {type: 'json'};\nexport function greeting(): string {\n  throw new Error(message.text);\n}",
      'src/message.json': JSON.stringify({text: 'Hello, Scratch!'}),
    }).map(([file, content]) => [file, Buffer.from(content)]),
  );
}

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
