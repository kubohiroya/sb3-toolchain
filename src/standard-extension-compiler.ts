// SPDX-License-Identifier: MPL-2.0

import {createHash} from 'node:crypto';
import {posix as path} from 'node:path';

import {serializeExtensionManifest} from '@kubohiroya/turbowarp-extension-manifest';
import {
  BUILD_PROFILE_FILENAME,
  parseExtensionBuildProfile,
  parseExtensionBuildSettings,
} from '@kubohiroya/turbowarp-extension-manifest/build-profile';
import {API_MANIFEST} from '@kubohiroya/turbowarp-extension-manifest/distribution';
import {readPackageResourceDeclaration} from '@kubohiroya/turbowarp-extension-manifest/resources';
import type {Plugin} from 'rolldown';

const virtualRoot = '/__turbowarp_extension_source__';
const unsupportedRequire = 'turbowarp:standard-build-commonjs';
const rootFiles = [BUILD_PROFILE_FILENAME, 'package.json', 'pnpm-lock.yaml'];
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const sourcePath =
  /^src\/(?:[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\/)*[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N}_. -]*\.(?:ts|js|json)$/u;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: string) => Buffer.from(value, 'utf8');
// Updated together with the host-owned compiler dependency and its lockfile entry.
const compilerIntegrity =
  'sha512-ksB1g74e7haRy02OYm4lOQAlr6sK6hBpAY5R+YC30Gkv4L1COwF6M9umBAYAPxWpGow6Vr+IXtyDjH9fq7A+Zg==';

export interface StandardExtensionBuild {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly measurements: Readonly<{
    inputBytes: number;
    outputBytes: number;
    cacheBytes: 0;
    temporaryDiskBytes: 0;
  }>;
  readonly receipt: {
    readonly formatVersion: 1;
    readonly profile: 'turbowarp-typescript-v1';
    readonly execution: 'sandboxed' | 'unsandboxed';
    readonly compiler: {
      readonly name: 'rolldown';
      readonly version: string;
      readonly integrity: string;
    };
    readonly snapshotSHA256: string;
    readonly lockfileSHA256: string;
    readonly outputs: Readonly<Record<string, string>>;
    readonly source: StandardBuildSource;
  };
}

export type StandardBuildSource =
  | Readonly<{kind: 'local-snapshot'}>
  | Readonly<{kind: 'github'; repository: string; commit: string}>;

export interface StandardBuildOptions {
  signal?: AbortSignal;
  source?: StandardBuildSource;
  expectedSnapshotSHA256?: string;
  expectedLockfileSHA256?: string;
}

function validateBundle(ast: unknown) {
  const nodes = [ast];
  let registrations = 0;
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== 'object') continue;
    const value = node as Record<string, unknown>;
    if (
      value.type === 'ImportExpression' ||
      (value.type === 'MetaProperty' &&
        (value.meta as {name?: string} | undefined)?.name === 'import')
    ) {
      throw new Error('The standard build does not support dynamic imports or import.meta');
    }
    if (value.type === 'CallExpression') {
      const callee = value.callee as Record<string, unknown> | undefined;
      const extensions = callee?.object as Record<string, unknown> | undefined;
      if (
        callee?.type === 'MemberExpression' &&
        !callee.computed &&
        (callee.property as {name?: string})?.name === 'register' &&
        extensions?.type === 'MemberExpression' &&
        !extensions.computed &&
        (extensions.property as {name?: string})?.name === 'extensions' &&
        (extensions.object as {name?: string})?.name === 'Scratch'
      ) {
        registrations++;
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') nodes.push(child);
    }
  }
  if (registrations !== 1) throw new Error('Expected one Scratch.extensions.register call');
}

