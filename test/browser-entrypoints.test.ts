// SPDX-License-Identifier: MPL-2.0
import {builtinModules} from 'node:module';
import {rolldown} from 'rolldown';
import {expect, it} from 'vitest';

it.each(['src/browser.ts', 'src/web-distribution.ts', 'src/project-extensions.ts'])(
  'keeps Node and compiler code outside %s',
  async (input) => {
    const forbidden = new Set([...builtinModules, ...builtinModules.map((name) => 'node:' + name)]);
    const build = await rolldown({
      input,
      platform: 'browser',
      plugins: [
        {
          name: 'browser-boundary',
          resolveId(id) {
            if (
              forbidden.has(id) ||
              id === 'rolldown' ||
              id.startsWith('rolldown/') ||
              /(?:standard-extension-compiler|extension-build-job|github-extension-snapshot)/u.test(
                id,
              )
            )
              throw new Error('Node-only dependency in browser graph: ' + id);
          },
        },
      ],
    });
    try {
      const {output} = await build.generate({format: 'es'});
      expect(output.some((entry) => entry.type === 'chunk' && entry.isEntry)).toBe(true);
    } finally {
      await build.close();
    }
  },
);
