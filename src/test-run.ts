// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

import {discoverTests} from '@kubohiroya/turbowarp-plus-editor-test/test-discovery';
import type {TestRunReport} from '@kubohiroya/turbowarp-plus-editor-test/test-runner';
import {strFromU8, unzipSync} from 'fflate';

import {validateArchiveEntryName} from './archive';
import {assert} from './assert';
import {isObject} from './source-format';

const projectLimit = 64 * 1024 * 1024;
const testId = 'kubohiroyatest';
const trustedPath = 'extensions/turbowarp-test.js';
const testURL = 'https://kubohiroya.github.io/turbowarp-test/dist/turbowarp-test.js';
const catalogURL = 'https://kubohiroya.github.io/turbowarp-plus-packages/extensions-v1.json';
// turbowarp-test fc707c50, the same bytes used by the Editor's pinned TypeScript-loop E2E.
const sha256 = '7f6541ce906594cde7d02498c65e8a800f0c194a924d288f9de4d702e738d868';
const origin = 'http://127.0.0.1';
const prefix = '/turbowarp-plus-editor/';
const driverURL = `${origin}${prefix}cli-test-run.html`;
const timeout = 30_000;
type AttributedReport = TestRunReport & {builds?: Array<{extensionId: string; sha256: string}>};

/** The parent driver and the child frame may not navigate to devices or external addresses. */
export function allowsEditorNavigation(url: string, child: boolean): boolean {
  if (!child) return url === driverURL;
  return (
    url === origin + prefix + 'test-frame.html' ||
    url === 'about:blank' ||
    url === 'about:srcdoc' ||
    url.startsWith(`blob:${origin}/`)
  );
}

async function readInput(input: string): Promise<Buffer> {
  const stats = await lstat(input);
  assert(
    stats.isFile() && path.extname(input).toLowerCase() === '.sb3',
    'Expected a regular .sb3 file.',
  );
  assert(stats.size <= projectLimit, 'SB3 exceeds the 64 MiB size limit.');
  return readFile(input);
}

