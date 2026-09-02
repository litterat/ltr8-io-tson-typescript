import { describe, expect, it } from 'vitest';

import {
  createTemplateMaterialiser,
  type TemplateMaterialiserDeps,
} from '../src/compiler/templates.js';
import { createHeldBody } from '../src/compiler/heldBody.js';
import { heldRecord } from '../src/compiler/wireForm.js';
import { metaFormOfLexer } from '../src/compiler/tokenForms.js';
import { TsonNotImplementedError, TsonSchemaValidationError } from '../src/core/errors.js';
import type { DataValue, RecordValue, TokenValue } from '../src/ast/value.js';
import type { ArrayBody, RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import type {
  Reference,
  Top,
  TypeArgument,
  TypeDefinition,
  TypeRef,
} from '../src/schema/meta/typedef.js';

// ── Test fixtures ────────────────────────────────────────────────────────────────────────────

/** A one-argument value reference (`text`, `uuid`, ...), the shape a bare declared type resolves to. */
function ref(name: string): TypeArgument {
  return { kind: 'ref', ref: { name, arguments: [], annotations: [] } };
}

function refTo(typeRef: TypeRef): TypeArgument {
  return { kind: 'ref', ref: typeRef };
}

function literal(text: string): TypeArgument {
  return { kind: 'value', value: { text, form: 'UNQUOTED' } };
}

/** `<params> => { field: type ... }` -- a record template, held the way `definitionResolver.ts` holds one. */
function recordTemplate(parameters: readonly string[], body: RecordBody): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters,
    constructor: false,
    supertypes: [],
    subtypes: [],
    body: createHeldBody(heldRecord(body)),
    annotations: [],
  };
}

function field(name: string, type: TypeRef, state: RecordField['state'] = 'REQUIRED'): RecordField {
  return { name, type, annotations: [], state };
}

/**
 * A minimal stand-in for a compiled `record`/`array` constructor reader, decoding the same wire
 * shapes `heldBody.ts`'s own `heldRecord`/`metaRefValue` produce -- enough to exercise real
 * substitution and closure end to end rather than mocking the bound body away.
 */
function readTypeRefField(record: RecordValue, name: string): TypeRef {
  const value = record.fields.find((f) => f.name === name)?.value.value.coreValue;
  if (value === undefined) throw new Error(`missing '${name}'`);
  if (value.kind === 'token') return { name: value.text, arguments: [], annotations: [] };
  const nameField = (value as RecordValue).fields.find((f) => f.name === 'name');
  const argsField = (value as RecordValue).fields.find((f) => f.name === 'arguments');
  const head = (nameField?.value.value.coreValue as TokenValue).text;
  const args: TypeArgument[] = [];
  if (argsField?.value.value.coreValue.kind === 'array') {
    for (const element of argsField.value.value.coreValue.elements) {
      const argRecord = element.value.coreValue as RecordValue;
      const valueMember = argRecord.fields.find((f) => f.name === 'value');
      if (valueMember !== undefined) {
        const token = valueMember.value.value.coreValue as TokenValue;
        args.push({
          kind: 'value',
          value: { text: token.text, form: metaFormOfLexer(token.form) },
        });
      } else {
        args.push(refTo(readTypeRefField(argRecord, 'name')));
      }
    }
  }
  return { name: head, arguments: args, annotations: [] };
}

function testMetaReader(type: string, value: DataValue): Top {
  const record = value.coreValue as RecordValue;
  if (type === 'record') {
    const fieldsField = record.fields.find((f) => f.name === 'fields');
    const fields: RecordField[] = [];
    if (fieldsField?.value.value.coreValue.kind === 'array') {
      for (const element of fieldsField.value.value.coreValue.elements) {
        const fieldRecord = element.value.coreValue as RecordValue;
        const fname = (
          fieldRecord.fields.find((f) => f.name === 'name')?.value.value.coreValue as TokenValue
        ).text;
        const ftype = readTypeRefField(fieldRecord, 'type');
        fields.push({ name: fname, type: ftype, state: 'REQUIRED', annotations: [] });
      }
    }
    const body: RecordBody = { kind: 'record', supertypes: [], fields, groups: [] };
    return body;
  }
  if (type === 'array') {
    const elementType = readTypeRefField(record, 'element_type');
    return {
      kind: 'array',
      elementType,
      state: 'REQUIRED',
      unordered: false,
      uniqueItems: false,
    };
  }
  throw new Error(`testMetaReader: unhandled constructor '${type}'`);
}

