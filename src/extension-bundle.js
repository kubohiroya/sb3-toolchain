// SPDX-License-Identifier: MPL-2.0

import {extensionHeaderMetadata} from './extension-dependencies.js';

export const extensionBundleRecoveryMarker = 'SB3-Toolchain-Reversible-Bundle-v1';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validateBundleId(id, description = 'Extension bundle ID') {
  assert(
    typeof id === 'string' && /^[a-z0-9]+$/u.test(id),
    `${description} must use TurboWarp's [a-z0-9]+ format: ${JSON.stringify(id)}`,
  );
  return id;
}

function validateBundleName(name) {
  assert(
    typeof name === 'string' && name.trim() === name && name.length > 0 && !/[\r\n]/u.test(name),
    `Extension bundle name must be a non-empty single line: ${JSON.stringify(name)}`,
  );
  return name;
}

export function validateExtensionBundleConfigurations(extensionBundles, extensions) {
  if (extensionBundles === undefined) return [];
  assert(
    Array.isArray(extensionBundles),
    'embedded-extensions.json extensionBundles must be an array.',
  );

  const extensionsById = new Map(extensions.map((extension) => [extension.id, extension]));
  const bundleIds = new Set();
  const bundledMemberIds = new Set();

  return extensionBundles.map((bundle, bundleIndex) => {
    assert(isObject(bundle), `Extension bundle ${bundleIndex} must be an object.`);
    validateBundleId(bundle.id, `Extension bundle ${bundleIndex} ID`);
    validateBundleName(bundle.name);
    assert(
      !extensionsById.has(bundle.id),
      `Extension bundle ID collides with an extension: ${bundle.id}`,
    );
    assert(!bundleIds.has(bundle.id), `Duplicate extension bundle ID: ${bundle.id}`);
    bundleIds.add(bundle.id);
    assert(
      Array.isArray(bundle.members) && bundle.members.length >= 2,
      `Extension bundle ${bundle.id} must contain at least two members.`,
    );
    assert(
      bundle.recoveryCapsule === undefined || typeof bundle.recoveryCapsule === 'boolean',
      `Extension bundle ${bundle.id} recoveryCapsule must be a boolean when present.`,
    );

    const localMemberIds = new Set();
    for (const memberId of bundle.members) {
      validateBundleId(memberId, `Extension bundle ${bundle.id} member ID`);
      assert(
        extensionsById.has(memberId),
        `Extension bundle ${bundle.id} has unknown member: ${memberId}`,
      );
      assert(
        !localMemberIds.has(memberId),
        `Extension bundle ${bundle.id} repeats member: ${memberId}`,
      );
      assert(
        !bundledMemberIds.has(memberId),
        `Embedded extension belongs to more than one bundle: ${memberId}`,
      );
      localMemberIds.add(memberId);
      bundledMemberIds.add(memberId);
    }
    return {
      id: bundle.id,
      members: [...bundle.members],
      name: bundle.name,
      ...(bundle.recoveryCapsule === undefined ? {} : {recoveryCapsule: bundle.recoveryCapsule}),
    };
  });
}