/** Fail before launching Chromium unless the SB3 carries exactly the approved, embedded test extension. */
async function checkedArchive(
  input: string,
  only: readonly string[] | undefined,
  allowed: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const archive = await readInput(input);
  const paths = new Set<string>();
  let expanded = 0;
  const entries = unzipSync(archive, {
    filter({name, originalSize}) {
      validateArchiveEntryName(name);
      assert(!paths.has(name), `Duplicate SB3 entry: ${name}`);
      paths.add(name);
      expanded += originalSize;
      assert(paths.size <= 4096 && expanded <= 256 * 1024 * 1024, 'SB3 expansion limit exceeded.');
      return name === 'project.json';
    },
  });
  assert(Object.hasOwn(entries, 'project.json'), 'SB3 archive does not contain project.json.');
  const project: unknown = JSON.parse(strFromU8(entries['project.json']));
  assert(isObject(project), 'Expected a project object.');
  const manifest = project.turboWarpPlus;
  const urls = project.extensionURLs;
  assert(
    urls === undefined || (isObject(urls) && Object.keys(urls).length === 0),
    'Legacy extension URLs are not supported by the offline CLI runner.',
  );
  assert(!allowed.has(testId) && allowed.size <= 32, 'Invalid sandboxed extension grants.');
  const expected = new Map([...allowed, [testId, sha256]]);
  const extensions: unknown = project.extensions;
  assert(
    Array.isArray(extensions) &&
      extensions.length === expected.size &&
      new Set(extensions).size === expected.size &&
      extensions.every((id) => expected.has(id)),
    allowed.size
      ? 'Project extensions do not match the exact CLI grants.'
      : 'The offline CLI runner supports only the pinned TurboWarp Test extension.',
  );
  assert(
    isObject(manifest) &&
      manifest.schemaVersion === 1 &&
      Array.isArray(manifest.extensions) &&
      manifest.extensions.length === expected.size,
    'Managed extensions do not match the exact CLI grants.',
  );
  const digests = new Map<string, string>();
  const ids = new Set<string>();
  for (const spec of manifest.extensions as unknown[]) {
    assert(
      isObject(spec) && typeof spec.id === 'string' && expected.has(spec.id) && !ids.has(spec.id),
      'Unknown or repeated managed extension ID.',
    );
    ids.add(spec.id);
    assert(
      spec.sha256 === expected.get(spec.id) &&
        spec.execution === (spec.id === testId ? 'unsandboxed' : 'sandboxed') &&
        isObject(spec.source) &&
        spec.source.type === 'embedded-file' &&
        typeof spec.source.path === 'string' &&
        Object.keys(spec.source).every((key) => key === 'type' || key === 'path') &&
        (spec.dependencies === undefined ||
          (Array.isArray(spec.dependencies) && spec.dependencies.length === 0)) &&
        (spec.capabilities === undefined ||
          (Array.isArray(spec.capabilities) && spec.capabilities.length === 0)),
      'The embedded extension metadata does not match the approved pinned build and sandbox mode.',
    );
    const file = spec.source.path;
    assert(
      file.startsWith('extensions/') &&
        file.endsWith('.js') &&
        paths.has(file) &&
        !digests.has(file) &&
        (spec.id !== testId || file === trustedPath),
      'Invalid or duplicate embedded extension path.',
    );
    digests.set(file, expected.get(spec.id)!);
  }
  const code = unzipSync(archive, {filter: ({name}) => digests.has(name)});
  for (const [file, digest] of digests) {
    assert(
      Object.hasOwn(code, file) && createHash('sha256').update(code[file]).digest('hex') === digest,
      `The embedded test extension bytes do not match their approved digest: ${file}`,
    );
  }

  const {tests} = discoverTests(project);
  assert(tests.length > 0, 'No tests were found in this project.');
  for (const address of only ?? []) {
    assert(
      tests.some((item) => item.address === address),
      `No test at ${address}.`,
    );
  }
  return archive;
}

