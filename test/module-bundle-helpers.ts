// SPDX-License-Identifier: MPL-2.0

import {cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import type {Plugin} from 'rolldown';

import {extensionIntegrity} from '../src/extension-dependencies';

export interface ModuleProbe {
  enabled: boolean;
  members: Record<string, string>;
}

/** Test builds instrument every yaml input, aggregating duplicate copies under the same key. */
export function evaluationProbe(probe: ModuleProbe): Plugin {
  return {
    name: 'test-module-evaluation',
    transform(code, id) {
      if (!probe.enabled) return null;
      const normalized = id.replaceAll('\\', '/');
      const yaml = normalized.split('/node_modules/yaml/')[1];
      if (yaml)
        return `globalThis.__yamlEvaluations[${JSON.stringify(yaml)}] = (globalThis.__yamlEvaluations[${JSON.stringify(yaml)}] || 0) + 1;\n${code}`;
      const member = probe.members[id];
      if (!member) return null;
      return code.replace(
        /function createExtension\s*\([^)]*\)\s*\{/u,
        (match) =>
          `${match}\nglobalThis.__factoryCalls[${JSON.stringify(member)}] = (globalThis.__factoryCalls[${JSON.stringify(member)}] || 0) + 1;`,
      );
    },
  };
}

export async function syntheticModuleProject(requirement = 'not-needed') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sb3-module-'));
  const sourceDirectory = path.join(root, 'app');
  await cp(new URL('./fixtures/minimal-source/', import.meta.url), sourceDirectory, {
    recursive: true,
  });
  await rm(path.join(sourceDirectory, 'extensions/example.js'));
  const yaml = await realpath(new URL('../node_modules/yaml', import.meta.url));
  const yamlMetadata = JSON.parse(await readFile(path.join(yaml, 'package.json'), 'utf8'));
  await mkdir(path.join(root, 'node_modules'), {recursive: true});
  await cp(yaml, path.join(root, 'node_modules/yaml'), {recursive: true});
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({name: 'module-test', version: '1.0.0', private: true}),
  );
  await writeFile(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {'node_modules/yaml': {version: yamlMetadata.version}},
    }),
  );
  const entries: Record<string, string> = {};
  const extensions = [];
  for (const id of ['alpha', 'beta']) {
    const directory = path.join(root, 'node_modules', `test-${id}`);
    await mkdir(path.join(directory, 'node_modules'), {recursive: true});
    // Deliberately install private copies: equal versions alone must not count as deduplication.
    await cp(yaml, path.join(directory, 'node_modules/yaml'), {recursive: true});
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: `test-${id}`,
        version: '1.0.0',
        type: 'module',
        dependencies: {yaml: '^2.9.0'},
      }),
    );
    const classic = `// Name: ${id}\n// ID: ${id}\n// Description: Module fixture\n// By: Example\n// License: MPL-2.0\n// Unsandboxed: ${requirement}\nScratch.extensions.register({getInfo() {return {id: '${id}', name: '${id}', blocks: []};}});\n`;
    await writeFile(path.join(directory, 'classic.js'), classic);
    await writeFile(path.join(sourceDirectory, 'extensions', `${id}.js`), classic);
    const module = `import {parse} from 'yaml';
if (typeof process !== 'undefined') throw new Error('Owner code executed during build');
export const bundleModuleMetadata = {formatVersion: 1, id: '${id}', unsandboxed: '${requirement}'};
export function createExtension(scratch) {
  return {
    getInfo() {return {id: '${id}', name: '${id}', blocks: [
      {opcode: 'parse', blockType: 'reporter', text: 'parse [TEXT]', arguments: {TEXT: {type: 'string'}}},
      {opcode: 'fire', blockType: 'command', text: 'fire'},
      {opcode: 'lookup', blockType: 'reporter', text: 'lookup'}
    ]};},
    parse(args) {scratch.vm.runtime.extensionStorage.${id}.calls++; return JSON.stringify(parse(args.TEXT));},
    fire() {scratch.vm.runtime.startHats('${id}_ready');},
    lookup(args) {return scratch.vm.runtime.getOpcodeFunction(args.OPCODE)();},
    dispose() {globalThis.__disposed.push('${id}');}
  };
}
`;
    const file = path.join(directory, 'module.js');
    await writeFile(file, module);
    entries[await realpath(file)] = id;
    extensions.push({
      id,
      path: `extensions/${id}.js`,
      mediaType: 'text/javascript',
      parameters: [],
      encoding: 'base64',
      source: {
        provider: 'npm',
        package: `test-${id}`,
        version: '1.0.0',
        artifact: 'classic.js',
        integrity: extensionIntegrity(classic),
        module: {
          artifact: 'module.js',
          formatVersion: 1,
          integrity: extensionIntegrity(module),
          unsandboxed: requirement,
        },
      },
    });
  }
  const manifest = {
    formatVersion: 1,
    extensions,
    extensionBundles: [
      {
        id: 'projectbundle',
        name: 'Module Test',
        members: ['alpha', 'beta'],
        buildMode: 'module',
        sharedDependencies: {yaml: yamlMetadata.version},
      },
    ],
  };
  const project = JSON.parse(
    await readFile(path.join(sourceDirectory, 'project.source.json'), 'utf8'),
  );
  project.extensions = ['alpha', 'beta'];
  project.extensionURLs = Object.fromEntries(
    ['alpha', 'beta'].map((id) => [id, `embedded-extension:extensions/${id}.js`]),
  );
  project.extensionStorage = {alpha: {calls: 0}, beta: {calls: 0}};
  project.targets[0].blocks = {
    example: {opcode: 'alpha_parse', inputs: {}, fields: {}, topLevel: true, x: 1, y: 2},
  };
  await writeFile(path.join(sourceDirectory, 'project.source.json'), JSON.stringify(project));
  const save = () =>
    writeFile(
      path.join(sourceDirectory, 'embedded-extensions.json'),
      JSON.stringify(manifest, null, 2),
    );
  await save();
  return {
    root,
    sourceDirectory,
    entries,
    manifest,
    save,
    cleanup: () => rm(root, {recursive: true, force: true}),
  };
}

