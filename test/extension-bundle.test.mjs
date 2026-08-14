// SPDX-License-Identifier: MPL-2.0

import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';

import {parseCliArguments} from '../src/cli.js';
import {
  bundleExtensions,
  compareDirectories,
  createDeterministicSb3,
  planExtensionBundle,
  planExtensionUnbundle,
  planBundledSb3Unbundle,
  unbundleSb3,
  unbundleExtensions,
} from '../src/index.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureSourceDirectory = path.join(projectRoot, 'test/fixtures/minimal-source');

const alphaSource = `// Name: Alpha Tools
// ID: alpha
// Description: Report values, use dynamic menus, and start an event hat.
// By: Alice Example
// License: MPL-2.0

(function (Scratch) {
  'use strict';
  class AlphaExtension {
    getInfo() {
      return {
        id: 'alpha',
        name: 'Alpha Tools',
        docsURI: 'https://example.com/alpha?a=1&b="two"',
        blockIconURI: 'data:image/svg+xml,%3Csvg%20id%3D%22alpha-default%22%2F%3E',
        blocks: [
          {
            opcode: 'value',
            blockType: Scratch.BlockType.REPORTER,
            text: 'alpha value',
          },
          {
            blockType: Scratch.BlockType.LABEL,
            text: 'Alpha original heading',
          },
          '---',
          {
            opcode: 'selected',
            blockType: Scratch.BlockType.REPORTER,
            text: 'selected [ITEM]',
            blockIconURI: 'data:image/svg+xml,%3Csvg%20id%3D%22alpha-selected%22%2F%3E',
            arguments: {
              ITEM: {type: Scratch.ArgumentType.STRING, menu: 'ITEMS'},
            },
          },
          {
            opcode: 'fire',
            blockType: Scratch.BlockType.COMMAND,
            text: 'fire alpha event',
          },
          {
            opcode: 'whenReady',
            blockType: Scratch.BlockType.EVENT,
            text: 'when alpha is ready',
          },
          {
            opcode: 'callOpcode',
            blockType: Scratch.BlockType.REPORTER,
            text: 'call opcode [OPCODE]',
            arguments: {
              OPCODE: {type: Scratch.ArgumentType.STRING},
            },
          },
        ],
        menus: {ITEMS: {acceptReporters: true, items: 'getItems'}},
      };
    }
    value() {
      const storage = Scratch.vm.runtime.extensionStorage.alpha;
      storage.calls += 1;
      return 'alpha:' + storage.calls;
    }
    selected(args) {
      return String(args.ITEM);
    }
    fire() {
      Scratch.vm.runtime.startHats('alpha_whenReady');
    }
    getItems() {
      return ['one', 'two'];
    }
    callOpcode(args, util) {
      const opcodeFunction = Scratch.vm.runtime.getOpcodeFunction(args.OPCODE, args.LOOKUP);
      return opcodeFunction ? opcodeFunction(args.PAYLOAD, util) : undefined;
    }
  }
  Scratch.extensions.register(new AlphaExtension());
})(Scratch);
`;

const betaSource = `// Name: Beta Tools
// ID: beta
// Description: Provide a colliding standalone opcode for namespace testing.
// By: Bob Example
// License: MIT

(function (Scratch) {
  'use strict';
  class BetaExtension {
    getInfo() {
      return {
        id: 'beta',
        name: 'Beta Tools',
        blocks: [
          {
            opcode: 'value',
            blockType: Scratch.BlockType.REPORTER,
            text: 'beta value',
          },
          {
            opcode: 'echo',
            blockType: Scratch.BlockType.REPORTER,
            text: 'echo [VALUE]',
            arguments: {
              VALUE: {type: Scratch.ArgumentType.STRING},
            },
          },
        ],
      };
    }
    value() {
      return 'beta';
    }
    async echo(args, util) {
      await Promise.resolve();
      return 'beta:' + args.VALUE + ':' + util.marker;
    }
  }
  Scratch.extensions.register(new BetaExtension());
})(Scratch);
`;

const gammaSource = alphaSource
  .replaceAll('Alpha', 'Gamma')
  .replaceAll('alpha', 'gamma')
  .replaceAll('Alice Example', 'Grace Example');
