// SPDX-License-Identifier: MPL-2.0

import {builtinModules} from 'node:module';
import {readFile, realpath} from 'node:fs/promises';
import path from 'node:path';

import type {Plugin} from 'rolldown';
import {satisfies, valid, validRange} from 'semver';

import {assert} from './assert';
import {
  buildExtensionBundles,
  bundleHeader,
  bundleUnsandboxedRequirement,
  createStaticExtensionBundle,
  extensionBundleRecoveryMarker,
  readBundleComponents,
  sandboxedGuardSource,
  sandboxedNotice,
} from './extension-bundle';
import type {
  BuildExtensionBundlesInput,
  BuildExtensionBundlesResult,
  ExtensionBundleComponent,
} from './extension-bundle';
import {extensionIntegrity, unsandboxedRequirement} from './extension-dependencies';
import {
  findPackageDirectory,
  readNpmExtensionSource,
  readPackageArtifact,
} from './npm-extension-source';
import type {ExtensionBundleConfiguration, ProjectJson} from './types';

interface InstalledPackage {
  root: string;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface ExtensionModuleBuildReport {
  formatVersion: 1;
  bundler: {name: 'rolldown'; version: string};
  platform: 'browser';
  target: 'es2020';
  lock: {file: string; integrity: string};
  members: {id: string; package: string; version: string; artifact: string; integrity: string}[];
  inputs: {package: string; version: string; file: string; integrity: string}[];
  sharedDependencies: {package: string; version: string; moduleCount: number; copies: number}[];
  inputIntegrity: string;
}

export interface ExtensionModuleBuild {
  contents: Buffer;
  report: ExtensionModuleBuildReport;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function dependencyLock(directory: string): Promise<{file: string; integrity: string}> {
  let current = path.resolve(directory);
  while (true) {
    const found: {file: string; integrity: string}[] = [];
    for (const file of ['pnpm-lock.yaml', 'package-lock.json']) {
      try {
        found.push({file, integrity: extensionIntegrity(await readFile(path.join(current, file)))});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    assert(found.length < 2, `Module build has ambiguous dependency locks in ${current}.`);
    if (found.length) return found[0];
    const parent = path.dirname(current);
    assert(
      parent !== current,
      'Module builds require pnpm-lock.yaml or package-lock.json in the project.',
    );
    current = parent;
  }
}

/** Parse and bundle installed ESM only; no owner module or project build configuration is executed. */
export async function compileExtensionModuleBundle(
  bundle: ExtensionBundleConfiguration,
  components: ExtensionBundleComponent[],
  project: ProjectJson,
  sourceDirectory: string,
): Promise<ExtensionModuleBuild> {
  const lock = await dependencyLock(sourceDirectory);
  const manifests = new Map<string, Buffer>();
  const packageCache = new Map<string, Promise<InstalledPackage>>();
  async function owner(file: string): Promise<InstalledPackage> {
    const directory = path.dirname(file);
    let promise = packageCache.get(directory);
    if (!promise) {
      promise = (async () => {
        try {
          const manifestFile = await realpath(path.join(directory, 'package.json'));
          const manifestContents = await readFile(manifestFile);
          manifests.set(manifestFile, manifestContents);
          const metadata = JSON.parse(manifestContents.toString('utf8')) as Omit<
            InstalledPackage,
            'root'
          >;
          if (metadata.name === undefined && metadata.version === undefined) {
            assert(
              path.dirname(directory) !== directory,
              `Module has no owning npm package: ${file}`,
            );
            return owner(directory);
          }
          assert(
            typeof metadata.name === 'string' && !!valid(metadata.version),
            `Invalid installed package metadata: ${directory}`,
          );
          return {...metadata, root: await realpath(directory)};
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          assert(
            path.dirname(directory) !== directory,
            `Module has no owning npm package: ${file}`,
          );
          return owner(directory);
        }
      })();
      packageCache.set(directory, promise);
    }
    return promise;
  }

  const entries: string[] = [];
  const members: ExtensionModuleBuildReport['members'] = [];
  const effectiveComponents: ExtensionBundleComponent[] = [];
  for (const component of components) {
    const source = component.extension.source;
    assert(
      source?.provider === 'npm' && source.module,
      `Module bundle member ${component.extension.id} needs an npm source.module entry.`,
    );
    const installed = await readNpmExtensionSource(component.extension, sourceDirectory, {
      maximumArtifactBytes: 20 * 1024 * 1024,
      maximumManifestBytes: 2 * 1024 * 1024,
    });
    assert(
      Buffer.from(installed.contents).equals(component.originalContents),
      `Installed classic artifact differs for module member ${component.extension.id}. Sync the pinned package first.`,
    );
    const bytes = await readPackageArtifact(
      installed.packageDirectory,
      source.module.artifact,
      20 * 1024 * 1024,
      `Module entry ${component.extension.id}`,
    );
    assert(
      extensionIntegrity(bytes) === source.module.integrity,
      `Module integrity mismatch: ${component.extension.id}`,
    );
    const declared = unsandboxedRequirement(component.metadata);
    assert(
      declared === null || declared === source.module.unsandboxed,
      `Module sandbox declaration disagrees with classic header: ${component.extension.id}`,
    );
    entries.push(await realpath(path.join(installed.packageDirectory, source.module.artifact)));
    members.push({
      id: component.extension.id,
      package: source.package,
      version: installed.version,
      artifact: source.module.artifact,
      integrity: source.module.integrity,
    });
    effectiveComponents.push({
      ...component,
      metadata: {...component.metadata, unsandboxed: source.module.unsandboxed},
    });
  }

  const selected = new Map<string, InstalledPackage>();
  for (const [name, version] of Object.entries(bundle.sharedDependencies ?? {}).sort(([a], [b]) =>
    compare(a, b),
  )) {
    assert(
      valid(version) === version,
      `Shared dependency ${name} requires an exact semantic version.`,
    );
    const directory = await findPackageDirectory(sourceDirectory, name);
    const installed = await owner(path.join(directory, 'package.json'));
    assert(
      installed.name === name && installed.version === version,
      `Shared dependency ${name}: expected ${version}, installed ${installed.version}.`,
    );
    selected.set(name, installed);
  }

  const virtualEntry = `\0sb3-module-bundle:${bundle.id}`;
  const bindings = components.map((_, index) => `sb3Module${index}`);
  const runtime = createStaticExtensionBundle(
    bundle,
    effectiveComponents,
    project,
    bindings,
  ).toString('utf8');
  const imports = entries
    .map((file, index) => `import * as ${bindings[index]} from ${JSON.stringify(file)};`)
    .join('\n');
  const entrySource = `${imports}\n${runtime}`;
  const loaded = new Map<string, {package: InstalledPackage; contents: Buffer}>();
  const nativeModules = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  const resolutionAnchor = path.join(sourceDirectory, '__sb3_shared_dependencies__.js');
  const plugin: Plugin = {
    name: 'sb3-module-inputs',
    async resolveId(request, importer) {
      if (request === virtualEntry) return virtualEntry;
      assert(
        !nativeModules.has(request) && !/^(?:https?|data|file):/u.test(request),
        `Module bundle cannot use a native or remote import: ${request}`,
      );
      const match = [...selected].find(
        ([name]) => request === name || request.startsWith(`${name}/`),
      );
      if (match) {
        const [name, installed] = match;
        if (importer && !importer.startsWith('\0')) {
          const caller = await owner(importer);
          if (caller.root !== installed.root) {
            const range =
              caller.dependencies?.[name] ??
              caller.optionalDependencies?.[name] ??
              caller.peerDependencies?.[name];
            assert(
              range && validRange(range) && satisfies(installed.version, range),
              `Incompatible shared dependency ${name}@${installed.version}: ${caller.name}@${caller.version} requires ${range ?? '(undeclared)'}.`,
            );
          }
        }
        const resolved = await this.resolve(request, resolutionAnchor, {skipSelf: true});
        assert(
          resolved && !resolved.external && within(installed.root, await realpath(resolved.id)),
          `Shared dependency resolved outside pinned package: ${request}`,
        );
        return resolved;
      }
      return null;
    },
    async load(id) {
      if (id === virtualEntry) return entrySource;
      if (id.startsWith('\0')) return null;
      assert(path.isAbsolute(id), `Module input must resolve to an installed file: ${id}`);
      const file = await realpath(id);
      const installed = await owner(file);
      assert(
        file.includes(`${path.sep}node_modules${path.sep}`),
        `Module input is outside installed npm packages: ${file}`,
      );
      const shared = selected.get(installed.name);
      if (shared) {
        assert(
          shared.root === installed.root,
          `Duplicate shared dependency in module graph: ${installed.name}`,
        );
        if (installed.name === 'yaml')
          assert(
            within(path.join(shared.root, 'browser'), file) ||
              file === path.join(shared.root, 'package.json'),
            'Shared yaml must use the browser entry exclusively; node/browser module mixing is unsupported.',
          );
      }
      const contents = await readFile(file);
      loaded.set(file, {package: installed, contents});
      return null;
    },
  };
  // Keep the native bundler unloaded on the default classic path.
  const {rolldown, VERSION} = await import('rolldown');
  const build = await rolldown({
    input: virtualEntry,
    cwd: sourceDirectory,
    platform: 'browser',
    resolve: {conditionNames: ['browser', 'import', 'default'], symlinks: true},
    transform: {target: 'es2020'},
    tsconfig: false,
    plugins: [plugin],
    onwarn(warning, defaultHandler) {
      assert(warning.code !== 'UNRESOLVED_IMPORT', warning.message);
      defaultHandler(warning);
    },
  });
  try {
    const {output} = await build.generate({
      format: 'iife',
      codeSplitting: false,
      sourcemap: false,
      minify: false,
      strictExecutionOrder: true,
      comments: {legal: true},
    });
    assert(
      output.length === 1 && output[0].type === 'chunk',
      'Module bundle must emit exactly one JavaScript chunk.',
    );
    const chunk = output[0];
    assert(
      chunk.imports.length === 0 && chunk.dynamicImports.length === 0,
      'Module bundle has unresolved runtime imports.',
    );
    const sharedDependencies: ExtensionModuleBuildReport['sharedDependencies'] = [];
    for (const [name, installed] of selected) {
      const matches = [...loaded.values()].filter((input) => input.package.name === name);
      const roots = new Set(matches.map((input) => input.package.root));
      assert(
        roots.size <= 1 && [...roots].every((root) => root === installed.root),
        `Duplicate shared dependency in module graph: ${name}`,
      );
      if (name === 'yaml') {
        assert(
          [...loaded]
            .filter(([, input]) => input.package.name === name)
            .every(
              ([file]) =>
                within(path.join(installed.root, 'browser'), file) ||
                file === path.join(installed.root, 'package.json'),
            ),
          'Shared yaml must use the browser entry exclusively; node/browser module mixing is unsupported.',
        );
      }
      sharedDependencies.push({
        package: name,
        version: installed.version,
        moduleCount: matches.length,
        copies: roots.size,
      });
    }
    const inputs = [...loaded].map(([file, input]) => ({
      package: input.package.name,
      version: input.package.version,
      file: path.relative(input.package.root, file).split(path.sep).join('/'),
      integrity: extensionIntegrity(input.contents),
    }));
    // Include manifests and nested type boundaries: they affect resolution and module interpretation.
    for (const [file, contents] of manifests) {
      const installed = await owner(file);
      inputs.push({
        package: installed.name,
        version: installed.version,
        file: path.relative(installed.root, file).split(path.sep).join('/'),
        integrity: extensionIntegrity(contents),
      });
    }
    inputs.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    const settings = {
      formatVersion: 1 as const,
      bundler: {name: 'rolldown' as const, version: VERSION},
      platform: 'browser' as const,
      target: 'es2020' as const,
      lock,
      members,
      inputs,
      sharedDependencies,
    };
    const report = {...settings, inputIntegrity: extensionIntegrity(JSON.stringify(settings))};
    const requirement = bundleUnsandboxedRequirement(effectiveComponents);
    const notice = sandboxedNotice(bundle, requirement);
    const guard = sandboxedGuardSource(requirement, notice);
    const code = chunk.code.replace(/^[\t ]*\/\/#(?:end)?region[^\r\n]*(?:\r?\n|$)/gm, '');
    const capsule = bundle.recoveryCapsule
      ? runtime.split('\n').find((line) => line.startsWith(`// ${extensionBundleRecoveryMarker}: `))
      : undefined;
    const contents = Buffer.from(
      `${bundleHeader(bundle, effectiveComponents)}// Module build inputs: ${report.inputIntegrity}\n(function (Scratch) {\n'use strict';\nconst BUNDLE_ID = ${JSON.stringify(bundle.id)};\nconst BUNDLE_NAME = ${JSON.stringify(bundle.name)};\n${guard}\n${code}\n})(Scratch);\n${capsule ? `${capsule}\n` : ''}`,
    );
    return {contents, report};
  } finally {
    await build.close();
  }
}

/** Asynchronous opt-in layer; the synchronous classic API remains unchanged. */
export async function buildExtensionBundlesWithModules(
  input: BuildExtensionBundlesInput & {sourceDirectory: string},
): Promise<BuildExtensionBundlesResult> {
  const moduleBuilds = new Map<string, ExtensionModuleBuild>();
  const extensions = new Map(input.extensions.map((extension) => [extension.id, extension]));
  for (const bundle of input.extensionBundles) {
    if (bundle.buildMode !== 'module') continue;
    const components = readBundleComponents(bundle, extensions, input.extensionContents);
    moduleBuilds.set(
      bundle.id,
      await compileExtensionModuleBundle(bundle, components, input.project, input.sourceDirectory),
    );
  }
  return buildExtensionBundles({...input, moduleBuilds});
}
