import { describe, expect, it } from 'vitest';

import {
  createTemplateMaterialiser,
  type TemplateMaterialiserDeps,
} from '../src/compiler/templates.js';
import { createHeldBody } from '../src/compiler/heldBody.js';
import { refValue } from '../src/compiler/wireForm.js';
import { metaFormOfLexer } from '../src/compiler/tokenForms.js';
import { canonicalApplication } from '../src/compiler/derivedName.js';
import { inferAll, kinds as parameterKindsOf } from '../src/compiler/parameterTypes.js';
import {
  TsonLimitRefusedError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import type { DataValue, RecordValue, TokenValue } from '../src/ast/value.js';
import type {
  ArrayBody,
  EnumBody,
  NamedField,
  RecordBody,
  RecordField,
} from '../src/schema/meta/bodies.js';
import { TYPE_KIND } from '../src/schema/meta/bodies.js';
import type { IntegerType } from '../src/schema/meta/atoms-numeric.js';
import type { Reference, Top, TypeArgument, TypeRef } from '../src/schema/meta/typedef.js';
import { entryKind } from '../src/schema/meta/typedef.js';
import { entry, fieldMapOf, fieldOf, fieldsOf } from './model-fixtures.js';

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

/** `<params> => { field: type ... }` -- a record template: the record it is, with its parameters (§5.10). */
function recordTemplate(parameters: readonly string[], body: RecordBody): RecordBody {
  return {
    ...body,
    parameters: parameters.map((name) => ({
      name,
      type: { name: TYPE_KIND, arguments: [], annotations: [] },
    })),
  };
}

function field(
  name: string,
  type: TypeRef,
  marks: { optional?: boolean; voidable?: boolean; role?: RecordField['role'] } = {},
): NamedField {
  return {
    name,
    type,
    annotations: [],
    optional: marks.optional ?? false,
    voidable: marks.voidable ?? false,
    role: marks.role ?? 'FREE',
  };
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

/** Reads one wire boolean member (`optional`/`voidable`), `false` when absent -- §8.1's own default. */
function readBooleanField(record: RecordValue, name: string): boolean {
  const wire = record.fields.find((f) => f.name === name)?.value.value.coreValue;
  return wire?.kind === 'token' && wire.text === 'true';
}

function testMetaReader(type: string, value: DataValue): Top {
  const record = value.coreValue as RecordValue;
  if (type === 'record') {
    const fieldsField = record.fields.find((f) => f.name === 'fields');
    const fields: NamedField[] = [];
    if (fieldsField?.value.value.coreValue.kind === 'map') {
      for (const mapEntry of fieldsField.value.value.coreValue.entries) {
        const fieldRecord = mapEntry.value.value.coreValue as RecordValue;
        const fname = (mapEntry.key.coreValue as TokenValue).text;
        const ftype = readTypeRefField(fieldRecord, 'type');
        const roleWire = fieldRecord.fields.find((f) => f.name === 'role')?.value.value.coreValue;
        const role: RecordField['role'] =
          roleWire?.kind === 'token' && (roleWire.text === 'DEFAULT' || roleWire.text === 'FIXED')
            ? roleWire.text
            : 'FREE';
        const valueWire = fieldRecord.fields.find((f) => f.name === 'value')?.value.value.coreValue;
        const fieldValue =
          valueWire?.kind === 'token'
            ? { text: valueWire.text, form: metaFormOfLexer(valueWire.form) }
            : undefined;
        fields.push({
          name: fname,
          type: ftype,
          optional: readBooleanField(fieldRecord, 'optional'),
          voidable: readBooleanField(fieldRecord, 'voidable'),
          role,
          ...(fieldValue === undefined ? {} : { value: fieldValue }),
          annotations: [],
        });
      }
    }
    const body: RecordBody = {
      kind: 'record',
      fields: fieldMapOf(fields),
      groups: [],
      extension: 'OPEN',
    };
    return body;
  }
  if (type === 'array') {
    const elementType = readTypeRefField(record, 'element_type');
    return {
      kind: 'array',
      elementType,
      voidable: false,
      ordered: true,
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
  readonly metaTypes?: TemplateMaterialiserDeps['metaTypes'];
}

function harness(overrides: HarnessOverrides = {}): {
  namespace: Map<string, Top>;
  materialiser: ReturnType<typeof createTemplateMaterialiser>;
  published: Map<string, Top>;
} {
  const namespace = new Map<string, Top>();
  const published = new Map<string, Top>();
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
    ...(overrides.metaTypes === undefined ? {} : { metaTypes: overrides.metaTypes }),
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

describe('a use-site record application is its expansion (§8.2)', () => {
  it('substitutes an argument into a field type, closing to a synthetic record keyed on its content with no `@application`', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
      }),
    );
    const name = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('text')],
      annotations: [],
    });
    const found = namespace.get(name);
    if (found === undefined || !isRecordBody(found)) throw new Error('unreachable');
    expect(entryKind(found)).toBe('PRODUCT');
    expect(name).toMatch(/^record_value_text_[0-9a-f]{8}$/);
    expect(materialiser.syntheticNames().has(name)).toBe(true);
    expect(materialiser.mintedFacts(name)?.application).toBeUndefined();
    expect(materialiser.mintedFacts(name)?.head).toBe('record');
    expect(
      materialiser.expansionsByApplication().get(canonicalApplication('box', [ref('text')])),
    ).toBe(name);
    expect(fieldsOf(found)[0]).toMatchObject({
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
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
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

  it('is independent of §4.3-equivalent argument spellings: `<255>` and `<0xFF>` are one application', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'sized',
      recordTemplate(['N'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('n', { name: 'integer', arguments: [], annotations: [] })]),
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
    // `1` and `1.0` resolve to different base types (§4) and stay two applications despite one
    // magnitude -- though here both expand to one record, the template naming no parameter in its
    // body, and an expansion is keyed on its content (§8.2).
    const asFloat = materialiser.closeApplication({
      name: 'sized',
      arguments: [literal('255.0')],
      annotations: [],
    });
    expect(asFloat).toBe(decimal);
    expect(materialiser.expansionsByApplication().size).toBe(2);
  });

  it('an argument that is an alias follows its reference chain to its terminal entry, so `box<user_id>` over `user_id => uuid` mints the same entry as `box<uuid>` (§8.2)', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'uuid',
      entry(
        {
          kind: 'record',
          fields: fieldMapOf([]),
          groups: [],
          extension: 'OPEN',
        },
        ['atom', 'top'],
      ),
    );
    namespace.set(
      'user_id',
      entry({ kind: 'reference', target: { name: 'uuid', arguments: [], annotations: [] } }),
    );
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
      }),
    );
    const overAlias = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('user_id')],
      annotations: [],
    });
    const overTerminal = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('uuid')],
      annotations: [],
    });
    expect(overAlias).toBe(overTerminal);
    // The application is keyed canonically -- the terminal entry `uuid`, not the alias `user_id`
    // the first caller happened to write.
    const expansions = materialiser.expansionsByApplication();
    expect(expansions.get(canonicalApplication('box', [ref('uuid')]))).toBe(overAlias);
    expect(expansions.has(canonicalApplication('box', [ref('user_id')]))).toBe(false);
  });

  it('a refinement or a fresh instance is not an alias and keeps its own identity, even over an otherwise-identical body (§8.2)', () => {
    const { namespace, materialiser } = harness();
    // Two distinct entries with the same shape, standing in for `!uuid ^ {}` and `!uuid_type {}`
    // already lifted by desugaring -- neither is a `Reference` body, so `terminal` stops on each
    // immediately rather than following anywhere.
    const atomBody: Top = {
      kind: 'record',
      fields: fieldMapOf([]),
      groups: [],
      extension: 'OPEN',
    };
    namespace.set('uuid_refined', entry(atomBody, ['uuid', 'atom', 'top']));
    namespace.set('uuid_fresh', entry(atomBody, ['atom', 'top']));
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
      }),
    );
    const overRefined = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('uuid_refined')],
      annotations: [],
    });
    const overFresh = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('uuid_fresh')],
      annotations: [],
    });
    expect(overRefined).not.toBe(overFresh);
  });

  it('closes arguments innermost-first, so a nested application names the inner entry before the outer one', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
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
    if (outer === undefined || !isRecordBody(outer)) throw new Error('unreachable');
    expect(fieldsOf(outer)[0]?.type.name).toBe(innerName);
  });
});