const deltaSource = betaSource
  .replaceAll('Beta', 'Delta')
  .replaceAll('beta', 'delta')
  .replaceAll('Bob Example', 'Dana Example');

async function withTemporaryDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sb3-toolchain-bundle-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBundleSource(sourceDirectory) {
  await cp(fixtureSourceDirectory, sourceDirectory, {recursive: true});
  await unlink(path.join(sourceDirectory, 'extensions/example.js'));
  await Promise.all([
    writeFile(path.join(sourceDirectory, 'extensions/alpha.js'), alphaSource),
    writeFile(path.join(sourceDirectory, 'extensions/beta.js'), betaSource),
  ]);
  await writeJson(path.join(sourceDirectory, 'embedded-extensions.json'), {
    formatVersion: 1,
    extensions: [
      {
        id: 'alpha',
        path: 'extensions/alpha.js',
        mediaType: 'text/javascript',
        parameters: [],
        encoding: 'base64',
      },
      {
        id: 'beta',
        path: 'extensions/beta.js',
        mediaType: 'text/javascript',
        parameters: [],
        encoding: 'base64',
      },
    ],
  });
  const projectPath = path.join(sourceDirectory, 'project.source.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.targets[0].blocks = {
    alphaValue: {opcode: 'alpha_value'},
    betaValue: {opcode: 'beta_value'},
    dynamic: {mutation: {blockInfo: {opcode: 'alpha_selected'}}, opcode: 'alpha_selected'},
  };
  project.targets[0].extensionStorage = {beta: {targetValue: 2}};
  project.monitors = [{id: 'alphaMonitor', opcode: 'alpha_value'}];
  project.extensions = ['alpha', 'beta'];
  project.extensionStorage = {alpha: {calls: 0}};
  project.extensionURLs = {
    alpha: 'embedded-extension:extensions/alpha.js',
    beta: 'embedded-extension:extensions/beta.js',
    external: 'https://extensions.turbowarp.org/text.js',
  };
  await writeJson(projectPath, project);
}

function decodeDataUrl(dataUrl) {
  const commaIndex = dataUrl.indexOf(',');
  assert.notEqual(commaIndex, -1);
  return Buffer.from(dataUrl.slice(commaIndex + 1), 'base64').toString('utf8');
}

function archiveWithProject(archive, project) {
  const entries = unzipSync(archive);
  entries['project.json'] = strToU8(`${JSON.stringify(project)}\n`);
  return zipSync(entries, {level: 6});
}

function evaluateBundle(source, extensionStorage) {
  const opcodeFunctions = new Map();
  const opcodeLookups = [];
  const registrations = [];
  const startedHats = [];
  let runtime;
  const Scratch = {
    ArgumentType: {STRING: 'string'},
    BlockType: {
      BUTTON: 'button',
      COMMAND: 'command',
      EVENT: 'event',
      LABEL: 'label',
      REPORTER: 'reporter',
      XML: 'xml',
    },
    extensions: {
      register(extension) {
        registrations.push(extension);
      },
      unsandboxed: true,
    },
    vm: {},
  };
  runtime = {
    extensionStorage,
    getOpcodeFunction(opcode, ...args) {
      opcodeLookups.push({args, opcode, receiver: this});
      return opcodeFunctions.get(opcode);
    },
    startHats(opcode) {
      startedHats.push(opcode);
    },
    targets: [],
  };
  Scratch.vm.runtime = runtime;
  vm.runInNewContext(source, {Scratch}, {filename: 'static-extension-bundle.js'});
  return {opcodeFunctions, opcodeLookups, registrations, runtime, Scratch, startedHats};
}