/** Compile an immutable, bounded snapshot supplied by the host. This API performs no source file IO. */
export async function buildStandardExtension(
  snapshot: ReadonlyMap<string, Uint8Array>,
  {
    signal,
    source = {kind: 'local-snapshot'},
    expectedSnapshotSHA256,
    expectedLockfileSHA256,
  }: StandardBuildOptions = {},
): Promise<StandardExtensionBuild> {
  signal?.throwIfAborted();
  if (
    source.kind !== 'local-snapshot' &&
    (source.kind !== 'github' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(
        source.repository,
      ) ||
      !/^[a-f0-9]{40}$/u.test(source.commit))
  ) {
    throw new Error('Invalid standard build source identity');
  }
  const sourceIdentity: StandardBuildSource =
    source.kind === 'github'
      ? {kind: 'github', repository: source.repository, commit: source.commit}
      : {kind: 'local-snapshot'};
  const inputs = new Map<string, {text: string; sha256: string}>();
  const normalizedNames = new Set<string>();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0;
  for (const [file, data] of snapshot) {
    if (
      (!rootFiles.includes(file) && !sourcePath.test(file)) ||
      normalizedNames.has(file.normalize('NFC').toLowerCase())
    ) {
      throw new Error('Unexpected or ambiguous file in extension build snapshot');
    }
    size += data.byteLength;
    if (inputs.size >= 128 || data.byteLength > 1024 * 1024 || size > 4 * 1024 * 1024) {
      throw new Error('Extension build snapshot exceeds its input limit');
    }
    const bytes = Buffer.from(data);
    inputs.set(file, {text: decoder.decode(bytes), sha256: sha256(bytes)});
    normalizedNames.add(file.normalize('NFC').toLowerCase());
  }
  const read = (file: string) => {
    const input = inputs.get(file);
    if (!input) throw new Error(`Missing extension build input ${file}`);
    return input;
  };
  const profile = parseExtensionBuildProfile(JSON.parse(read(BUILD_PROFILE_FILENAME).text));
  const settings = parseExtensionBuildSettings(JSON.parse(read(profile.settings).text));
  if (!/^[A-Za-z]/u.test(settings.id)) {
    throw new Error('The extension ID must start with an ASCII letter for Scratch VM registration');
  }
  if (windowsDeviceName.test(settings.slug)) {
    throw new Error('The extension slug is a reserved Windows device name');
  }
  const resources = readPackageResourceDeclaration(JSON.parse(read('package.json').text));
  if (resources?.resources.length) {
    throw new Error('The standard build does not support declared runtime resources');
  }
  const api = encode(
    serializeExtensionManifest(settings.id, JSON.parse(read(profile.blocks).text)),
  );
  const lockfile = read(profile.lockfile);
  const snapshotSHA256 = sha256(
    encode(JSON.stringify([...inputs.keys()].sort().map((file) => [file, read(file).sha256]))),
  );
  if (
    (expectedSnapshotSHA256 !== undefined && expectedSnapshotSHA256 !== snapshotSHA256) ||
    (expectedLockfileSHA256 !== undefined && expectedLockfileSHA256 !== lockfile.sha256)
  ) {
    throw new Error('Standard build snapshot or lockfile changed');
  }
  read(profile.entry);
  const bundleFile = `${settings.slug}.js`;
  const mapFile = `${bundleFile}.map`;
  const metadata = {
    Name: settings.name,
    ID: settings.id,
    Description: settings.description,
    Author: settings.author,
    License: settings.license,
    Unsandboxed: settings.unsandboxed ? 'required' : 'not-needed',
  };
  const plugin: Plugin = {
    name: 'standard-extension-snapshot',
    resolveId(request, importer, {kind}) {
      if (!importer && request === `${virtualRoot}/${profile.entry}`) return request;
      if (request === unsupportedRequire) {
        throw new Error('The standard build does not support CommonJS require');
      }
      if (
        kind !== 'import-statement' ||
        !importer?.startsWith(`${virtualRoot}/`) ||
        !/^\.\.?\//u.test(request) ||
        /[\\\u0000-\u001f\u007f?#:%]/u.test(request)
      ) {
        throw new Error('The standard build only supports static relative source imports');
      }
      const target = path.join(path.dirname(importer.slice(virtualRoot.length + 1)), request);
      const options = path.extname(target)
        ? [target, target.replace(/\.js$/u, '.ts')]
        : [`${target}.ts`, `${target}.js`, `${target}/index.ts`];
      const file = options.find((option) => sourcePath.test(option) && inputs.has(option));
      if (!file) throw new Error('Relative import does not resolve inside the source snapshot');
      return `${virtualRoot}/${file}`;
    },
    load(id) {
      signal?.throwIfAborted();
      if (!id.startsWith(`${virtualRoot}/`)) throw new Error('Invalid extension module identifier');
      const file = id.slice(virtualRoot.length + 1);
      const extension = path.extname(file);
      return {
        code: read(file).text,
        moduleType: extension === '.ts' ? 'ts' : extension === '.json' ? 'json' : 'js',
      };
    },
  };
  const {rolldown, VERSION} = await import('rolldown');
  if (VERSION !== '1.3.3') throw new Error('Unsupported host compiler version');
  const {parseAst} = await import('rolldown/parseAst');
  signal?.throwIfAborted();
  const build = await rolldown({
    input: `${virtualRoot}/${profile.entry}`,
    platform: 'browser',
    tsconfig: false,
    // Only unbound require references become imports, which the resolver rejects.
    transform: {target: 'es2020', inject: {require: unsupportedRequire}},
    experimental: {attachDebugInfo: 'none'},
    plugins: [plugin],
  });
  try {
    signal?.throwIfAborted();
    const {output} = await build.generate({
      format: 'iife',
      strict: true,
      codeSplitting: false,
      entryFileNames: bundleFile,
      sourcemap: 'hidden',
      sourcemapExcludeSources: true,
      sourcemapPathTransform(source) {
        const file = source.replaceAll('\\', '/').split(`${virtualRoot}/`).at(-1);
        if (!file || !sourcePath.test(file) || !inputs.has(file)) {
          throw new Error('Source map refers outside the source snapshot');
        }
        // Desktop only offers locations in executable source files.
        return file.endsWith('.json') ? '[external]' : file;
      },
      banner: Object.entries(metadata)
        .map(([label, text]) => `// ${label}: ${text.replace(/[\u2028\u2029]/gu, ' ')}`)
        .join('\n'),
    });
    const chunk = output.find((item) => item.type === 'chunk');
    const map = output.find((item) => item.type === 'asset' && item.fileName === mapFile);
    if (
      output.length !== 2 ||
      !chunk ||
      map?.type !== 'asset' ||
      chunk.fileName !== bundleFile ||
      chunk.imports.length ||
      chunk.dynamicImports.length ||
      chunk.exports.length
    ) {
      throw new Error('Expected a single standalone extension with one source map');
    }
    validateBundle(parseAst(chunk.code));
    signal?.throwIfAborted();
    const files = new Map<string, Uint8Array>([
      [bundleFile, encode(chunk.code)],
      [API_MANIFEST, api],
      [mapFile, typeof map.source === 'string' ? encode(map.source) : Uint8Array.from(map.source)],
    ]);
    if (
      files.get(bundleFile)!.byteLength > 4 * 1024 * 1024 ||
      api.byteLength > 128 * 1024 ||
      files.get(mapFile)!.byteLength > 2 * 1024 * 1024
    ) {
      throw new Error('Standard extension outputs exceed the development artifact limits');
    }
    const outputs = Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]));
    const part = (file: string) => ({file, sha256: outputs[file]});
    const marker = 'extension-development.json';
    files.set(
      marker,
      encode(
        `${JSON.stringify({
          formatVersion: 1,
          id: settings.id,
          bundle: part(bundleFile),
          api: part(API_MANIFEST),
          sourceMap: part(mapFile),
        })}\n`,
      ),
    );
    outputs[marker] = sha256(files.get(marker)!);
    return {
      files,
      measurements: {
        inputBytes: size,
        outputBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
        cacheBytes: 0,
        temporaryDiskBytes: 0,
      },
      receipt: {
        formatVersion: 1,
        profile: profile.profile,
        execution: settings.unsandboxed ? 'unsandboxed' : 'sandboxed',
        compiler: {name: 'rolldown', version: VERSION, integrity: compilerIntegrity},
        snapshotSHA256,
        lockfileSHA256: lockfile.sha256,
        outputs,
        source: sourceIdentity,
      },
    };
  } finally {
    await build.close();
  }
}