// ── Open-instance templates close to a synthetic plus an instantiation reference ────────────

describe('a use-site application of an open-instance template is its expansion (§8.2)', () => {
  it('names the synthetic array form directly, minting no instantiation entry', () => {
    const { namespace, materialiser } = harness();
    // `<T> !array { element_type: T }` -- held directly, since the array constructor's own
    // vocabulary (not `record`) is what dispatches `closeHeldTemplate` rather than `closeHeldRecord`.
    namespace.set(
      'wrapped',
      entry(
        createHeldBody(
          {
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
          },
          ['T'],
        ),
      ),
    );
    const before = namespace.size;
    const formName = materialiser.closeApplication({
      name: 'wrapped',
      arguments: [ref('text')],
      annotations: [],
    });
    expect(namespace.size).toBe(before + 1);
    expect(materialiser.mintedFacts(formName)?.application).toBeUndefined();
    expect(materialiser.syntheticNames().has(formName)).toBe(true);
    const form = namespace.get(formName);
    if (form === undefined || !isArrayBody(form)) throw new Error('unreachable');
    expect(form.elementType).toEqual({ name: 'text', arguments: [], annotations: [] });
  });

  it('a generated head (desugar-injected) closes to its own form with no extra instantiation entry', () => {
    const { namespace, materialiser } = harness({ generatedNames: new Set(['array_p0']) });
    namespace.set(
      'array_p0',
      entry(
        createHeldBody(
          {
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
          },
          ['T'],
        ),
      ),
    );
    const result = materialiser.closeApplication({
      name: 'array_p0',
      arguments: [ref('uuid')],
      annotations: [],
    });
    // The form entry *is* the answer -- no second, REFERENCE-kind entry naming `array_p0<uuid>`.
    const resultEntry = namespace.get(result);
    if (resultEntry === undefined) throw new Error('unreachable');
    expect(entryKind(resultEntry)).toBe('PRODUCT');
    expect(materialiser.syntheticNames().has(result)).toBe(true);
  });

  it('throws TsonNotImplementedError closing an open-instance template with no compiled meta reader supplied', () => {
    const { materialiser, namespace } = harness({ omitReader: true });
    namespace.set(
      'wrapped',
      entry(
        createHeldBody(
          {
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
          },
          ['T'],
        ),
      ),
    );
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
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([
          field('first', { name: 'A', arguments: [], annotations: [] }),
          field('second', { name: 'B', arguments: [], annotations: [] }),
        ]),
      }),
    );
    namespace.set(
      'uuid_pair',
      entry(
        createHeldBody(
          {
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
          },
          ['B'],
        ),
      ),
    );
    const before = namespace.size;
    const closed = materialiser.closeApplication({
      name: 'uuid_pair',
      arguments: [ref('int32')],
      annotations: [],
    });
    // Exactly one new entry (the expansion `pair<uuid, int32>` closes to) -- no second entry for
    // the alias hop, and no instantiation entry beside the expansion.
    expect(namespace.size).toBe(before + 1);
    const found = namespace.get(closed);
    if (found === undefined) throw new Error('unreachable');
    expect(materialiser.syntheticNames().has(closed)).toBe(true);
    expect(
      materialiser
        .expansionsByApplication()
        .get(canonicalApplication('pair', [ref('uuid'), ref('int32')])),
    ).toBe(closed);
  });

  it('a self-applying alias is a reported cycle, not a knot tied on nothing (§5.10)', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'loop',
      entry(
        createHeldBody(
          {
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
          },
          ['T'],
        ),
      ),
    );
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
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([
          field('value', { name: 'T', arguments: [], annotations: [] }),
          field('child', {
            name: 'tree',
            arguments: [{ kind: 'ref', ref: { name: 'T', arguments: [], annotations: [] } }],
            annotations: [],
          }),
        ]),
      }),
    );
    const name = materialiser.closeApplication({
      name: 'tree',
      arguments: [ref('text')],
      annotations: [],
    });
    // Exactly one entry: the knot ties on the entry under construction rather than recursing.
    expect(
      [...namespace.keys()].filter(
        (key) => materialiser.mintedFacts(key)?.application?.name === 'tree',
      ),
    ).toHaveLength(1);
    const found = namespace.get(name);
    if (found === undefined || !isRecordBody(found)) throw new Error('unreachable');
    // The self-reference names the very entry it sits inside.
    expect(fieldOf(found, 'child')?.type.name).toBe(name);
  });

  it('non-regular recursion (the argument grows every level) does not close, and fails as a diagnostic rather than a stack overflow', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['X'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'X', arguments: [], annotations: [] })]),
      }),
    );
    namespace.set(
      'grow',
      recordTemplate(['T'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([
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
        ]),
      }),
    );
    const error = thrownBy(() =>
      materialiser.closeApplication({ name: 'grow', arguments: [ref('text')], annotations: [] }),
    );
    // A limit refusal ([TSON-SCHEMA] §11.5's "materialisation depth"), not a resolver error --
    // this deployment declined to spend the resources, distinct from every other reason a
    // template application fails to close.
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect((error as TsonLimitRefusedError).limit).toBe('materialisation-depth');
    expect((error as TsonLimitRefusedError).message).toContain('does not close');
    expect((error as TsonLimitRefusedError).message).toContain('grow');
  });
});