test('builds one reversible composite extension without deleting original sources', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeBundleSource(sourceDirectory);
    const pristineDirectory = path.join(directory, 'pristine');
    await cp(sourceDirectory, pristineDirectory, {recursive: true});
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const originalManifest = await readFile(manifestPath, 'utf8');

    const dryRun = await planExtensionBundle({
      bundleId: 'projectbundle',
      bundleName: 'Project Extension Bundle',
      extensionIds: ['alpha', 'beta'],
      sourceDirectory,
    });
    assert.equal(dryRun.applied, false);
    assert.deepEqual(dryRun.members, ['alpha', 'beta']);
    assert.deepEqual(
      dryRun.components.map((component) => component.name),
      ['Alpha Tools', 'Beta Tools'],
    );
    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);

    const configured = await bundleExtensions({
      bundleId: 'projectbundle',
      bundleName: 'Project Extension Bundle',
      extensionIds: ['alpha', 'beta'],
      sourceDirectory,
      yes: true,
    });
    assert.equal(configured.applied, true);
    assert.equal(
      await readFile(path.join(sourceDirectory, 'extensions/alpha.js'), 'utf8'),
      alphaSource,
    );
    assert.equal(
      await readFile(path.join(sourceDirectory, 'extensions/beta.js'), 'utf8'),
      betaSource,
    );
    const configuredManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(configuredManifest.extensionBundles, [
      {
        id: 'projectbundle',
        members: ['alpha', 'beta'],
        name: 'Project Extension Bundle',
      },
    ]);

    const [first, second] = await Promise.all([
      createDeterministicSb3(sourceDirectory),
      createDeterministicSb3(sourceDirectory),
    ]);
    assert.deepEqual(Buffer.from(first.archive), Buffer.from(second.archive));
    assert.equal(first.embeddedExtensionCount, 1);
    const project = JSON.parse(strFromU8(unzipSync(first.archive)['project.json']));
    assert.deepEqual(project.extensions, ['projectbundle']);
    assert.deepEqual(Object.keys(project.extensionURLs), ['projectbundle', 'external']);
    assert.deepEqual(
      Object.values(project.targets[0].blocks).map((block) => block.opcode),
      ['projectbundle_alpha__value', 'projectbundle_beta__value', 'projectbundle_alpha__selected'],
    );
    assert.equal(
      project.targets[0].blocks.dynamic.mutation.blockInfo.opcode,
      'projectbundle_alpha__selected',
    );
    assert.equal(project.monitors[0].opcode, 'projectbundle_alpha__value');
    assert.deepEqual(project.extensionStorage, {
      projectbundle: {formatVersion: 1, components: {alpha: {calls: 0}}},
    });
    assert.deepEqual(project.targets[0].extensionStorage, {
      projectbundle: {formatVersion: 1, components: {beta: {targetValue: 2}}},
    });

    const bundleSource = decodeDataUrl(project.extensionURLs.projectbundle);
    assert.match(bundleSource, /^\/\/ Name: Project Extension Bundle$/mu);
    assert.match(bundleSource, /^\/\/ - Name: Alpha Tools$/mu);
    assert.match(bundleSource, /^\/\/   By: Alice Example$/mu);
    assert.match(bundleSource, /^\/\/   Description: Report values/mu);
    assert.match(bundleSource, /^\/\/ - Name: Beta Tools$/mu);
    assert.match(bundleSource, /^\/\/ SB3-Toolchain-Reversible-Bundle-v1: [A-Za-z0-9+/]+=*$/mu);
    const runtime = evaluateBundle(bundleSource, project.extensionStorage);
    assert.equal(runtime.registrations.length, 1);
    const composite = runtime.registrations[0];
    const info = composite.getInfo();
    assert.equal(info.id, 'projectbundle');
    assert.deepEqual(
      Array.from(info.blocks, (block) =>
        block === '---'
          ? 'separator'
          : block.blockType === runtime.Scratch.BlockType.LABEL
            ? block.sb3Toolchain?.kind === 'bundle-member-heading'
              ? `bundle-label:${block.sb3Toolchain.memberId}:${block.text}`
              : `original-label:${block.text}`
            : block.blockType === runtime.Scratch.BlockType.XML &&
                block.sb3Toolchain?.kind === 'bundle-member-docs'
              ? `bundle-docs:${block.sb3Toolchain.memberId}:${block.sb3Toolchain.docsURI}`
              : block.opcode,
      ),
      [
        'bundle-label:alpha:◆ Alpha Tools [alpha] ◆',
        'bundle-docs:alpha:https://example.com/alpha?a=1&b="two"',
        'alpha__value',
        'original-label:Alpha original heading',
        'separator',
        'alpha__selected',
        'alpha__fire',
        'alpha__whenReady',
        'alpha__callOpcode',
        'separator',
        'separator',
        'bundle-label:beta:◆ Beta Tools [beta] ◆',
        'beta__value',
        'beta__echo',
      ],
    );
    const alphaDocs = info.blocks.find(
      (block) =>
        block?.sb3Toolchain?.kind === 'bundle-member-docs' &&
        block.sb3Toolchain.memberId === 'alpha',
    );
    assert.equal(
      alphaDocs.xml,
      '<button text="Open Documentation" callbackKey="OPEN_EXTENSION_DOCS" callbackData="https://example.com/alpha?a=1&amp;b=&quot;two&quot;"></button>',
    );
    assert.equal(
      info.blocks.some(
        (block) =>
          block?.sb3Toolchain?.kind === 'bundle-member-docs' &&
          block.sb3Toolchain.memberId === 'beta',
      ),
      false,
    );
    const blockByOpcode = new Map(
      info.blocks
        .filter((block) => block && typeof block === 'object' && typeof block.opcode === 'string')
        .map((block) => [block.opcode, block]),
    );
    assert.equal(
      blockByOpcode.get('alpha__value').blockIconURI,
      'data:image/svg+xml,%3Csvg%20id%3D%22alpha-default%22%2F%3E',
    );
    assert.equal(
      blockByOpcode.get('alpha__selected').blockIconURI,
      'data:image/svg+xml,%3Csvg%20id%3D%22alpha-selected%22%2F%3E',
    );
    assert.equal(blockByOpcode.get('beta__value').blockIconURI, undefined);
    assert.equal(
      info.blocks.find((block) => block?.sb3Toolchain?.kind === 'bundle-member-heading')
        .blockIconURI,
      undefined,
    );
    assert.equal(composite.alpha__value(), 'alpha:1');
    assert.equal(project.extensionStorage.projectbundle.components.alpha.calls, 1);
    assert.deepEqual(Array.from(composite.alpha__menu__ITEMS()), ['one', 'two']);
    composite.alpha__fire();
    assert.deepEqual(runtime.startedHats, ['projectbundle_alpha__whenReady']);

    runtime.opcodeFunctions.set('projectbundle_alpha__selected', (args, util) =>
      composite.alpha__selected(args, util),
    );
    const selfPayload = {ITEM: 'self member'};
    const selfUtil = {marker: 'self'};
    assert.equal(
      composite.alpha__callOpcode(
        {
          LOOKUP: 'self lookup',
          OPCODE: 'alpha_selected',
          PAYLOAD: selfPayload,
        },
        selfUtil,
      ),
      'self member',
    );

    let crossMemberArguments;
    let crossMemberReceiver;
    let crossMemberPromise;
    const expectedReceiver = {id: 'registered-opcode-handler'};
    runtime.opcodeFunctions.set(
      'projectbundle_beta__echo',
      function (args, util) {
        crossMemberArguments = {args, util};
        crossMemberReceiver = this;
        crossMemberPromise = composite.beta__echo(args, util);
        return crossMemberPromise;
      }.bind(expectedReceiver),
    );
    const crossMemberPayload = {VALUE: 'Fish1'};
    const crossMemberUtil = {marker: 'asset-manager'};
    const dynamicResult = composite.alpha__callOpcode(
      {
        LOOKUP: 'cross-member lookup',
        OPCODE: 'beta_echo',
        PAYLOAD: crossMemberPayload,
      },
      crossMemberUtil,
    );
    assert.equal(dynamicResult, crossMemberPromise);
    assert.equal(crossMemberArguments.args, crossMemberPayload);
    assert.equal(crossMemberArguments.util, crossMemberUtil);
    assert.equal(crossMemberReceiver, expectedReceiver);
    assert.equal(await dynamicResult, 'beta:Fish1:asset-manager');

    runtime.opcodeFunctions.set('pen_clear', () => 'core opcode');
    assert.equal(composite.alpha__callOpcode({OPCODE: 'pen_clear'}), 'core opcode');
    runtime.opcodeFunctions.set('external_ping', () => 'external opcode');
    assert.equal(composite.alpha__callOpcode({OPCODE: 'external_ping'}), 'external opcode');
    assert.equal(composite.alpha__callOpcode({OPCODE: 'unknown_opcode'}), undefined);
    assert.deepEqual(
      runtime.opcodeLookups.map(({args, opcode, receiver}) => ({
        args: Array.from(args),
        opcode,
        receiverIsRuntime: receiver === runtime.runtime,
      })),
      [
        {
          args: ['self lookup'],
          opcode: 'projectbundle_alpha__selected',
          receiverIsRuntime: true,
        },
        {
          args: ['cross-member lookup'],
          opcode: 'projectbundle_beta__echo',
          receiverIsRuntime: true,
        },
        {args: [undefined], opcode: 'pen_clear', receiverIsRuntime: true},
        {args: [undefined], opcode: 'external_ping', receiverIsRuntime: true},
        {args: [undefined], opcode: 'unknown_opcode', receiverIsRuntime: true},
      ],
    );

    const bundledSb3Path = path.join(directory, 'bundled.sb3');
    const unbundledSb3Path = path.join(directory, 'unbundled.sb3');
    await writeFile(bundledSb3Path, first.archive);
    const archiveDryRun = await planBundledSb3Unbundle({
      bundleId: 'projectbundle',
      inputPath: bundledSb3Path,
      outputPath: unbundledSb3Path,
    });
    assert.equal(archiveDryRun.applied, false);
    await assert.rejects(readFile(unbundledSb3Path), {code: 'ENOENT'});
    const archiveUnbundle = await unbundleSb3({
      bundleId: 'projectbundle',
      inputPath: bundledSb3Path,
      outputPath: unbundledSb3Path,
      yes: true,
    });
    assert.equal(archiveUnbundle.applied, true);
    const unbundledArchive = unzipSync(await readFile(unbundledSb3Path));
    const unbundledProject = JSON.parse(strFromU8(unbundledArchive['project.json']));
    assert.deepEqual(unbundledProject.extensions, ['alpha', 'beta']);
    assert.deepEqual(Object.keys(unbundledProject.extensionURLs), ['alpha', 'beta', 'external']);
    assert.equal(decodeDataUrl(unbundledProject.extensionURLs.alpha), alphaSource);
    assert.equal(decodeDataUrl(unbundledProject.extensionURLs.beta), betaSource);
    assert.deepEqual(Object.keys(unbundledProject.targets[0].blocks), [
      'alphaValue',
      'betaValue',
      'dynamic',
    ]);
    assert.deepEqual(
      Object.values(unbundledProject.targets[0].blocks).map((block) => block.opcode),
      ['alpha_value', 'beta_value', 'alpha_selected'],
    );

    const removalPlan = await planExtensionUnbundle({
      bundleId: 'projectbundle',
      sourceDirectory,
    });
    assert.equal(removalPlan.applied, false);
    const removed = await unbundleExtensions({
      bundleId: 'projectbundle',
      sourceDirectory,
      yes: true,
    });
    assert.equal(removed.applied, true);
    const restored = await createDeterministicSb3(sourceDirectory);
    const restoredProject = JSON.parse(strFromU8(unzipSync(restored.archive)['project.json']));
    assert.deepEqual(restoredProject.extensions, ['alpha', 'beta']);
    assert.deepEqual(Object.keys(restoredProject.extensionURLs), ['alpha', 'beta', 'external']);
    assert.deepEqual(
      Object.values(restoredProject.targets[0].blocks).map((block) => block.opcode),
      ['alpha_value', 'beta_value', 'alpha_selected'],
    );
    assert.equal(
      restoredProject.targets[0].blocks.dynamic.mutation.blockInfo.opcode,
      'alpha_selected',
    );
    assert.equal(restoredProject.monitors[0].opcode, 'alpha_value');
    assert.deepEqual(await readFile(unbundledSb3Path), Buffer.from(restored.archive));
    const comparison = await compareDirectories(pristineDirectory, sourceDirectory);
    assert.equal(comparison.identical, true);
  });
});