function readBundleComponents(bundle, extensionsById, extensionContents) {
  return bundle.members.map((memberId) => {
    const extension = extensionsById.get(memberId);
    const contents = extensionContents.get(memberId);
    assert(contents, `Extension bundle ${bundle.id} has no contents for member: ${memberId}`);
    assert(
      extension.mediaType === 'text/javascript' || extension.mediaType === 'application/javascript',
      `Extension bundle ${bundle.id} member ${memberId} must be JavaScript, got ${extension.mediaType}.`,
    );
    const metadata = extensionHeaderMetadata(contents);
    assert(
      metadata.id === memberId,
      `Extension bundle ${bundle.id} member header ID mismatch: expected ${memberId}, ` +
        `got ${metadata.id ?? '(missing)'}`,
    );
    for (const [property, label] of [
      ['name', 'Name'],
      ['author', 'By'],
      ['description', 'Description'],
      ['license', 'License'],
    ]) {
      assert(
        metadata[property],
        `Extension bundle ${bundle.id} member ${memberId} requires a // ${label}: header.`,
      );
    }
    const source = Buffer.from(contents).toString('utf8');
    assert(
      !source.startsWith('#!'),
      `Extension bundle ${bundle.id} member ${memberId} cannot use a shebang.`,
    );
    assert(
      !source.includes(extensionBundleRecoveryMarker),
      `Extension bundle ${bundle.id} member ${memberId} contains the reserved recovery marker.`,
    );
    const registrations = source.match(/\bScratch\s*\.\s*extensions\s*\.\s*register\s*\(/gu) ?? [];
    assert(
      registrations.length === 1,
      `Extension bundle ${bundle.id} member ${memberId} must contain exactly one synchronous ` +
        `Scratch.extensions.register call; found ${registrations.length}.`,
    );
    return {contents: source, extension, metadata, originalContents: Buffer.from(contents)};
  });
}

function commentLine(value) {
  return String(value).replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function bundleHeader(bundle, components) {
  const authors = [...new Set(components.map((component) => component.metadata.author))];
  const lines = [
    `// Name: ${commentLine(bundle.name)}`,
    `// ID: ${bundle.id}`,
    `// Description: Static bundle of ${components.length} TurboWarp extensions.`,
    `// By: ${commentLine(authors.join(', '))}`,
    '// License: See the bundled extension notices below.',
    '//',
    '// Bundled extensions:',
  ];
  for (const component of components) {
    lines.push(
      `// - Name: ${commentLine(component.metadata.name)}`,
      `//   ID: ${component.metadata.id}`,
      `//   By: ${commentLine(component.metadata.author)}`,
      `//   Description: ${commentLine(component.metadata.description)}`,
      `//   License: ${commentLine(component.metadata.license)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function componentLoadSource(component) {
  const memberId = JSON.stringify(component.metadata.id);
  const source = component.contents.endsWith('\n') ? component.contents : `${component.contents}\n`;
  return `loadComponent(${memberId}, function (Scratch) {\n${source}});\n`;
}

function percentEncode(contents) {
  return [...Buffer.from(contents)]
    .map((byte) => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('');
}

function componentDataUrl(component) {
  const metadata = [component.extension.mediaType, ...component.extension.parameters].join(';');
  const originalContents = component.originalContents ?? Buffer.from(component.contents);
  if (component.extension.encoding === 'base64') {
    return `data:${metadata};base64,${originalContents.toString('base64')}`;
  }
  return `data:${metadata},${percentEncode(originalContents)}`;
}

function recoveryCapsule(bundle, components, originalProject) {
  return {
    formatVersion: 1,
    bundle: {id: bundle.id, name: bundle.name},
    components: components.map((component) => ({
      dataUrl: componentDataUrl(component),
      id: component.metadata.id,
    })),
    originalExtensionIds: Array.isArray(originalProject?.extensions)
      ? [...originalProject.extensions]
      : null,
    originalExtensionUrlIds: Object.keys(originalProject?.extensionURLs ?? {}),
  };
}

export function createStaticExtensionBundle(bundle, components, originalProject = undefined) {
  const componentIds = JSON.stringify(components.map((component) => component.metadata.id));
  const header = bundleHeader(bundle, components);
  const loaders = components.map(componentLoadSource).join('\n');
  const runtime = `(function (Scratch) {
  'use strict';

  const BUNDLE_ID = ${JSON.stringify(bundle.id)};
  const BUNDLE_NAME = ${JSON.stringify(bundle.name)};
  const COMPONENT_IDS = ${componentIds};
  const components = new Map();

  const rewriteOpcode = (componentId, opcode) => {
    const prefix = componentId + '_';
    return typeof opcode === 'string' && opcode.startsWith(prefix)
      ? BUNDLE_ID + '_' + componentId + '__' + opcode.slice(prefix.length)
      : opcode;
  };

  const rewriteBundleOpcode = (opcode) => {
    for (const componentId of COMPONENT_IDS) {
      const rewritten = rewriteOpcode(componentId, opcode);
      if (rewritten !== opcode) return rewritten;
    }
    return opcode;
  };

  const xmlEscape = (value) => String(value).replace(/[<>&'"]/gu, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[character]);

  const installStorageAliases = (storage) => {
    if (!storage || typeof storage !== 'object') return;
    const hasBundleStorage = Object.prototype.hasOwnProperty.call(storage, BUNDLE_ID);
    const hasMemberStorage = COMPONENT_IDS.some((id) => Object.prototype.hasOwnProperty.call(storage, id));
    if (!hasBundleStorage && !hasMemberStorage) return;
    let bundleStorage = storage[BUNDLE_ID];
    if (!bundleStorage || typeof bundleStorage !== 'object' || Array.isArray(bundleStorage)) {
      bundleStorage = {formatVersion: 1, components: {}};
      storage[BUNDLE_ID] = bundleStorage;
    }
    if (!bundleStorage.components || typeof bundleStorage.components !== 'object' || Array.isArray(bundleStorage.components)) {
      throw new Error('Invalid extension storage for static bundle ' + BUNDLE_ID + '.');
    }
    for (const id of COMPONENT_IDS) {
      const descriptor = Object.getOwnPropertyDescriptor(storage, id);
      if (descriptor && !descriptor.get && !Object.prototype.hasOwnProperty.call(bundleStorage.components, id)) {
        bundleStorage.components[id] = storage[id];
      }
      if (!descriptor || !descriptor.get) {
        delete storage[id];
        Object.defineProperty(storage, id, {
          configurable: true,
          enumerable: false,
          get: () => bundleStorage.components[id],
          set: (value) => {
            bundleStorage.components[id] = value;
          },
        });
      }
    }
  };

  const installAllStorageAliases = () => {
    const runtime = Scratch.vm && Scratch.vm.runtime;
    if (!runtime) return;
    installStorageAliases(runtime.extensionStorage);
    for (const target of runtime.targets || []) installStorageAliases(target.extensionStorage);
  };

  installAllStorageAliases();

  const createComponentScratch = (componentId, register) => {
    const baseRuntime = Scratch.vm && Scratch.vm.runtime;
    const runtime = baseRuntime && new Proxy(baseRuntime, {
      get(target, property) {
        if (property === 'startHats') {
          return (opcode, ...args) => target.startHats(rewriteOpcode(componentId, opcode), ...args);
        }
        if (property === 'getOpcodeFunction') {
          return (opcode, ...args) => target.getOpcodeFunction(rewriteBundleOpcode(opcode), ...args);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const baseVm = Scratch.vm;
    const vm = baseVm && new Proxy(baseVm, {
      get(target, property) {
        if (property === 'runtime') return runtime;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const extensions = Object.create(Scratch.extensions);
    Object.defineProperty(extensions, 'register', {value: register});
    return new Proxy(Scratch, {
      get(target, property) {
        if (property === 'extensions') return extensions;
        if (property === 'vm') return vm;
        return Reflect.get(target, property, target);
      },
    });
  };

  const loadComponent = (componentId, execute) => {
    let registration = null;
    let registrationCount = 0;
    let acceptingRegistration = true;
    const componentScratch = createComponentScratch(componentId, (extension) => {
      if (!acceptingRegistration) {
        throw new Error('Asynchronous registration is unsupported in static bundle member ' + componentId + '.');
      }
      registration = extension;
      registrationCount += 1;
    });
    execute(componentScratch);
    acceptingRegistration = false;
    if (registrationCount !== 1) {
      throw new Error(
        'Static bundle member ' + componentId + ' must register exactly once synchronously; got ' + registrationCount + '.',
      );
    }
    components.set(componentId, registration);
  };

${loaders}
  class StaticExtensionBundle {
    constructor() {
      this.delegates = new Map();
    }

    addDelegate(name, component, originalName) {
      if (this.delegates.has(name)) throw new Error('Duplicate static bundle delegate: ' + name);
      if (typeof originalName !== 'string' || typeof component[originalName] !== 'function') {
        throw new Error('Missing static bundle handler: ' + originalName);
      }
      this.delegates.set(name, {component, originalName});
      this[name] = (...args) => {
        installAllStorageAliases();
        return component[originalName](...args);
      };
    }

    getInfo() {
      const result = {
        id: BUNDLE_ID,
        name: BUNDLE_NAME,
        color1: '#5B67A5',
        blocks: [],
        menus: {},
        customFieldTypes: {},
      };
      this.delegates.clear();
      const transformedOpcodes = new Set();

      for (const [componentIndex, componentId] of COMPONENT_IDS.entries()) {
        const component = components.get(componentId);
        const info = component.getInfo();
        if (!info || info.id !== componentId) {
          throw new Error(
            'Static bundle member runtime ID mismatch: expected ' + componentId + ', got ' +
              (info && info.id ? info.id : '(missing)') + '.',
          );
        }
        if (typeof info.name !== 'string' || info.name.length === 0) {
          throw new Error('Static bundle member ' + componentId + ' must have a non-empty name.');
        }
        const namespace = componentId + '__';
        const memberBlockIconURI =
          typeof info.blockIconURI === 'string' && info.blockIconURI.length > 0
            ? info.blockIconURI
            : null;
        const customFieldTypes = info.customFieldTypes || {};
        for (const [fieldName, fieldInfo] of Object.entries(customFieldTypes)) {
          result.customFieldTypes[namespace + fieldName] = fieldInfo;
        }
        if (componentIndex > 0) result.blocks.push('---', '---');
        result.blocks.push({
          blockType: Scratch.BlockType.LABEL,
          sb3Toolchain: {kind: 'bundle-member-heading', memberId: componentId},
          text: '◆ ' + info.name + ' [' + componentId + '] ◆',
        });
        if (info.docsURI) {
          const docsURI = String(info.docsURI);
          result.blocks.push({
            blockType: Scratch.BlockType.XML,
            sb3Toolchain: {
              docsURI,
              kind: 'bundle-member-docs',
              memberId: componentId,
            },
            xml: '<button text="Open Documentation" callbackKey="OPEN_EXTENSION_DOCS" callbackData="' + xmlEscape(docsURI) + '"></button>',
          });
        }
        for (const block of info.blocks || []) {
          if (block === '---') {
            result.blocks.push(block);
            continue;
          }
          if (!block || typeof block !== 'object') throw new Error('Invalid block in static bundle member ' + componentId + '.');
          if (block.blockType === Scratch.BlockType.XML) {
            throw new Error('XML blocks are unsupported in static bundle member ' + componentId + '.');
          }
          const transformed = {...block};
          if (
            memberBlockIconURI !== null &&
            !Object.prototype.hasOwnProperty.call(block, 'blockIconURI') &&
            block.blockType !== Scratch.BlockType.LABEL &&
            block.blockType !== Scratch.BlockType.BUTTON
          ) {
            transformed.blockIconURI = memberBlockIconURI;
          }
          if (block.arguments) {
            transformed.arguments = Object.fromEntries(
              Object.entries(block.arguments).map(([argumentName, argument]) => {
                const transformedArgument = {...argument};
                if (typeof transformedArgument.menu === 'string') {
                  transformedArgument.menu = namespace + transformedArgument.menu;
                }
                if (typeof transformedArgument.type === 'string' && Object.prototype.hasOwnProperty.call(customFieldTypes, transformedArgument.type)) {
                  transformedArgument.type = namespace + transformedArgument.type;
                }
                return [argumentName, transformedArgument];
              }),
            );
          }
          if (block.blockType === Scratch.BlockType.LABEL) {
            result.blocks.push(transformed);
            continue;
          }
          if (block.blockType === Scratch.BlockType.BUTTON) {
            const delegateName = namespace + 'button__' + block.func;
            transformed.func = delegateName;
            this.addDelegate(delegateName, component, block.func);
            result.blocks.push(transformed);
            continue;
          }
          if (typeof block.opcode !== 'string' || block.opcode.length === 0) {
            throw new Error('Missing opcode in static bundle member ' + componentId + '.');
          }
          transformed.opcode = namespace + block.opcode;
          if (transformedOpcodes.has(transformed.opcode)) {
            throw new Error('Duplicate static bundle opcode: ' + transformed.opcode);
          }
          transformedOpcodes.add(transformed.opcode);
          if (block.blockType !== Scratch.BlockType.EVENT) {
            const originalName = block.func || block.opcode;
            transformed.func = transformed.opcode;
            this.addDelegate(transformed.opcode, component, originalName);
          } else {
            delete transformed.func;
          }
          result.blocks.push(transformed);
        }
        for (const [menuName, menu] of Object.entries(info.menus || {})) {
          const transformedMenuName = namespace + menuName;
          if (typeof menu === 'string') {
            const delegateName = namespace + 'menu__' + menuName;
            this.addDelegate(delegateName, component, menu);
            result.menus[transformedMenuName] = {items: delegateName};
          } else if (Array.isArray(menu)) {
            result.menus[transformedMenuName] = [...menu];
          } else if (menu && typeof menu === 'object') {
            const transformedMenu = {...menu};
            if (typeof menu.items === 'string') {
              const delegateName = namespace + 'menu__' + menuName;
              this.addDelegate(delegateName, component, menu.items);
              transformedMenu.items = delegateName;
            }
            result.menus[transformedMenuName] = transformedMenu;
          } else {
            throw new Error('Invalid menu in static bundle member ' + componentId + ': ' + menuName + '.');
          }
        }
      }
      return result;
    }
  }

  Scratch.extensions.register(new StaticExtensionBundle());
})(Scratch);
`;
  if (bundle.recoveryCapsule !== true) {
    return Buffer.from(`${header}\n${runtime}`);
  }
  const capsule = Buffer.from(
    JSON.stringify(
      recoveryCapsule(
        bundle,
        components,
        originalProject ?? {
          extensions: bundle.members,
          extensionURLs: Object.fromEntries(bundle.members.map((memberId) => [memberId, true])),
        },
      ),
    ),
  ).toString('base64');
  return Buffer.from(`${header}\n${runtime}\n// ${extensionBundleRecoveryMarker}: ${capsule}\n`);
}

function replaceMemberKeys(object, memberIds, bundleId, bundleValue) {
  const replacement = {};
  let inserted = false;
  for (const [key, value] of Object.entries(object)) {
    if (memberIds.has(key)) {
      if (!inserted) {
        replacement[bundleId] = bundleValue(value);
        inserted = true;
      }
    } else {
      replacement[key] = value;
    }
  }
  return {inserted, replacement};
}

function bundleStorage(storage, bundle) {
  if (!isObject(storage)) return storage;
  const memberIds = new Set(bundle.members);
  const componentStorage = {};
  for (const memberId of bundle.members) {
    if (Object.hasOwn(storage, memberId)) componentStorage[memberId] = storage[memberId];
  }
  if (Object.keys(componentStorage).length === 0) return storage;
  assert(
    !Object.hasOwn(storage, bundle.id),
    `Extension storage already contains bundle ID: ${bundle.id}`,
  );
  return replaceMemberKeys(storage, memberIds, bundle.id, () => ({
    formatVersion: 1,
    components: componentStorage,
  })).replacement;
}

function rewriteOpcodeValues(value, bundle, counts) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) rewriteOpcodeValues(entry, bundle, counts);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'opcode' && typeof entry === 'string') {
      for (const memberId of bundle.members) {
        const prefix = `${memberId}_`;
        if (entry.startsWith(prefix)) {
          value[key] = `${bundle.id}_${memberId}__${entry.slice(prefix.length)}`;
          counts.opcodes += 1;
          break;
        }
      }
    } else {
      rewriteOpcodeValues(entry, bundle, counts);
    }
  }
}

function collectRemainingOpcodeReferences(value, bundle) {
  const references = [];
  const prefixes = bundle.members.map((memberId) => `${memberId}_`);
  function visit(current, pointer) {
    if (typeof current === 'string') {
      if (prefixes.some((prefix) => current.startsWith(prefix))) references.push(pointer || '/');
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
      return;
    }
    for (const [key, entry] of Object.entries(current)) visit(entry, `${pointer}/${key}`);
  }
  visit(value, '');
  return references;
}

function rewriteProjectForBundle(project, bundle) {
  const rewritten = structuredClone(project);
  const memberIds = new Set(bundle.members);
  const counts = {extensionStorage: 0, extensionUrls: 0, opcodes: 0, projectExtensions: 0};
  assert(isObject(rewritten.extensionURLs), 'project.source.json extensionURLs must be an object.');
  assert(
    !Object.hasOwn(rewritten.extensionURLs, bundle.id),
    `project.source.json already uses bundle ID: ${bundle.id}`,
  );
  for (const memberId of bundle.members) {
    assert(
      rewritten.extensionURLs[memberId] === `embedded-extension:extensions/${memberId}.js`,
      `Extension bundle ${bundle.id} member URL mismatch: ${memberId}`,
    );
  }
  const extensionUrls = replaceMemberKeys(
    rewritten.extensionURLs,
    memberIds,
    bundle.id,
    () => `embedded-extension:extensions/${bundle.id}.js`,
  );
  assert(
    extensionUrls.inserted,
    `Extension bundle ${bundle.id} did not replace any extension URL.`,
  );
  rewritten.extensionURLs = extensionUrls.replacement;
  counts.extensionUrls = bundle.members.length + 1;

  if (rewritten.extensions !== undefined) {
    assert(
      Array.isArray(rewritten.extensions),
      'project.source.json extensions must be an array when present.',
    );
    const output = [];
    let inserted = false;
    for (const id of rewritten.extensions) {
      if (memberIds.has(id)) {
        counts.projectExtensions += 1;
        if (!inserted) {
          output.push(bundle.id);
          inserted = true;
        }
      } else {
        output.push(id);
      }
    }
    rewritten.extensions = output;
  }

  const originalGlobalStorage = rewritten.extensionStorage;
  rewritten.extensionStorage = bundleStorage(rewritten.extensionStorage, bundle);
  if (rewritten.extensionStorage !== originalGlobalStorage) counts.extensionStorage += 1;
  for (const target of rewritten.targets ?? []) {
    const originalTargetStorage = target?.extensionStorage;
    if (target) target.extensionStorage = bundleStorage(target.extensionStorage, bundle);
    if (target?.extensionStorage !== originalTargetStorage) counts.extensionStorage += 1;
  }

  rewriteOpcodeValues(rewritten.targets, bundle, counts);
  rewriteOpcodeValues(rewritten.monitors, bundle, counts);
  const remainingReferences = collectRemainingOpcodeReferences(rewritten, bundle);
  assert(
    remainingReferences.length === 0,
    `Extension bundle ${bundle.id} has unsupported opcode references at: ` +
      remainingReferences.slice(0, 8).join(', '),
  );
  return {counts, project: rewritten};
}

export function buildExtensionBundles({extensionBundles, extensionContents, extensions, project}) {
  if (extensionBundles.length === 0) {
    return {bundlePlans: [], extensionContents, extensions, project};
  }
  const extensionsById = new Map(extensions.map((extension) => [extension.id, extension]));
  const bundlesByMemberId = new Map();
  const bundlePlans = [];
  let bundledProject = project;
  const bundledContents = new Map(extensionContents);

  for (const bundle of extensionBundles) {
    const components = readBundleComponents(bundle, extensionsById, extensionContents);
    const rewrite = rewriteProjectForBundle(bundledProject, bundle);
    const contents = createStaticExtensionBundle(bundle, components, project);
    bundledProject = rewrite.project;
    bundledContents.set(bundle.id, contents);
    for (const memberId of bundle.members) {
      bundlesByMemberId.set(memberId, bundle);
      bundledContents.delete(memberId);
    }
    bundlePlans.push({bundle, components, contents, counts: rewrite.counts});
  }

  const bundledExtensions = [];
  const emittedBundleIds = new Set();
  for (const extension of extensions) {
    const bundle = bundlesByMemberId.get(extension.id);
    if (!bundle) {
      bundledExtensions.push(extension);
    } else if (!emittedBundleIds.has(bundle.id)) {
      emittedBundleIds.add(bundle.id);
      bundledExtensions.push({
        encoding: 'base64',
        id: bundle.id,
        mediaType: 'text/javascript',
        parameters: [],
        path: `extensions/${bundle.id}.js`,
      });
    }
  }
  return {
    bundlePlans,
    extensionContents: bundledContents,
    extensions: bundledExtensions,
    project: bundledProject,
  };
}

export {validateBundleId, validateBundleName};