// ── Declaration-time checks: arity, and applying a non-template ────────────────────────────

describe('declaration-time checks (§5.10)', () => {
  it('rejects applying arguments to a name that declares no type parameters', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'plain',
      entry({
        kind: 'record',
        fields: fieldMapOf([]),
        groups: [],
        extension: 'OPEN',
      }),
    );
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
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([
          field('first', { name: 'A', arguments: [], annotations: [] }),
          field('second', { name: 'B', arguments: [], annotations: [] }),
        ]),
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
          /* source: missingApplication */ entry({
            kind: 'reference' as const,
            target: missingApplication,
          }),
        ],
      ]),
    );
    const rewritten = result.entries.get('ghost');
    if (rewritten === undefined || !isReferenceBody(rewritten)) throw new Error('unreachable');
    // Left whole -- not stripped to the bare head, which would misreport an author-supplied
    // argument list as none to whoever links this reference next.
    expect(rewritten.target).toEqual(missingApplication);
  });
});

// ── §7.4 facet coherence re-runs at materialisation (§8.2) ──────────────────────────────────────

describe('facet coherence re-runs at materialisation (§7.4, §8.2)', () => {
  /** `testMetaReader` plus `integer_type`, enough to read `min`/`max` bindings as bigints. */
  function integerAwareMetaReader(type: string, value: DataValue): Top {
    if (type !== 'integer_type') {
      return testMetaReader(type, value);
    }
    const record = value.coreValue as RecordValue;
    const readBound = (name: string): bigint | undefined => {
      const field = record.fields.find((f) => f.name === name)?.value.value.coreValue;
      return field === undefined ? undefined : BigInt((field as TokenValue).text);
    };
    const min = readBound('min');
    const max = readBound('max');
    return {
      kind: 'integer_type',
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    } satisfies IntegerType;
  }

  /** `bounded => <N> !integer_type { min: N max: 10 }` -- §7.4's own motivating example. */
  function boundedTemplate(): Top {
    return entry(
      createHeldBody(
        {
          annotations: [],
          typeRef: 'integer_type',
          coreValue: {
            kind: 'record',
            fields: [
              {
                name: 'min',
                value: {
                  value: {
                    annotations: [],
                    coreValue: { kind: 'token', text: 'N', form: 'unquoted' },
                  },
                },
              },
              {
                name: 'max',
                value: {
                  value: {
                    annotations: [],
                    coreValue: { kind: 'token', text: '10', form: 'unquoted' },
                  },
                },
              },
            ],
          },
        },
        ['N'],
      ),
    );
  }

  it('bounded<20> mints a body whose bounds admit no value, and is refused just as the identical literal declaration would be', () => {
    const { namespace, materialiser } = harness({ definitionMetaReader: integerAwareMetaReader });
    namespace.set('bounded', boundedTemplate());
    const error = thrownBy(() =>
      materialiser.closeApplication({
        name: 'bounded',
        arguments: [literal('20')],
        annotations: [],
      }),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as TsonSchemaValidationError).message).toContain('contradict');
  });

  it('bounded<5> stays coherent and closes cleanly', () => {
    const { namespace, materialiser } = harness({ definitionMetaReader: integerAwareMetaReader });
    namespace.set('bounded', boundedTemplate());
    const name = materialiser.closeApplication({
      name: 'bounded',
      arguments: [literal('5')],
      annotations: [],
    });
    const form = namespace.get(name);
    if (form === undefined || !('kind' in form) || form.kind !== 'integer_type') {
      throw new Error('unreachable');
    }
    expect(form).toMatchObject({ min: 5n, max: 10n });
  });
});