test('unbundles supported edits in an SB3 and rejects irreversible archive changes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeBundleSource(sourceDirectory);
    await bundleExtensions({
      bundleId: 'projectbundle',
      bundleName: 'Project Extension Bundle',
      extensionIds: ['alpha', 'beta'],
      sourceDirectory,
      yes: true,
    });
    const built = await createDeterministicSb3(sourceDirectory);
    const project = JSON.parse(strFromU8(unzipSync(built.archive)['project.json']));
    project.targets[0].blocks.addedAfterBundle = {
      opcode: 'projectbundle_beta__value',
      parent: null,
    };
    const editedInputPath = path.join(directory, 'edited.sb3');
    const editedOutputPath = path.join(directory, 'edited-unbundled.sb3');
    await writeFile(editedInputPath, archiveWithProject(built.archive, project));
    await unbundleSb3({
      bundleId: 'projectbundle',
      inputPath: editedInputPath,
      outputPath: editedOutputPath,
      yes: true,
    });
    const restoredProject = JSON.parse(
      strFromU8(unzipSync(await readFile(editedOutputPath))['project.json']),
    );
    assert.equal(restoredProject.targets[0].blocks.addedAfterBundle.opcode, 'beta_value');
    assert.equal(restoredProject.targets[0].blocks.addedAfterBundle.parent, null);

    const missingCapsuleProject = structuredClone(project);
    const bundleSource = decodeDataUrl(missingCapsuleProject.extensionURLs.projectbundle);
    missingCapsuleProject.extensionURLs.projectbundle = `data:text/javascript;base64,${Buffer.from(
      bundleSource.replace(/^\/\/ SB3-Toolchain-Reversible-Bundle-v1: .*\n/mu, ''),
    ).toString('base64')}`;
    const missingCapsulePath = path.join(directory, 'missing-capsule.sb3');
    await writeFile(missingCapsulePath, archiveWithProject(built.archive, missingCapsuleProject));
    await assert.rejects(
      planBundledSb3Unbundle({
        bundleId: 'projectbundle',
        inputPath: missingCapsulePath,
        outputPath: path.join(directory, 'never.sb3'),
      }),
      /has no SB3-Toolchain-Reversible-Bundle-v1 recovery capsule/u,
    );

    const changedOrderProject = structuredClone(project);
    changedOrderProject.extensions.push('laterextension');
    const changedOrderPath = path.join(directory, 'changed-order.sb3');
    await writeFile(changedOrderPath, archiveWithProject(built.archive, changedOrderProject));
    await assert.rejects(
      planBundledSb3Unbundle({
        bundleId: 'projectbundle',
        inputPath: changedOrderPath,
        outputPath: path.join(directory, 'never-order.sb3'),
      }),
      /Cannot safely restore project\.extensions order/u,
    );

    const unknownReferenceProject = structuredClone(project);
    unknownReferenceProject.meta.unclassified = 'projectbundle_alpha__value';
    const unknownReferencePath = path.join(directory, 'unknown-reference.sb3');
    await writeFile(
      unknownReferencePath,
      archiveWithProject(built.archive, unknownReferenceProject),
    );
    await assert.rejects(
      planBundledSb3Unbundle({
        bundleId: 'projectbundle',
        inputPath: unknownReferencePath,
        outputPath: path.join(directory, 'never-reference.sb3'),
      }),
      /has unsupported references at/u,
    );
  });
});

