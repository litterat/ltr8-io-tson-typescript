import { describe, expect, it } from 'vitest';

import {
  argumentOf,
  createHeldBody,
  defaultAnnotationValueEncoder,
  heldEmptyRecord,
  heldRecord,
  isApplication,
  metaRefValue,
  typeRefOf,
} from '../src/compiler/heldBody.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { RecordValue } from '../src/ast/value.js';

describe("metaRefValue (the resolved-layer twin of desugar.ts's refValueOf)", () => {
  it('a no-argument reference is a bare unquoted token, not the record form', () => {
    expect(metaRefValue({ name: 'text', arguments: [], annotations: [] })).toEqual({
      kind: 'token',
      text: 'text',
      form: 'unquoted',
    });
  });

  it('an application is the { name arguments } record form, round-tripping through typeRefOf', () => {
    const ref = {
      name: 'box',
      arguments: [
        { kind: 'ref' as const, ref: { name: 'text', arguments: [], annotations: [] } },
        { kind: 'value' as const, value: { text: '3', form: 'UNQUOTED' as const } },
      ],
      annotations: [],
    };
    const wire = metaRefValue(ref);
    expect(wire.kind).toBe('record');
    expect(isApplication(wire as RecordValue)).toBe(true);
    expect(typeRefOf(wire as RecordValue)).toEqual({
      name: 'box',
      arguments: [
        { kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } },
        { kind: 'value', value: { text: '3', form: 'UNQUOTED' } },
      ],
      annotations: [],
    });
  });

  it('nested applications round-trip (box<box<text>>)', () => {
    const inner = {
      name: 'box',
      arguments: [{ kind: 'ref' as const, ref: { name: 'text', arguments: [], annotations: [] } }],
      annotations: [],
    };
    const outer = {
      name: 'box',
      arguments: [{ kind: 'ref' as const, ref: inner }],
      annotations: [],
    };
    const wire = metaRefValue(outer) as RecordValue;
    const back = typeRefOf(wire);
    expect(back.name).toBe('box');
    expect(back.arguments[0]).toEqual({ kind: 'ref', ref: inner });
  });
});

describe('argumentOf', () => {
  it('a `value` member is a literal argument', () => {
    const record: RecordValue = {
      kind: 'record',
      fields: [
        {
          name: 'value',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: '42', form: 'unquoted' } },
          },
        },
      ],
    };
    expect(argumentOf(record)).toEqual({ kind: 'value', value: { text: '42', form: 'UNQUOTED' } });
  });

  it('a `name` member naming a bare token is a reference argument', () => {
    const record: RecordValue = {
      kind: 'record',
      fields: [
        {
          name: 'name',
          value: {
            value: {
              annotations: [],
              coreValue: { kind: 'token', text: 'uuid', form: 'unquoted' },
            },
          },
        },
      ],
    };
    expect(argumentOf(record)).toEqual({
      kind: 'ref',
      ref: { name: 'uuid', arguments: [], annotations: [] },
    });
  });
});

describe('heldEmptyRecord', () => {
  it('is `!record { fields: [] }`', () => {
    const held = heldEmptyRecord();
    expect(held.typeRef).toBe('record');
    expect(held.coreValue).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'fields',
          value: { value: { annotations: [], coreValue: { kind: 'array', elements: [] } } },
        },
      ],
    });
  });
});

