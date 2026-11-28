// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
// Tooling comes from a trusted Loader verification checkout, never an extension source directory.
assert(
  process.env.SB3_TOOLCHAIN_LOADER_ROOT,
  'Set the trusted Loader checkout used by verify-plus-loader-roundtrip.ts',
);
const dependencies = createRequire(
  path.join(process.env.SB3_TOOLCHAIN_LOADER_ROOT, 'package.json'),
);
const {build} = dependencies('esbuild');
const {chromium} = dependencies('playwright');
(async () => {
  const bundled = await build({
    entryPoints: [path.resolve('dist/browser.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'ToolchainBrowser',
    write: false,
    metafile: true,
  });
  const forbidden = Object.keys(bundled.metafile.inputs).filter((name) =>
    /extension-digest-inventory|standard-extension-compiler|extension-build-job|github-extension-snapshot/.test(
      name,
    ),
  );
  assert.deepEqual(forbidden, []);
  const args =
    process.platform === 'darwin'
      ? ['--single-process', '--no-zygote', '--disable-crash-reporter']
      : [];
  const browser = await chromium.launch({headless: true, args});
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.addScriptTag({content: bundled.outputFiles[0].text});
    const results = [];
    for (const storage of ['embedded-file', 'embedded-data']) {
      const bytes = [...(await readFile('dist/plus-loader-fixtures/' + storage + '.sb3'))];
      const result = await page.evaluate((bytes) => {
        const result = globalThis.ToolchainBrowser.unpackSb3(new Uint8Array(bytes));
        globalThis.ToolchainBrowser.validateSourceFiles(result.files);
        const project = JSON.parse(
          new TextDecoder().decode(result.files.get('project.source.json')),
        );
        const metadata = JSON.parse(
          new TextDecoder().decode(result.files.get('embedded-extensions.json')),
        );
        return {
          storage: project.turboWarpPlus.extensions[0].source.type,
          receipt: metadata.extensions[0].artifactLock.provenance.receipt.source,
          nodeGlobals: 'process' in globalThis || 'require' in globalThis,
        };
      }, bytes);
      assert.equal(result.storage, storage);
      assert.equal(result.nodeGlobals, false);
      assert.equal(result.receipt.commit, 'b4cd60ecf9f2a3094dc446bf1b99dabaeb89517a');
      results.push(result);
    }
    const evidence = {
      at: new Date().toISOString(),
      chromium: browser.version(),
      headless: true,
      externalRequestsBlocked: true,
      browserBundleBytes: bundled.outputFiles[0].contents.length,
      forbiddenImports: forbidden,
      results,
    };
    await writeFile('dist/plus-browser-roundtrip.json', JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
