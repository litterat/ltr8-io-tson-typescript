import { describe, expect, it } from 'vitest';

import { flattenSchema } from '../src/compiler/referenceFlattener.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { Reference, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

function ref(name: string, args: readonly TypeRef[] = []): TypeRef {
  return {
    name,
    arguments: args.map((r) => ({ kind: 'ref' as const, ref: r })),
    annotations: [],
  };
}

/** A plain, non-reference PRODUCT entry with a fixed record body -- most tests just need one field to flatten. */
function recordOf(fieldType: TypeRef): TypeDefinition {
  const body: RecordBody = {
    kind: 'record',
    supertypes: [],
    fields: [{ name: 'v', type: fieldType, state: 'REQUIRED', annotations: [] }],
    groups: [],
  };
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

/** A REFERENCE entry -- an alias to `target`. */
function aliasOf(target: TypeRef): TypeDefinition {
  const body: Reference = { kind: 'reference', target };
  return {
    kind: 'REFERENCE',
    source: target,
    parameters: [],
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

function fieldType(definition: TypeDefinition): TypeRef {
  const body = definition.body as RecordBody;
  const type = body.fields[0]?.type;
  if (type === undefined) throw new Error('expected a first field');
  return type;
}

/** A `Map.get` that fails loudly instead of a non-null assertion -- every call site here is safe by construction. */
function entryOf(map: ReadonlyMap<string, TypeDefinition>, name: string): TypeDefinition {
  const value = map.get(name);
  if (value === undefined) throw new Error(`missing test fixture entry '${name}'`);
  return value;
}

function isReferenceBody(body: TypeDefinition['body']): body is Reference {
  return 'kind' in body && body.kind === 'reference';
}

function referenceBody(definition: TypeDefinition): Reference {
  if (!isReferenceBody(definition.body)) {
    throw new Error('expected a reference body');
  }
  return definition.body;
}

// ── §8.3 flattening ──────────────────────────────────────────────────────────────────────────

describe('flattening a use site naming a REFERENCE entry (§8.3)', () => {
  it('rewrites the use site to the end of the alias chain and records @alias', () => {
    // doc => documentation => text
    const namespace = new Map<string, TypeDefinition>([
      ['text', recordOf(ref('unit'))],
      ['documentation', aliasOf(ref('text'))],
      ['doc', aliasOf(ref('documentation'))],
      ['user', recordOf(ref('doc'))],
    ]);
    const flattened = flattenSchema(
      new Map([['user', entryOf(namespace, 'user')]]),
      namespace,
      new Set(),
    );
    const type = fieldType(entryOf(flattened, 'user'));
    expect(type.name).toBe('text');
    expect(type.annotations).toEqual([{ name: 'alias', value: 'doc' }]);
  });

  it('leaves a use site that already names a non-reference entry untouched', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['text', recordOf(ref('unit'))],
      ['user', recordOf(ref('text'))],
    ]);
    const entries = new Map([['user', entryOf(namespace, 'user')]]);
    const flattened = flattenSchema(entries, namespace, new Set());
    // Nothing moved, so the entry comes back unchanged (content, if not necessarily identity --
    // `templates.ts`'s own `mapBodyRefs` always rebuilds a record body's own field array).
    expect(flattened.get('user')).toEqual(entries.get('user'));
    expect(fieldType(entryOf(flattened, 'user'))).toEqual(fieldType(entryOf(entries, 'user')));
  });

  it("leaves an alias entry's own target exactly as resolved -- only use sites flatten", () => {
    const namespace = new Map<string, TypeDefinition>([
      ['text', recordOf(ref('unit'))],
      ['documentation', aliasOf(ref('text'))],
      ['doc', aliasOf(ref('documentation'))],
    ]);
    const entries = new Map([['doc', entryOf(namespace, 'doc')]]);
    const flattened = flattenSchema(entries, namespace, new Set());
    expect(flattened.get('doc')).toBe(entries.get('doc'));
    expect(referenceBody(entryOf(flattened, 'doc')).target.name).toBe('documentation');
  });

  it("recurses into a type-ref's own arguments, flattening a nested alias too", () => {
    const namespace = new Map<string, TypeDefinition>([
      ['text', recordOf(ref('unit'))],
      ['doc', aliasOf(ref('text'))],
      ['box', { ...recordOf(ref('unit')), parameters: ['T'] }],
      ['user', recordOf(ref('box', [ref('doc')]))],
    ]);
    const flattened = flattenSchema(
      new Map([['user', entryOf(namespace, 'user')]]),
      namespace,
      new Set(),
    );
    const type = fieldType(entryOf(flattened, 'user'));
    expect(type.name).toBe('box');
    const [argument] = type.arguments;
    if (argument?.kind !== 'ref') throw new Error('expected a ref argument');
    expect(argument.ref.name).toBe('text');
    expect(argument.ref.annotations).toEqual([{ name: 'alias', value: 'doc' }]);
  });

  it('stops at a materialised instantiation rather than walking through it', () => {
    // string_triple => vector<text, 3> -- an alias TO an application, minted by materialisation.
    const namespace = new Map<string, TypeDefinition>([
      ['array_text_3', recordOf(ref('unit'))], // the minted instantiation itself
      ['string_triple', aliasOf(ref('array_text_3'))],
      ['user', recordOf(ref('string_triple'))],
    ]);
    const flattened = flattenSchema(
      new Map([['user', entryOf(namespace, 'user')]]),
      namespace,
      new Set(['array_text_3']),
    );
    const type = fieldType(entryOf(flattened, 'user'));
    expect(type.name).toBe('array_text_3');
    expect(type.annotations).toEqual([{ name: 'alias', value: 'string_triple' }]);
  });

  it('does not walk through an argument-bearing reference target -- an application, not a further hop', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['box', { ...recordOf(ref('unit')), parameters: ['T'] }],
      // partial => <B> box<B> -- open, so its target still carries an argument.
      ['partial', { ...aliasOf(ref('box', [ref('B')])), parameters: ['B'] }],
    ]);
    const flattened = flattenSchema(
      new Map([['partial', entryOf(namespace, 'partial')]]),
      namespace,
      new Set(),
    );
    // An alias entry's own target is never rewritten (only use sites are); confirm it survived whole.
    expect(referenceBody(entryOf(flattened, 'partial')).target.arguments.length).toBe(1);
  });

  it('stops a reference cycle at the name that closes it rather than looping forever', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['a', aliasOf(ref('b'))],
      ['b', aliasOf(ref('a'))],
      ['user', recordOf(ref('a'))],
    ]);
    const flattened = flattenSchema(
      new Map([['user', entryOf(namespace, 'user')]]),
      namespace,
      new Set(),
    );
    // Terminates (does not hang) and names one of the two cycle members.
    expect(['a', 'b']).toContain(fieldType(entryOf(flattened, 'user')).name);
  });

  it('leaves a name absent from the namespace (an unverified reference) exactly as written', () => {
    const namespace = new Map<string, TypeDefinition>([['user', recordOf(ref('nowhere'))]]);
    const flattened = flattenSchema(
      new Map([['user', entryOf(namespace, 'user')]]),
      namespace,
      new Set(),
    );
    expect(fieldType(entryOf(flattened, 'user')).name).toBe('nowhere');
  });
});