/** A materialiser wired over a growing shared namespace, the way a real caller wires one. */
interface HarnessOverrides {
  readonly namespaceDefinitions?: TemplateMaterialiserDeps['namespaceDefinitions'];
  readonly publish?: TemplateMaterialiserDeps['publish'];
  readonly definitionMetaReader?: TemplateMaterialiserDeps['definitionMetaReader'];
  /** Build a materialiser with no reader at all, rather than falling back to {@link testMetaReader}. */
  readonly omitReader?: boolean;
  readonly generatedNames?: TemplateMaterialiserDeps['generatedNames'];
}

function harness(overrides: HarnessOverrides = {}): {
  namespace: Map<string, TypeDefinition>;
  materialiser: ReturnType<typeof createTemplateMaterialiser>;
  published: Map<string, TypeDefinition>;
} {
  const namespace = new Map<string, TypeDefinition>();
  const published = new Map<string, TypeDefinition>();
  const deps: TemplateMaterialiserDeps = {
    namespaceDefinitions: overrides.namespaceDefinitions ?? ((name) => namespace.get(name)),
    publish:
      overrides.publish ??
      ((name, definition) => {
        namespace.set(name, definition);
        published.set(name, definition);
      }),
    ...(overrides.omitReader === true
      ? {}
      : { definitionMetaReader: overrides.definitionMetaReader ?? testMetaReader }),
    ...(overrides.generatedNames === undefined ? {} : { generatedNames: overrides.generatedNames }),
  };
  return { namespace, published, materialiser: createTemplateMaterialiser(deps) };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected to throw, but it completed');
}

function isRecordBody(body: Top): body is RecordBody {
  return 'fields' in body;
}

function isArrayBody(body: Top): body is ArrayBody {
  return 'elementType' in body;
}

function isReferenceBody(body: Top): body is Reference {
  return 'target' in body;
}

// ── Record templates close to the instantiation itself (§5.10) ─────────────────────────────

describe('a record template closes to the instantiation entry itself', () => {
  it('substitutes a value argument into a field type, and the entry carries the flattened application as `source`', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [field('value', { name: 'T', arguments: [], annotations: [] })],
      }),
    );
    const name = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('text')],
      annotations: [],
    });
    const entry = namespace.get(name);
    if (entry === undefined || !isRecordBody(entry.body)) throw new Error('unreachable');
    expect(entry.kind).toBe('PRODUCT');
    expect(entry.source).toEqual({ name: 'box', arguments: [ref('text')], annotations: [] });
    expect(entry.body.fields[0]).toMatchObject({
      name: 'value',
      type: { name: 'text', arguments: [] },
    });
  });

  it('two applications of the same template to the same argument land on one entry (§8.2 identity)', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [field('value', { name: 'T', arguments: [], annotations: [] })],
      }),
    );
    const first = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('text')],
      annotations: [],
    });
    const second = materialiser.closeApplication({
      name: 'box',
      // A structurally-equal but freshly-built argument list -- identity must not depend on
      // object identity, only on the application's own structure.
      arguments: [{ kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } }],
      annotations: [],
    });
    expect(second).toBe(first);
    // Closing on demand publishes exactly once -- the second call finds the memo, not a rebuild.
    expect([...namespace.keys()].filter((k) => k === first)).toHaveLength(1);
  });

  it('is independent of §4.3-equivalent argument spellings: `<255>` and `<0xFF>` name one entry', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'sized',
      recordTemplate(['N'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [field('n', { name: 'integer', arguments: [], annotations: [] })],
      }),
    );
    const decimal = materialiser.closeApplication({
      name: 'sized',
      arguments: [literal('255')],
      annotations: [],
    });
    const hex = materialiser.closeApplication({
      name: 'sized',
      arguments: [literal('0xFF')],
      annotations: [],
    });
    expect(hex).toBe(decimal);
    // `1` and `1.0` resolve to different base types (§4) and stay two entries despite one magnitude.
    const asFloat = materialiser.closeApplication({
      name: 'sized',
      arguments: [literal('255.0')],
      annotations: [],
    });
    expect(asFloat).not.toBe(decimal);
  });

  it('closes arguments innermost-first, so a nested application names the inner entry before the outer one', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [field('value', { name: 'T', arguments: [], annotations: [] })],
      }),
    );
    const outerName = materialiser.closeApplication({
      name: 'box',
      arguments: [refTo({ name: 'box', arguments: [ref('text')], annotations: [] })],
      annotations: [],
    });
    const result = materialiser.materialise(new Map(namespace));
    const keys = [...result.materialised.keys()];
    const innerName = keys.find((k) => k !== outerName);
    if (innerName === undefined) throw new Error('unreachable');
    expect(keys.indexOf(innerName)).toBeLessThan(keys.indexOf(outerName));
    const outer = namespace.get(outerName);
    if (outer === undefined || !isRecordBody(outer.body)) throw new Error('unreachable');
    expect(outer.body.fields[0]?.type.name).toBe(innerName);
  });
});