// ── The whole-schema batch pass ──────────────────────────────────────────────────────────────

describe('materialise (the whole-schema batch pass)', () => {
  function boxTemplate(): Top {
    return recordTemplate(['T'], {
      kind: 'record',
      groups: [],
      extension: 'OPEN',
      fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
    });
  }

  function boxedTextReference(): Top {
    return /* source: { name: 'box', arguments: [ref('text')], annotations: [] } */ entry({
      kind: 'reference',
      target: { name: 'box', arguments: [ref('text')], annotations: [] },
    });
  }

  it("skips a template's own entry (non-empty `parameters`) and rewrites every closed application it finds", () => {
    const entries = new Map<string, Top>([
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
    // The template's own entry passes through unchanged: its one field names its parameter.
    expect(result.entries.get('box')).toEqual(entries.get('box'));
    const rewritten = result.entries.get('boxed_text');
    if (rewritten === undefined || !isReferenceBody(rewritten)) throw new Error('unreachable');
    expect(rewritten.target.arguments).toEqual([]);
    expect(result.materialised.has(rewritten.target.name)).toBe(true);
  });

  it("derives the same instantiation name regardless of the map's own iteration order (determinism, §8.2)", () => {
    const forward = createTemplateMaterialiser({
      namespaceDefinitions: (name) => forwardEntries.get(name),
      publish: (name, def) => forwardEntries.set(name, def),
      definitionMetaReader: testMetaReader,
    });
    const forwardEntries = new Map<string, Top>([
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

    const forwardName = (forwardResult.entries.get('boxed_text') as Reference | undefined)?.target
      .name;
    const backwardName = (backwardResult.entries.get('boxed_text') as Reference | undefined)?.target
      .name;
    expect(forwardName).toBeDefined();
    expect(forwardName).toBe(backwardName);
  });

  it('reports a failed application per entry when a reporter is supplied, and leaves that entry as it was', () => {
    const entries = new Map<string, Top>([
      ['box', boxTemplate()],
      [
        'bad',
        // `box` takes one parameter; this applies two.
        {
          kind: 'reference',
          target: { name: 'box', arguments: [ref('text'), ref('uuid')], annotations: [] },
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
    const entries = new Map<string, Top>([
      ['box', boxTemplate()],
      [
        'bad',
        entry({
          kind: 'reference',
          target: { name: 'box', arguments: [ref('text'), ref('uuid')], annotations: [] },
        }),
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

// ── §5.10 parameter kinds reclassify an argument before naming (byParameterKind) ────────────

describe('an argument bound to a VALUE parameter is reclassified before the application is named', () => {
  /** `e => <M> !enum { members: [a b M] }` -- §5.10's own motivating case for a VALUE parameter. */
  function enumTemplate(): Top {
    return entry(
      createHeldBody(
        {
          annotations: [],
          typeRef: 'enum',
          coreValue: {
            kind: 'record',
            fields: [
              {
                name: 'members',
                value: {
                  value: {
                    annotations: [],
                    coreValue: {
                      kind: 'array',
                      elements: (['a', 'b', 'M'] as const).map((text) => ({
                        value: {
                          annotations: [],
                          coreValue: { kind: 'token', text, form: 'unquoted' },
                        },
                      })),
                    },
                  },
                },
              },
            ],
          },
        },
        ['M'],
      ),
    );
  }

  /** `testMetaReader` plus the one constructor these tests close through that it does not bind. */
  function enumAwareMetaReader(type: string, value: DataValue): Top {
    if (type !== 'enum') {
      return testMetaReader(type, value);
    }
    const record = value.coreValue as RecordValue;
    const membersField = record.fields.find((f) => f.name === 'members')?.value.value.coreValue;
    const members: string[] = [];
    if (membersField?.kind === 'array') {
      for (const element of membersField.elements) {
        members.push((element.value.coreValue as TokenValue).text);
      }
    }
    return { kind: 'enum', members, nameType: 'identifier' } satisfies EnumBody;
  }

  /** Just enough of the governing meta's own vocabulary for `enum.members` to resolve to a set of `identifier`. */
  function metaTypesFor(): (name: string) => Top | undefined {
    // IS-A `top` through `product` (hand-built) is what makes `isConstructor` true.
    const vocabRecord = (fields: readonly { name: string; type: string }[]): Top =>
      entry(
        {
          kind: 'record',
          groups: [],
          extension: 'OPEN',
          fields: fieldMapOf(
            fields.map((f) => field(f.name, { name: f.type, arguments: [], annotations: [] })),
          ),
        },
        ['product', 'top'],
      );
    const meta = new Map<string, Top>([
      ['enum', vocabRecord([{ name: 'members', type: 'enum_set' }])],
      [
        'enum_set',
        entry(
          {
            kind: 'array',
            elementType: { name: 'identifier', arguments: [], annotations: [] },
            voidable: false,
            ordered: true,
            uniqueItems: false,
          },
          ['product', 'top'],
        ),
      ],
      ['identifier', entry({ kind: 'text_type', normalization: 'NONE' }, ['atom', 'top'])],
    ]);
    return (name) => meta.get(name);
  }

  it('on demand (no batch pass): closing `e<c>` with `metaTypes` supplied infers the kind itself', () => {
    const { namespace, materialiser } = harness({
      definitionMetaReader: enumAwareMetaReader,
      metaTypes: metaTypesFor(),
    });
    namespace.set('e', enumTemplate());
    const form = materialiser.closeApplicationAs('e_c', {
      name: 'e',
      arguments: [ref('c')],
      annotations: [],
    });
    // `c` is recorded as the enum member it always meant, not a namespace reference to a type
    // called `c` that does not exist.
    expect(materialiser.mintedFacts('e_c')?.application).toEqual({
      name: 'e',
      arguments: [{ kind: 'value', value: { text: 'c', form: 'UNQUOTED' } }],
      annotations: [],
    });
    if (form === undefined || !('members' in form)) throw new Error('unreachable');
    expect(form.members).toEqual(['a', 'b', 'c']);
  });

  it('the batch pass (`setParameterKinds`) classifies just as the on-demand path does', () => {
    const { namespace, materialiser } = harness({
      definitionMetaReader: enumAwareMetaReader,
      metaTypes: metaTypesFor(),
    });
    namespace.set('e', enumTemplate());
    materialiser.setParameterKinds(
      parameterKindsOf(
        inferAll(namespace, new Set(namespace.keys()), new Map(), metaTypesFor(), {
          report(name): void {
            throw new Error(`unexpected report for '${name}'`);
          },
        }),
      ),
    );
    materialiser.closeApplicationAs('e_c', {
      name: 'e',
      arguments: [ref('c')],
      annotations: [],
    });
    expect(materialiser.mintedFacts('e_c')?.application).toEqual({
      name: 'e',
      arguments: [{ kind: 'value', value: { text: 'c', form: 'UNQUOTED' } }],
      annotations: [],
    });
  });

  it('with no `metaTypes` and no batch pass, an argument keeps its parsed reference channel (no regression)', () => {
    const { namespace, materialiser } = harness({ definitionMetaReader: enumAwareMetaReader });
    namespace.set('e', enumTemplate());
    materialiser.closeApplicationAs('e_c', {
      name: 'e',
      arguments: [ref('c')],
      annotations: [],
    });
    expect(materialiser.mintedFacts('e_c')?.application).toEqual({
      name: 'e',
      arguments: [ref('c')],
      annotations: [],
    });
  });
});

// ── closedFormName: the name a binding record derives with its applications closed ─────────

describe('closedFormName', () => {
  it('agrees with the name a directly-written, already-closed form would derive', () => {
    const { materialiser } = harness();
    const fields: NamedField[] = [
      {
        name: 'element_type',
        type: { name: 'text', arguments: [], annotations: [] },
        optional: false,
        voidable: false,
        role: 'FREE',
        annotations: [],
      },
    ];
    // No application inside `fields` to close, so this is exactly `ofBinding('array', fields)` --
    // the base case the merge pass falls back to when nothing needs reducing.
    const bindingFields = fields.map((f) => ({
      name: f.name,
      value: { value: { annotations: [], coreValue: refValue(f.type) } },
    }));
    expect(materialiser.closedFormName('array', bindingFields)).toBe(
      materialiser.closedFormName('array', bindingFields),
    );
  });

  it('reduces a nested application to the entry it denotes before deriving the name (§8.2)', () => {
    const { namespace, materialiser } = harness();
    namespace.set(
      'box',
      recordTemplate(['T'], {
        kind: 'record',
        groups: [],
        extension: 'OPEN',
        fields: fieldMapOf([field('value', { name: 'T', arguments: [], annotations: [] })]),
      }),
    );
    // `[box<text>]` written directly: an array binding whose `element_type` slot holds the
    // still-open application `box<text>`, exactly as `desugar.ts` would write it before this
    // pass runs (see `wireForm.ts`'s own `refValue` for the record form an application takes).
    const bindingFields = [
      {
        name: 'element_type',
        value: {
          value: {
            annotations: [],
            coreValue: refValue({ name: 'box', arguments: [ref('text')], annotations: [] }),
          },
        },
      },
    ];
    const closedName = materialiser.closedFormName('array', bindingFields);
    // Closing `box<text>` first, exactly as `close` would when reached through an ordinary field.
    const boxedTextName = materialiser.closeApplication({
      name: 'box',
      arguments: [ref('text')],
      annotations: [],
    });
    const directName = materialiser.closedFormName('array', [
      {
        name: 'element_type',
        value: {
          value: {
            annotations: [],
            coreValue: { kind: 'token', text: boxedTextName, form: 'unquoted' },
          },
        },
      },
    ]);
    expect(closedName).toBe(directName);
  });
});