describe('heldRecord', () => {
  it("writes fields with state/value only where they depart from the constructor's own default", () => {
    const body: RecordBody = {
      kind: 'record',
      supertypes: ['base'],
      fields: [
        {
          name: 'plain',
          type: { name: 'token', arguments: [], annotations: [] },
          state: 'REQUIRED',
          annotations: [],
        },
        {
          name: 'fixed',
          type: { name: 'token', arguments: [], annotations: [] },
          state: 'REQUIRED_FIXED',
          value: { text: 'INDEX', form: 'UNQUOTED' },
          annotations: [],
        },
      ],
      groups: [],
    };
    const held = heldRecord(body);
    expect(held.typeRef).toBe('record');
    if (held.coreValue.kind !== 'record') throw new Error('unreachable');
    const supertypesField = held.coreValue.fields.find((f) => f.name === 'supertypes');
    expect(supertypesField?.value.value.coreValue).toEqual({
      kind: 'array',
      elements: [
        {
          value: { annotations: [], coreValue: { kind: 'token', text: 'base', form: 'unquoted' } },
        },
      ],
    });
    const fieldsField = held.coreValue.fields.find((f) => f.name === 'fields');
    if (fieldsField?.value.value.coreValue.kind !== 'array') throw new Error('unreachable');
    const [plain, fixed] = fieldsField.value.value.coreValue.elements;
    const plainRecord = plain?.value.coreValue;
    if (plainRecord?.kind !== 'record') throw new Error('unreachable');
    // `state` and `value` are omitted for a field at its nominal REQUIRED default.
    expect(plainRecord.fields.map((f) => f.name)).toEqual(['name', 'type']);
    const fixedRecord = fixed?.value.coreValue;
    if (fixedRecord?.kind !== 'record') throw new Error('unreachable');
    expect(fixedRecord.fields.map((f) => f.name)).toEqual(['name', 'type', 'state', 'value']);
  });

  it('omits `groups` entirely when there are none', () => {
    const body: RecordBody = { kind: 'record', supertypes: [], fields: [], groups: [] };
    const held = heldRecord(body);
    if (held.coreValue.kind !== 'record') throw new Error('unreachable');
    expect(held.coreValue.fields.some((f) => f.name === 'groups')).toBe(false);
  });
});

describe('createHeldBody', () => {
  it('names() finds every unquoted token at any depth, and never a quoted one', () => {
    const application = {
      annotations: [],
      typeRef: 'choice',
      coreValue: {
        kind: 'record' as const,
        fields: [
          {
            name: 'variants',
            value: {
              value: {
                annotations: [],
                coreValue: {
                  kind: 'array' as const,
                  elements: [
                    {
                      value: {
                        annotations: [],
                        coreValue: { kind: 'token' as const, text: 'T', form: 'unquoted' as const },
                      },
                    },
                    {
                      value: {
                        annotations: [],
                        coreValue: {
                          kind: 'token' as const,
                          text: 'literal text',
                          form: 'single-line' as const,
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
    };
    const held = createHeldBody(application);
    expect(held.names()).toEqual(new Set(['T']));
  });

  it('applications() finds a type_ref record form without descending into its own arguments', () => {
    const application = {
      annotations: [],
      typeRef: 'array',
      coreValue: {
        kind: 'record' as const,
        fields: [
          {
            name: 'element_type',
            value: {
              value: {
                annotations: [],
                coreValue: metaRefValue({
                  name: 'box',
                  arguments: [
                    { kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } },
                  ],
                  annotations: [],
                }),
              },
            },
          },
        ],
      },
    };
    const held = createHeldBody(application);
    const applications = held.applications();
    expect(applications).toHaveLength(1);
    expect(applications[0]?.name).toBe('box');
    expect(applications[0]?.arguments).toEqual([
      { kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } },
    ]);
  });

  it('application is the exact DataValue it was built from', () => {
    const value = {
      annotations: [],
      typeRef: 'record',
      coreValue: { kind: 'record' as const, fields: [] },
    };
    expect(createHeldBody(value).application).toBe(value);
  });
});

describe('defaultAnnotationValueEncoder', () => {
  it('encodes primitives as unquoted tokens and strings as quoted ones', () => {
    expect(defaultAnnotationValueEncoder(true).coreValue).toEqual({
      kind: 'token',
      text: 'true',
      form: 'unquoted',
    });
    expect(defaultAnnotationValueEncoder(42n).coreValue).toEqual({
      kind: 'token',
      text: '42',
      form: 'unquoted',
    });
    expect(defaultAnnotationValueEncoder('hi').coreValue).toEqual({
      kind: 'token',
      text: 'hi',
      form: 'single-line',
    });
  });

  it('encodes null/undefined as the absent sentinel', () => {
    expect(defaultAnnotationValueEncoder(undefined).coreValue).toEqual({ kind: 'absent' });
  });

  it('throws for a shape it has no wire spelling for', () => {
    expect(() => defaultAnnotationValueEncoder({ not: 'a core value' })).toThrow();
  });
});
