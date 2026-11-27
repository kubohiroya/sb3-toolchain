import {rolldown} from 'rolldown';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
const bundle = await rolldown({
  input: 'src/web-distribution.ts',
  platform: 'browser',
  plugins: [
    {
      name: 'no-node',
      resolveId(id) {
        if (id.startsWith('node:') || id === 'rolldown' || id.startsWith('rolldown/'))
          throw new Error('Node code in browser graph: ' + id);
      },
    },
  ],
});
const {output} = await bundle.generate({format: 'es'});
await bundle.close();
const code = output.find((x) => x.type === 'chunk').code;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/entry.js' ? 'application/javascript' : 'text/html');
  res.end(req.url === '/entry.js' ? code : '<!doctype html><title>Distribution CORS test</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({headless: true, ignoreDefaultArgs: ['--no-sandbox']});
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  const results = await page.evaluate(async () => {
    const {resolvePublishedExtension} = await import('/entry.js');
    const rows = [];
    for (const reference of [
      '@kubohiroya/turbowarp-extension-template@0.13.0',
      'https://github.com/kubohiroya/turbowarp-extension-template/releases/tag/v0.13.0',
      'https://github.com/kubohiroya/turbowarp-extension-template',
    ]) {
      try {
        const candidate = await resolvePublishedExtension(reference);
        rows.push({
          reference,
          status: 'ok',
          source: candidate.source,
          bundleBytes: candidate.bytes.length,
          measurements: candidate.measurements,
        });
      } catch (error) {
        rows.push({
          reference,
          status: 'failed',
          code: error.code,
          message: error.message,
          cause: error.cause?.message,
        });
      }
    }
    const cors = [];
    for (const url of [
      'https://registry.npmjs.org/@kubohiroya%2Fturbowarp-extension-template/0.13.0',
      'https://github.com/kubohiroya/turbowarp-extension-template/releases/download/v0.13.0/extension-package.json',
    ]) {
      try {
        const response = await fetch(url, {credentials: 'omit'});
        cors.push({url, status: response.status, bytes: (await response.arrayBuffer()).byteLength});
      } catch (error) {
        cors.push({url, error: error.message});
      }
    }
    return {rows, cors};
  });
  const evidence = {
    at: new Date().toISOString(),
    browser: await browser.version(),
    browserSecurityDisabled: false,
    ...results,
    consoleErrors,
  };
  await mkdir('tmp', {recursive: true});
  await writeFile('tmp/cors-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
  if (results.rows.some((row) => row.status !== 'ok')) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