// ── Open-instance templates close to a synthetic plus an instantiation reference ────────────

describe('an open-instance template mints a synthetic form plus a reference instantiation', () => {
  it('produces two entries: a REFERENCE instantiation naming the synthetic array form', () => {
    const { namespace, materialiser } = harness();
    // `<T> !array { element_type: T }` -- held directly, since the array constructor's own
    // vocabulary (not `record`) is what dispatches `closeHeldTemplate` rather than `closeHeldRecord`.
    namespace.set('wrapped', {
      kind: 'PRODUCT',
      parameters: ['T'],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: createHeldBody({
        annotations: [],
        typeRef: 'array',
        coreValue: {
          kind: 'record',
          fields: [
            {
              name: 'element_type',
              value: {
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: 'T', form: 'unquoted' },
                },
              },
            },
          ],
        },
      }),
      annotations: [],
    });
    const instantiationName = materialiser.closeApplication({
      name: 'wrapped',
      arguments: [ref('text')],
      annotations: [],
    });
    const instantiation = namespace.get(instantiationName);
    if (instantiation === undefined || !isReferenceBody(instantiation.body)) {
      throw new Error('unreachable');
    }
    expect(instantiation.kind).toBe('REFERENCE');
    expect(instantiation.source).toEqual({
      name: 'wrapped',
      arguments: [ref('text')],
      annotations: [],
    });
    const formName = instantiation.body.target.name;
    expect(materialiser.syntheticNames().has(formName)).toBe(true);
    const form = namespace.get(formName);
    if (form === undefined || !isArrayBody(form.body)) throw new Error('unreachable');
    expect(form.body.elementType).toEqual({ name: 'text', arguments: [], annotations: [] });
  });

  it('a generated head (desugar-injected) closes to its own form with no extra instantiation entry', () => {
    const { namespace, materialiser } = harness({ generatedNames: new Set(['array_p0']) });
    namespace.set('array_p0', {
      kind: 'PRODUCT',
      parameters: ['T'],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: createHeldBody({
        annotations: [],
        typeRef: 'array',
        coreValue: {
          kind: 'record',
          fields: [
            {
              name: 'element_type',
              value: {
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: 'T', form: 'unquoted' },
                },
              },
            },
          ],
        },
      }),
      annotations: [],
    });
    const result = materialiser.closeApplication({
      name: 'array_p0',
      arguments: [ref('uuid')],
      annotations: [],
    });
    // The form entry *is* the answer -- no second, REFERENCE-kind entry naming `array_p0<uuid>`.
    expect(namespace.get(result)?.kind).toBe('PRODUCT');
    expect(materialiser.syntheticNames().has(result)).toBe(true);
  });

  it('throws TsonNotImplementedError closing an open-instance template with no compiled meta reader supplied', () => {
    const { materialiser, namespace } = harness({ omitReader: true });
    namespace.set('wrapped', {
      kind: 'PRODUCT',
      parameters: ['T'],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: createHeldBody({
        annotations: [],
        typeRef: 'array',
        coreValue: {
          kind: 'record',
          fields: [
            {
              name: 'element_type',
              value: {
                value: {
                  annotations: [],
                  coreValue: { kind: 'token', text: 'T', form: 'unquoted' },
                },
              },
            },
          ],
        },
      }),
      annotations: [],
    });
    const error = thrownBy(() =>
      materialiser.closeApplication({ name: 'wrapped', arguments: [ref('text')], annotations: [] }),
    );
    expect(error).toBeInstanceOf(TsonNotImplementedError);
  });
});

