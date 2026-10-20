// SPDX-License-Identifier: MPL-2.0

import vm from 'node:vm';
import {expect, test} from 'vitest';
import {
  buildExtensionBundles,
  validateExtensionBundleConfigurations,
} from '../src/extension-bundle';

const methods = [
  'registerSchema',
  'registerSchemaBundle',
  'registerSourceEditor',
  'registerFixedInputEditor',
];
const extensions = ['alpha', 'beta'].map((id) => ({
  id,
  path: `extensions/${id}.js`,
  mediaType: 'text/javascript',
  parameters: [],
  encoding: 'base64' as const,
}));
const configuration = {id: 'bundle', name: 'Bundle', members: ['alpha', 'beta']};
function source(id: string, method: string, patch: Record<string, unknown> = {}): Uint8Array {
  return Buffer.from(`// Name: ${id}\n// ID: ${id}\n// By: Test\n// Description: Editor registration fixture\n// License: MIT\n
(function(Scratch){
  Scratch.extensions.register({getInfo(){return {id:'${id}', name:'${id}',blocks:[]};}});
  const definition={apiVersion:1,extensionId:'${id}',editorId:'profile',opcodes:['${id}_edit'],bindings:[{decode:value=>value}],validationContext:()=>null};
  Object.assign(definition, ${JSON.stringify(patch)});
  const api=Scratch.gui?.blockEditors;
  if(typeof api?.${method}==='function') {
    Scratch.probes.push({definition, remove:api.${method}(definition)});
  }
})(Scratch);`);
}
function evaluate(
  method: string,
  enabled?: boolean,
  api?: unknown,
  patch: Record<string, unknown> = {},
) {
  const built = buildExtensionBundles({
    extensionBundles: [
      {...configuration, ...(enabled === undefined ? {} : {blockEditorRegistrations: enabled})},
    ],
    extensionContents: new Map(['alpha', 'beta'].map((id) => [id, source(id, method, patch)])),
    extensions,
    project: {
      targets: [],
      extensions: ['alpha', 'beta'],
      extensionURLs: {
        alpha: 'embedded-extension:extensions/alpha.js',
        beta: 'embedded-extension:extensions/beta.js',
      },
    },
  });
  const registrations: any[] = [];
  const probes: any[] = [];
  const Scratch: any = {
    extensions: {unsandboxed: true, register: (value: unknown) => registrations.push(value)},
    probes,
  };
  if (api !== undefined) Scratch.gui = Object.freeze({blockEditors: api, unrelatedCapability: 123});
  const generated = built.extensionContents.get('bundle')!;
  vm.runInNewContext(Buffer.from(generated).toString(), {Scratch});
  return {probes, registrations, generated};
}
for (const method of methods) {
  test(`rewrites ${method} identities and preserves callbacks, data and disposers`, () => {
    const received: any[] = [];
    const remove = () => {};
    const api = Object.freeze({
      apiVersion: 1,
      [method]: function (this: unknown, definition: unknown) {
        expect(this).toBe(api);
        received.push(definition);
        return remove;
      },
    });
    const {probes, registrations} = evaluate(method, true, api);
    expect(registrations).toHaveLength(1);
    expect(
      received.map((d) => ({extensionId: d.extensionId, editorId: d.editorId, opcodes: d.opcodes})),
    ).toEqual([
      {extensionId: 'bundle', editorId: 'alpha__profile', opcodes: ['bundle_alpha__edit']},
      {extensionId: 'bundle', editorId: 'beta__profile', opcodes: ['bundle_beta__edit']},
    ]);
    for (const [index, probe] of probes.entries()) {
      expect(probe.definition.extensionId).toBe(index === 0 ? 'alpha' : 'beta');
      expect(received[index].bindings).toBe(probe.definition.bindings);
      expect(received[index].validationContext).toBe(probe.definition.validationContext);
      expect(probe.remove).toBe(remove);
    }
  });
}
test('registration adaptation is disabled unless explicitly enabled', () => {
  for (const enabled of [undefined, false]) {
    const received: any[] = [];
    const api = Object.freeze({
      apiVersion: 1,
      registerSourceEditor: (d: unknown) => received.push(d),
    });
    const result = evaluate('registerSourceEditor', enabled, api);
    expect(received[0]).toBe(result.probes[0].definition);
    expect(received[0].opcodes).toEqual(['alpha_edit']);
    expect(Buffer.from(result.generated).toString()).not.toContain('createComponentGui');
  }
});
test('missing GUI, hidden capability and unsupported API remain usable runtimes', () => {
  for (const api of [undefined, Object.freeze({apiVersion: 1}), Object.freeze({apiVersion: 2})]) {
    const result = evaluate('registerSourceEditor', true, api);
    expect(result.registrations).toHaveLength(1);
    expect(result.probes).toHaveLength(0);
  }
});
test('configuration validates and preserves the startup option', () => {
  expect(
    validateExtensionBundleConfigurations(
      [{...configuration, blockEditorRegistrations: true}],
      extensions,
    )[0].blockEditorRegistrations,
  ).toBe(true);
  expect(validateExtensionBundleConfigurations([configuration], extensions)[0]).not.toHaveProperty(
    'blockEditorRegistrations',
  );
  expect(() =>
    validateExtensionBundleConfigurations(
      [{...configuration, blockEditorRegistrations: '1'}],
      extensions,
    ),
  ).toThrow('blockEditorRegistrations must be a boolean');
});

test('unknown API versions retain their own registration protocol', () => {
  const received: any[] = [];
  const api = Object.freeze({
    apiVersion: 2,
    registerSourceEditor: (d: unknown) => received.push(d),
  });
  const result = evaluate('registerSourceEditor', true, api);
  expect(received[0]).toBe(result.probes[0].definition);
  expect(received[0].extensionId).toBe('alpha');
});

for (const patch of [{extensionId: 'foreign'}, {opcodes: ['foreign_edit']}]) {
  test(`rejects a foreign registration before calling the GUI: ${JSON.stringify(patch)}`, () => {
    const received: unknown[] = [];
    const api = Object.freeze({
      apiVersion: 1,
      registerSourceEditor: (d: unknown) => received.push(d),
    });
    expect(() => evaluate('registerSourceEditor', true, api, patch)).toThrow(
      /Invalid block editor/,
    );
    expect(received).toHaveLength(0);
  });
}