export function moduleVm(project: any, unsandboxed = true) {
  const registered: any[] = [],
    sourceEditors: any[] = [],
    fixedEditors: any[] = [],
    removed: any[] = [];
  const hats: string[] = [],
    lookups: string[] = [],
    listeners = new Map<string, Set<() => void>>();
  const port = {
    calls: [] as unknown[][],
    async createScene() {},
    createNode(...args: unknown[]) {
      this.calls.push(args);
    },
    addClass() {},
    setData() {},
    setAttribute() {},
  };
  const runtime = {
    extensionStorage: structuredClone(project.extensionStorage ?? {}),
    targets: [],
    turbowarpAFrameCapability: port,
    startHats(opcode: string) {
      hats.push(opcode);
    },
    getOpcodeFunction(opcode: string) {
      lookups.push(opcode);
      return () => opcode;
    },
    on(event: string, listener: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const scratch = {
    extensions: {
      unsandboxed,
      register(instance: unknown) {
        registered.push(instance);
      },
    },
    vm: {runtime},
    BlockType: {
      COMMAND: 'command',
      REPORTER: 'reporter',
      BOOLEAN: 'boolean',
      HAT: 'hat',
      EVENT: 'event',
      LOOP: 'loop',
      LABEL: 'label',
    },
    ArgumentType: {STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean'},
    Cast: {toString: String, toNumber: Number, toBoolean: Boolean},
    translate(message: string | {default: string}) {
      return typeof message === 'string' ? message : message.default;
    },
    gui: {
      blockEditors: Object.freeze({
        apiVersion: 1,
        registerSourceEditor(definition: unknown) {
          sourceEditors.push(definition);
          return () => {
            removed.push(definition);
          };
        },
        registerFixedInputEditor(definition: unknown) {
          fixedEditors.push(definition);
          return () => {
            removed.push(definition);
          };
        },
      }),
    },
  };
  const context = vm.createContext({
    Scratch: scratch,
    TextEncoder,
    TextDecoder,
    AbortController,
    Uint8Array,
    ReadableStream,
    STRUCTURED_DATA_MVP: true,
    NAMED_DATA_REGISTRY_MVP: true,
    __yamlEvaluations: {},
    __factoryCalls: {},
    __disposed: [],
    console: {error() {}, warn() {}},
  });
  return {
    context,
    registered,
    sourceEditors,
    fixedEditors,
    removed,
    hats,
    lookups,
    listeners,
    port,
    runtime,
  };
}