// ── Reference (alias) templates mint no entry of their own (§5.10 partial application) ─────

describe('a reference template composes and mints nothing (§5.10 partial application)', () => {
  it('`uuid_pair => <B> pair<uuid, B>` closes to `pair<uuid, int32>` directly, minting no alias entry', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'pair',
      recordTemplate(['A', 'B'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [
          field('first', { name: 'A', arguments: [], annotations: [] }),
          field('second', { name: 'B', arguments: [], annotations: [] }),
        ],
      }),
    );
    namespace.set('uuid_pair', {
      kind: 'REFERENCE',
      parameters: ['B'],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: createHeldBody({
        annotations: [],
        typeRef: 'reference',
        coreValue: {
          kind: 'record',
          fields: [
            {
              name: 'target',
              value: {
                value: {
                  annotations: [],
                  coreValue: {
                    kind: 'record',
                    fields: [
                      {
                        name: 'name',
                        value: {
                          value: {
                            annotations: [],
                            coreValue: { kind: 'token', text: 'pair', form: 'unquoted' },
                          },
                        },
                      },
                      {
                        name: 'arguments',
                        value: {
                          value: {
                            annotations: [],
                            coreValue: {
                              kind: 'array',
                              elements: [
                                {
                                  value: {
                                    annotations: [],
                                    coreValue: {
                                      kind: 'record',
                                      fields: [
                                        {
                                          name: 'name',
                                          value: {
                                            value: {
                                              annotations: [],
                                              coreValue: {
                                                kind: 'token',
                                                text: 'uuid',
                                                form: 'unquoted',
                                              },
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                },
                                {
                                  value: {
                                    annotations: [],
                                    coreValue: {
                                      kind: 'record',
                                      fields: [
                                        {
                                          name: 'name',
                                          value: {
                                            value: {
                                              annotations: [],
                                              coreValue: {
                                                kind: 'token',
                                                text: 'B',
                                                form: 'unquoted',
                                              },
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      annotations: [],
    });
    const before = namespace.size;
    const closed = materialiser.closeApplication({
      name: 'uuid_pair',
      arguments: [ref('int32')],
      annotations: [],
    });
    // Exactly one new entry (the `pair<uuid, int32>` instantiation) -- no second entry for the alias hop.
    expect(namespace.size).toBe(before + 1);
    const entry = namespace.get(closed);
    if (entry === undefined) throw new Error('unreachable');
    expect(entry.source).toEqual({
      name: 'pair',
      arguments: [ref('uuid'), ref('int32')],
      annotations: [],
    });
  });

  it('a self-applying alias is a reported cycle, not a knot tied on nothing (§5.10)', () => {
    const { namespace, materialiser } = harness();
    namespace.set('loop', {
      kind: 'REFERENCE',
      parameters: ['T'],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: createHeldBody({
        annotations: [],
        typeRef: 'reference',
        coreValue: {
          kind: 'record',
          fields: [
            {
              name: 'target',
              value: {
                value: {
                  annotations: [],
                  coreValue: {
                    kind: 'record',
                    fields: [
                      {
                        name: 'name',
                        value: {
                          value: {
                            annotations: [],
                            coreValue: { kind: 'token', text: 'loop', form: 'unquoted' },
                          },
                        },
                      },
                      {
                        name: 'arguments',
                        value: {
                          value: {
                            annotations: [],
                            coreValue: {
                              kind: 'array',
                              elements: [
                                {
                                  value: {
                                    annotations: [],
                                    coreValue: {
                                      kind: 'record',
                                      fields: [
                                        {
                                          name: 'name',
                                          value: {
                                            value: {
                                              annotations: [],
                                              coreValue: {
                                                kind: 'token',
                                                text: 'T',
                                                form: 'unquoted',
                                              },
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      annotations: [],
    });
    const error = thrownBy(() =>
      materialiser.closeApplication({ name: 'loop', arguments: [ref('text')], annotations: [] }),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('reference template');
  });
});

// ── Recursion: knot-tying on the first repeat, a depth backstop on the rest (§5.10) ─────────

describe('recursion (§5.10)', () => {
  it('regular self-recursion (the argument passed through unchanged) ties the knot and terminates', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'tree',
      recordTemplate(['T'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [
          field('value', { name: 'T', arguments: [], annotations: [] }),
          field('child', {
            name: 'tree',
            arguments: [{ kind: 'ref', ref: { name: 'T', arguments: [], annotations: [] } }],
            annotations: [],
          }),
        ],
      }),
    );
    const name = materialiser.closeApplication({
      name: 'tree',
      arguments: [ref('text')],
      annotations: [],
    });
    // Exactly one entry: the knot ties on the entry under construction rather than recursing.
    expect([...namespace.values()].filter((d) => d.source?.name === 'tree')).toHaveLength(1);
    const entry = namespace.get(name);
    if (entry === undefined || !isRecordBody(entry.body)) throw new Error('unreachable');
    // The self-reference names the very entry it sits inside.
    expect(entry.body.fields.find((f) => f.name === 'child')?.type.name).toBe(name);
  });

  it('non-regular recursion (the argument grows every level) does not close, and fails as a diagnostic rather than a stack overflow', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['X'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [field('value', { name: 'X', arguments: [], annotations: [] })],
      }),
    );
    namespace.set(
      'grow',
      recordTemplate(['T'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [
          field('next', {
            name: 'grow',
            arguments: [
              {
                kind: 'ref',
                ref: {
                  name: 'box',
                  arguments: [{ kind: 'ref', ref: { name: 'T', arguments: [], annotations: [] } }],
                  annotations: [],
                },
              },
            ],
            annotations: [],
          }),
        ],
      }),
    );
    const error = thrownBy(() =>
      materialiser.closeApplication({ name: 'grow', arguments: [ref('text')], annotations: [] }),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('does not close');
    expect((error as TsonSchemaValidationError).message).toContain('grow');
  });
});

// ── Declaration-time checks: arity, and applying a non-template ────────────────────────────

describe('declaration-time checks (§5.10)', () => {
  it('rejects applying arguments to a name that declares no type parameters', () => {
    const { namespace, materialiser } = harness();
    namespace.set('plain', {
      kind: 'PRODUCT',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [] },
      annotations: [],
    });
    const error = thrownBy(() =>
      materialiser.closeApplication({ name: 'plain', arguments: [ref('text')], annotations: [] }),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('declares no type parameters');
  });

  it('rejects an arity mismatch between the template and the application', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'pair',
      recordTemplate(['A', 'B'], {
        kind: 'record',
        supertypes: [],
        groups: [],
        fields: [
          field('first', { name: 'A', arguments: [], annotations: [] }),
          field('second', { name: 'B', arguments: [], annotations: [] }),
        ],
      }),
    );
    const error = thrownBy(() =>
      materialiser.closeApplication({ name: 'pair', arguments: [ref('text')], annotations: [] }),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('takes 2 type argument');
  });

  it("an application whose head names nothing in scope is left whole, arguments and all -- the linker's verdict, not this pass's", () => {
    const { materialiser } = harness();
    const missingApplication: TypeRef = {
      name: 'missing',
      arguments: [ref('text')],
      annotations: [],
    };
    const result = materialiser.materialise(
      new Map([
        [
          'ghost',
          {
            kind: 'REFERENCE' as const,
            parameters: [],
            constructor: false,
            supertypes: [],
            subtypes: [],
            source: missingApplication,
            body: { kind: 'reference' as const, target: missingApplication },
            annotations: [],
          },
        ],
      ]),
    );
    const rewritten = result.entries.get('ghost');
    if (rewritten === undefined || !isReferenceBody(rewritten.body)) throw new Error('unreachable');
    // Left whole -- not stripped to the bare head, which would misreport an author-supplied
    // argument list as none to whoever links this reference next.
    expect(rewritten.source).toEqual(missingApplication);
    expect(rewritten.body.target).toEqual(missingApplication);
  });
});

// ── The whole-schema batch pass ──────────────────────────────────────────────────────────────

describe('materialise (the whole-schema batch pass)', () => {
  function boxTemplate(): TypeDefinition {
    return recordTemplate(['T'], {
      kind: 'record',
      supertypes: [],
      groups: [],
      fields: [field('value', { name: 'T', arguments: [], annotations: [] })],
    });
  }

  function boxedTextReference(): TypeDefinition {
    return {
      kind: 'REFERENCE',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      source: { name: 'box', arguments: [ref('text')], annotations: [] },
      body: {
        kind: 'reference',
        target: { name: 'box', arguments: [ref('text')], annotations: [] },
      },
      annotations: [],
    };
  }

  it("skips a template's own entry (non-empty `parameters`) and rewrites every closed application it finds", () => {
    const entries = new Map<string, TypeDefinition>([
      ['box', boxTemplate()],
      ['boxed_text', boxedTextReference()],
    ]);
    // `namespaceDefinitions` reads through the very map `materialise` is given -- as it must for
    // `instantiate` to find `box` when it looks the application's head up (see this module's own
    // doc on why the getter is "typically a method reference onto a caller's growing map").
    const materialiser = createTemplateMaterialiser({
      namespaceDefinitions: (name) => entries.get(name),
      publish: (name, definition) => entries.set(name, definition),
      definitionMetaReader: testMetaReader,
    });
    const result = materialiser.materialise(entries);
    // The template's own entry passes through unchanged.
    expect(result.entries.get('box')).toBe(entries.get('box'));
    const rewritten = result.entries.get('boxed_text');
    if (rewritten === undefined || !isReferenceBody(rewritten.body)) throw new Error('unreachable');
    expect(rewritten.body.target.arguments).toEqual([]);
    expect(result.materialised.has(rewritten.body.target.name)).toBe(true);
    expect(rewritten.source).toEqual(rewritten.body.target);
  });

  it("derives the same instantiation name regardless of the map's own iteration order (determinism, §8.2)", () => {
    const forward = createTemplateMaterialiser({
      namespaceDefinitions: (name) => forwardEntries.get(name),
      publish: (name, def) => forwardEntries.set(name, def),
      definitionMetaReader: testMetaReader,
    });
    const forwardEntries = new Map<string, TypeDefinition>([
      ['box', boxTemplate()],
      ['boxed_text', boxedTextReference()],
      ['other', boxedTextReference()],
    ]);
    const forwardResult = forward.materialise(forwardEntries);

    const backward = createTemplateMaterialiser({
      namespaceDefinitions: (name) => backwardEntries.get(name),
      publish: (name, def) => backwardEntries.set(name, def),
      definitionMetaReader: testMetaReader,
    });
    const backwardEntries = new Map([...forwardEntries.entries()].reverse());
    const backwardResult = backward.materialise(backwardEntries);

    const forwardName = forwardResult.entries.get('boxed_text')?.source?.name;
    const backwardName = backwardResult.entries.get('boxed_text')?.source?.name;
    expect(forwardName).toBeDefined();
    expect(forwardName).toBe(backwardName);
  });

  it('reports a failed application per entry when a reporter is supplied, and leaves that entry as it was', () => {
    const entries = new Map<string, TypeDefinition>([
      ['box', boxTemplate()],
      [
        'bad',
        {
          kind: 'REFERENCE',
          parameters: [],
          constructor: false,
          supertypes: [],
          subtypes: [],
          // `box` takes one parameter; this applies two.
          body: {
            kind: 'reference',
            target: { name: 'box', arguments: [ref('text'), ref('uuid')], annotations: [] },
          },
          annotations: [],
        },
      ],
    ]);
    const materialiser = createTemplateMaterialiser({
      namespaceDefinitions: (name) => entries.get(name),
      publish: (name, definition) => entries.set(name, definition),
      definitionMetaReader: testMetaReader,
    });
    const reported: string[] = [];
    const result = materialiser.materialise(entries, {
      reportFailedApplication(entryName) {
        reported.push(entryName);
      },
    });
    expect(reported).toEqual(['bad']);
    expect(result.entries.get('bad')).toBe(entries.get('bad'));
  });

  it('without a reporter, the first failing application throws', () => {
    const entries = new Map<string, TypeDefinition>([
      ['box', boxTemplate()],
      [
        'bad',
        {
          kind: 'REFERENCE',
          parameters: [],
          constructor: false,
          supertypes: [],
          subtypes: [],
          body: {
            kind: 'reference',
            target: { name: 'box', arguments: [ref('text'), ref('uuid')], annotations: [] },
          },
          annotations: [],
        },
      ],
    ]);
    const materialiser = createTemplateMaterialiser({
      namespaceDefinitions: (name) => entries.get(name),
      publish: (name, definition) => entries.set(name, definition),
      definitionMetaReader: testMetaReader,
    });
    expect(thrownBy(() => materialiser.materialise(entries))).toBeInstanceOf(
      TsonSchemaValidationError,
    );
  });
});