export async function runProjectTests(
  input: string,
  editorDirectory: string,
  revision: string,
  only?: string[],
  allowed: ReadonlyMap<string, string> = new Map(),
): Promise<TestRunReport> {
  const archive = await checkedArchive(input, only, allowed);
  const build = await realpath(editorDirectory);
  const metadata: unknown = JSON.parse(await readFile(path.join(build, 'build-info.json'), 'utf8'));
  assert(
    isObject(metadata) &&
      metadata.siteRepository === 'https://github.com/kubohiroya/turbowarp-plus-editor' &&
      metadata.siteRevision === revision,
    'The built Editor does not match --editor-revision.',
  );
  const {chromium} = await import('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-swiftshader',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  });
  try {
    const context = await browser.newContext({serviceWorkers: 'block'});
    await context.routeWebSocket('**/*', (socket) => socket.close());
    await context.route('**/*', async (route) => {
      if (route.request().method() !== 'GET') return route.abort();
      const url = new URL(route.request().url());
      if (
        route.request().isNavigationRequest() &&
        url.href !== driverURL &&
        url.href !== origin + prefix + 'test-frame.html'
      )
        return route.abort();
      if (url.href === catalogURL)
        return route.fulfill({
          json: {
            schemaVersion: 1,
            extensions: [
              {
                id: testId,
                url: testURL,
                sha256,
                name: 'Test',
                version: '0.1.0',
                unsandboxed: 'required',
                dependencies: [],
                description: 'Test hats and assertions',
                license: 'MPL-2.0',
              },
            ],
          },
          headers: {'access-control-allow-origin': '*'},
        });
      if (url.origin !== origin || !url.pathname.startsWith(prefix)) return route.abort();
      if (url.href === driverURL)
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>SB3 test driver</title>',
        });
      try {
        const file = await realpath(
          path.resolve(build, decodeURIComponent(url.pathname.slice(prefix.length))),
        );
        if (!file.startsWith(build + path.sep) || !(await lstat(file)).isFile())
          return route.abort();
        return route.fulfill({path: file});
      } catch {
        return route.fulfill({status: 404});
      }
    });
    const page = await context.newPage();
    let disallowedNavigation: string | undefined;
    context.on('page', (popup) => {
      disallowedNavigation = 'popup';
      void popup.close().catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      const url = frame.url();
      const child = frame !== page.mainFrame();
      if (!allowsEditorNavigation(url, child)) {
        disallowedNavigation = new URL(url).protocol;
        void page.close().catch(() => {});
      }
    });
    await page.goto(driverURL, {timeout});
    // Browser code is static. Only bytes and selected addresses cross into the installed Editor frame.
    const runFrame = ({
      data,
      only,
      origin,
      prefix,
      timeout,
    }: {
      data: string;
      only?: string[];
      origin: string;
      prefix: string;
      timeout: number;
    }) =>
      new Promise<AttributedReport>((resolve, reject) => {
        type Incoming = {
          origin: string;
          source: unknown;
          data?: {type?: string; id?: string; report?: AttributedReport; message?: string};
        };
        type Frame = {
          src: string;
          contentWindow?: {postMessage(message: unknown, origin: string): void};
          remove(): void;
        };
        const view = globalThis as unknown as {
          document: {createElement(tag: 'iframe'): Frame; body: {append(frame: Frame): void}};
          addEventListener(name: 'message', listener: (event: Incoming) => void): void;
          removeEventListener(name: 'message', listener: (event: Incoming) => void): void;
        };
        const frame = view.document.createElement('iframe');
        frame.src = origin + prefix + 'test-frame.html';
        const timer = setTimeout(
          () => finish(new Error('Timed out waiting for the Editor test frame.')),
          timeout,
        );
        const finish = (error: Error | null, report?: AttributedReport) => {
          clearTimeout(timer);
          view.removeEventListener('message', receive);
          frame.remove();
          if (error || !report) reject(error ?? new Error('The Editor frame returned no report.'));
          else resolve(report);
        };
        const receive = ({origin: sender, source, data: message}: Incoming) => {
          if (sender !== origin || source !== frame.contentWindow) return;
          if (message?.type === 'twpe-test:ready') {
            const project = Uint8Array.from(atob(data), (value) => value.charCodeAt(0)).buffer;
            frame.contentWindow?.postMessage(
              {
                type: 'twpe-test:run',
                id: 'cli',
                project,
                only,
                context: {savedGeneration: true, extensionURLs: []},
              },
              origin,
            );
          }
          if (message?.id !== 'cli') return;
          if (message.type === 'twpe-test:done') finish(null, message.report);
          if (message.type === 'twpe-test:failed') finish(new Error(message.message));
        };
        view.addEventListener('message', receive);
        view.document.body.append(frame);
      });
    const report: AttributedReport = await page
      .evaluate(runFrame, {
        data: archive.toString('base64'),
        only,
        origin,
        prefix,
        timeout,
      })
      .catch((error: unknown) => {
        if (disallowedNavigation)
          throw new Error(`Blocked Editor navigation: ${disallowedNavigation}`);
        throw error;
      });
    assert(!disallowedNavigation, 'Blocked an unexpected Editor navigation.');
    assert(report.results.length > 0, 'The Editor did not run any tests.');
    if (allowed.size) {
      // The owner reports project builds; it does not include the pinned Test runner extension.
      const expected = allowed;
      assert(
        report.builds?.length === expected.size &&
          new Set(report.builds.map(({extensionId}) => extensionId)).size === expected.size &&
          report.builds.every(
            ({extensionId, sha256: digest}) => expected.get(extensionId) === digest,
          ),
        'The Editor frame did not report the exact loaded build digests for the CLI grants.',
      );
    }
    return report;
  } finally {
    await browser.close();
  }
}
