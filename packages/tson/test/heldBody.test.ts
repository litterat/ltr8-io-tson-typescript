import { describe, expect, it } from 'vitest';

import { createHeldBody } from '../src/compiler/heldBody.js';
import {
  applicationIn,
  defaultAnnotationValueEncoder,
  heldEmptyRecord,
  heldRecord,
  refValue as metaRefValue,
} from '../src/compiler/wireForm.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import { fieldMapOf } from './model-fixtures.js';

describe("metaRefValue (the resolved-layer twin of desugar.ts's refValueOf)", () => {
  it('a no-argument reference is a bare unquoted token, not the record form', () => {
    expect(metaRefValue({ name: 'text', arguments: [], annotations: [] })).toEqual({
      kind: 'token',
      text: 'text',
      form: 'unquoted',
    });
  });

  it('an application has no data form (§4.1): its text is a token no position reads as an application', () => {
    const inner = {
      name: 'box',
      arguments: [{ kind: 'ref' as const, ref: { name: 'text', arguments: [], annotations: [] } }],
      annotations: [],
    };
    const outer = {
      name: 'box',
      arguments: [
        { kind: 'ref' as const, ref: inner },
        { kind: 'value' as const, value: { text: '3', form: 'UNQUOTED' as const } },
      ],
      annotations: [],
    };
    for (const ref of [inner, outer]) {
      const wire = metaRefValue(ref);
      expect(wire.kind).toBe('token');
      expect(applicationIn(wire)).toBeUndefined();
    }
  });
});

describe('heldEmptyRecord', () => {
  it('is `!meta.record { fields: {} }` -- an empty field map (§5.2)', () => {
    const held = heldEmptyRecord();
    expect(held.typeRef).toBe('meta.record');
    expect(held.coreValue).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'fields',
          value: { annotations: [], coreValue: { kind: 'empty-brace' } },
        },
      ],
    });
  });
});

describe('heldRecord', () => {
  it("writes fields with optional/voidable/role/value only where they depart from the constructor's own default", () => {
    const body: RecordBody = {
      kind: 'record',
      // The parents as written (§4.1's `type_chain.parents`), which a record template keeps.
      chain: {
        parents: [{ name: 'base', arguments: [], annotations: [] }],
        supertypes: [],
        subtypes: [],
      },
      fields: fieldMapOf([
        {
          name: 'plain',
          type: { name: 'token', arguments: [], annotations: [] },
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
        {
          name: 'fixed',
          type: { name: 'token', arguments: [], annotations: [] },
          optional: false,
          voidable: false,
          role: 'FIXED',
          value: { text: 'INDEX', form: 'UNQUOTED' },
          annotations: [],
        },
      ]),
      groups: [],
      extension: 'OPEN',
    };
    const held = heldRecord(body);
    expect(held.typeRef).toBe('meta.record');
    if (held.coreValue.kind !== 'record') throw new Error('unreachable');
    const chainField = held.coreValue.fields.find((f) => f.name === 'chain');
    expect(chainField?.value.coreValue).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'parents',
          value: {
            annotations: [],
            coreValue: {
              kind: 'array',
              elements: [
                {
                  annotations: [],
                  coreValue: { kind: 'token', text: 'base', form: 'unquoted' },
                },
              ],
            },
          },
        },
      ],
    });
    // `fields` is a map keyed by name (§5.2): each value a `record_field`, which has no name.
    const fieldsField = held.coreValue.fields.find((f) => f.name === 'fields');
    if (fieldsField?.value.coreValue.kind !== 'map') throw new Error('unreachable');
    const [plain, fixed] = fieldsField.value.coreValue.entries;
    expect(plain?.key.coreValue).toMatchObject({ kind: 'token', text: 'plain' });
    const plainRecord = plain?.value.coreValue;
    if (plainRecord?.kind !== 'record') throw new Error('unreachable');
    // `optional`/`voidable`/`role`/`value` are omitted for a field at its nominal FREE default.
    expect(plainRecord.fields.map((f) => f.name)).toEqual(['type']);
    const fixedRecord = fixed?.value.coreValue;
    if (fixedRecord?.kind !== 'record') throw new Error('unreachable');
    expect(fixedRecord.fields.map((f) => f.name)).toEqual(['type', 'role', 'value']);
  });

  it('omits `groups` entirely when there are none', () => {
    const body: RecordBody = {
      kind: 'record',
      fields: fieldMapOf([]),
      groups: [],
      extension: 'OPEN',
    };
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
              annotations: [],
              coreValue: {
                kind: 'array' as const,
                elements: [
                  {
                    annotations: [],
                    coreValue: { kind: 'token' as const, text: 'T', form: 'unquoted' as const },
                  },
                  {
                    annotations: [],
                    coreValue: {
                      kind: 'token' as const,
                      text: 'literal text',
                      form: 'single-line' as const,
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const held = createHeldBody(application, ['T']);
    expect(held.names()).toEqual(new Set(['T']));
    expect(held.parameterNames).toEqual(['T']);
    expect(held.parameters).toEqual([
      { name: 'T', type: { name: 'meta.type_ref', arguments: [], annotations: [] } },
    ]);
  });

  it('applications() finds none: a data value spells no application (§4.1)', () => {
    const application = {
      annotations: [],
      typeRef: 'array',
      coreValue: {
        kind: 'record' as const,
        fields: [
          {
            name: 'element_type',
            value: {
              annotations: [],
              coreValue: metaRefValue({
                name: 'box',
                arguments: [{ kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } }],
                annotations: [],
              }),
            },
          },
        ],
      },
    };
    expect(createHeldBody(application, ['T']).applications()).toEqual([]);
  });

  it('application is the exact DataValue it was built from', () => {
    const value = {
      annotations: [],
      typeRef: 'record',
      coreValue: { kind: 'record' as const, fields: [] },
    };
    expect(createHeldBody(value, ['T']).application).toBe(value);
  });

  it('template is the same DataValue written back as text', () => {
    const value = {
      annotations: [],
      typeRef: 'record',
      coreValue: { kind: 'record' as const, fields: [] },
    };
    const held = createHeldBody(value, ['T']);
    expect(held.parameterNames).toEqual(['T']);
    expect(typeof held.template).toBe('string');
    expect(held.template.length).toBeGreaterThan(0);
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

  it('encodes null/undefined as the void sentinel', () => {
    expect(defaultAnnotationValueEncoder(undefined).coreValue).toEqual({ kind: 'void' });
  });

  it('throws for a shape it has no wire spelling for', () => {
    expect(() => defaultAnnotationValueEncoder({ not: 'a core value' })).toThrow();
  });
});