test('unbundles multiple reversible bundles in either order', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeBundleSource(sourceDirectory);
    await Promise.all([
      writeFile(path.join(sourceDirectory, 'extensions/gamma.js'), gammaSource),
      writeFile(path.join(sourceDirectory, 'extensions/delta.js'), deltaSource),
    ]);
    const manifestPath = path.join(sourceDirectory, 'embedded-extensions.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const entryById = new Map(manifest.extensions.map((extension) => [extension.id, extension]));
    manifest.extensions = [
      entryById.get('alpha'),
      {
        id: 'gamma',
        path: 'extensions/gamma.js',
        mediaType: 'text/javascript',
        parameters: [],
        encoding: 'base64',
      },
      entryById.get('beta'),
      {
        id: 'delta',
        path: 'extensions/delta.js',
        mediaType: 'text/javascript',
        parameters: [],
        encoding: 'base64',
      },
    ];
    await writeJson(manifestPath, manifest);
    const projectPath = path.join(sourceDirectory, 'project.source.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    project.extensions = ['alpha', 'gamma', 'beta', 'delta'];
    project.extensionURLs = {
      alpha: project.extensionURLs.alpha,
      gamma: 'embedded-extension:extensions/gamma.js',
      beta: project.extensionURLs.beta,
      delta: 'embedded-extension:extensions/delta.js',
      external: project.extensionURLs.external,
    };
    await writeJson(projectPath, project);
    const original = await createDeterministicSb3(sourceDirectory);

    await bundleExtensions({
      bundleId: 'firstbundle',
      bundleName: 'First Bundle',
      extensionIds: ['alpha', 'beta'],
      sourceDirectory,
      yes: true,
    });
    await bundleExtensions({
      bundleId: 'secondbundle',
      bundleName: 'Second Bundle',
      extensionIds: ['gamma', 'delta'],
      sourceDirectory,
      yes: true,
    });
    const bundled = await createDeterministicSb3(sourceDirectory);
    const bundledPath = path.join(directory, 'two-bundles.sb3');
    const firstOutputPath = path.join(directory, 'first-unbundled.sb3');
    const secondOutputPath = path.join(directory, 'both-unbundled.sb3');
    await writeFile(bundledPath, bundled.archive);

    await unbundleSb3({
      bundleId: 'firstbundle',
      inputPath: bundledPath,
      outputPath: firstOutputPath,
      yes: true,
    });
    const partlyRestoredProject = JSON.parse(
      strFromU8(unzipSync(await readFile(firstOutputPath))['project.json']),
    );
    assert.deepEqual(partlyRestoredProject.extensions, ['alpha', 'secondbundle', 'beta']);
    await unbundleSb3({
      bundleId: 'secondbundle',
      inputPath: firstOutputPath,
      outputPath: secondOutputPath,
      yes: true,
    });
    assert.deepEqual(await readFile(secondOutputPath), Buffer.from(original.archive));
  });
});

