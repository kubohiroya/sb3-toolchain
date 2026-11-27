// SPDX-License-Identifier: MPL-2.0
import {STANDARD_BUILD_PROFILE} from '@kubohiroya/turbowarp-extension-manifest/build-profile';

export function standardBuildFixture(settings: {id?: string; slug?: string} = {}) {
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
        ...settings,
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