test('rejects bundle inputs that cannot be transformed without behavior risk', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDirectory = path.join(directory, 'source');
    await writeBundleSource(sourceDirectory);

    await assert.rejects(
      planExtensionBundle({
        bundleId: 'alpha',
        bundleName: 'Collision',
        extensionIds: ['alpha', 'beta'],
        sourceDirectory,
      }),
      /collides with an extension/u,
    );

    const betaPath = path.join(sourceDirectory, 'extensions/beta.js');
    await writeFile(betaPath, betaSource.replace('// License: MIT\n', ''));
    await assert.rejects(
      planExtensionBundle({
        bundleId: 'projectbundle',
        bundleName: 'Project Extension Bundle',
        extensionIds: ['alpha', 'beta'],
        sourceDirectory,
      }),
      /requires a \/\/ License: header/u,
    );

    await writeFile(betaPath, `${betaSource}Scratch.extensions.register(new Extra());\n`);
    await assert.rejects(
      planExtensionBundle({
        bundleId: 'projectbundle',
        bundleName: 'Project Extension Bundle',
        extensionIds: ['alpha', 'beta'],
        sourceDirectory,
      }),
      /exactly one synchronous Scratch\.extensions\.register call/u,
    );
  });
});

test('parses reversible bundle and unbundle CLI commands', () => {
  assert.deepEqual(
    parseCliArguments([
      'extensions',
      'bundle',
      'custom-source',
      '--id',
      'projectbundle',
      '--name',
      'Project Extension Bundle',
      'alpha',
      'beta',
      '--yes',
    ]),
    {
      action: 'bundle',
      bundleId: 'projectbundle',
      bundleName: 'Project Extension Bundle',
      command: 'extensions',
      extensionIds: ['alpha', 'beta'],
      sourceDirectory: path.resolve('custom-source'),
      yes: true,
    },
  );
  assert.deepEqual(
    parseCliArguments(['extensions', 'unbundle', 'custom-source', 'projectbundle', '--yes']),
    {
      action: 'unbundle',
      bundleId: 'projectbundle',
      command: 'extensions',
      sourceDirectory: path.resolve('custom-source'),
      yes: true,
    },
  );
  assert.deepEqual(
    parseCliArguments([
      'extensions',
      'unbundle',
      'bundled.sb3',
      'projectbundle',
      '--output',
      'unbundled.sb3',
      '--yes',
    ]),
    {
      action: 'unbundle',
      bundleId: 'projectbundle',
      command: 'extensions',
      inputPath: path.resolve('bundled.sb3'),
      outputPath: path.resolve('unbundled.sb3'),
      yes: true,
    },
  );
});
