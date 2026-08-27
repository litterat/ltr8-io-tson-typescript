import { describe, expect, it } from 'vitest';

import {
  checkDisjointAssertions,
  computeDisjointness,
  discriminationClassOf,
  isChoiceDisjoint,
} from '../src/link/disjointness.js';
import { collector } from '../src/core/diagnostic.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { Top, TypeDefinition } from '../src/schema/meta/typedef.js';

function def(
  body: Top,
  options: {
    readonly annotations?: TypeDefinition['annotations'];
    readonly disjoint?: boolean;
  } = {},
): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    annotations: options.annotations ?? [],
    ...(options.disjoint === undefined ? {} : { disjoint: options.disjoint }),
  };
}

const text = def({ kind: 'text_type' });
const int32 = def({ kind: 'integer_type', size: { bits: 32, signed: true } } as never);
const record = def({ kind: 'record', supertypes: [], fields: [], groups: [] });
const arr = def({
  kind: 'array',
  elementType: { name: 'text', arguments: [], annotations: [] },
  state: 'REQUIRED',
  unordered: false,
  uniqueItems: false,
});
const alias = def({ kind: 'reference', target: { name: 'text', arguments: [], annotations: [] } });

describe('discriminationClassOf (§5.4)', () => {
  const namespace = new Map<string, TypeDefinition>([
    ['text', text],
    ['int32', int32],
    ['record', record],
    ['arr', arr],
    ['alias', alias],
  ]);

  it('classifies a string-shaped atom as STRING and an integer atom as NUMBER', () => {
    expect(discriminationClassOf('text', namespace)).toBe('STRING');
    expect(discriminationClassOf('int32', namespace)).toBe('NUMBER');
  });

  it('classifies record/map as BRACE and array/tuple as BRACKET', () => {
    expect(discriminationClassOf('record', namespace)).toBe('BRACE');
    expect(discriminationClassOf('arr', namespace)).toBe('BRACKET');
  });

  it('follows an argument-free reference chain to its terminal entry (§8.3)', () => {
    expect(discriminationClassOf('alias', namespace)).toBe('STRING');
  });

  it('returns undefined for a name the namespace does not hold', () => {
    expect(discriminationClassOf('nowhere', namespace)).toBeUndefined();
  });

  it('returns undefined for a reference cycle rather than hanging', () => {
    const cyclic = new Map<string, TypeDefinition>([
      ['a', def({ kind: 'reference', target: { name: 'b', arguments: [], annotations: [] } })],
      ['b', def({ kind: 'reference', target: { name: 'a', arguments: [], annotations: [] } })],
    ]);
    expect(discriminationClassOf('a', cyclic)).toBeUndefined();
  });

  it('classifies a boolean-shaped enum as BOOLEAN and a mixed enum as undefined', () => {
    const ns = new Map<string, TypeDefinition>([
      ['boolean', def({ kind: 'enum', members: ['true', 'false'] })],
      ['mixed', def({ kind: 'enum', members: ['true', '1'] })],
    ]);
    expect(discriminationClassOf('boolean', ns)).toBe('BOOLEAN');
    expect(discriminationClassOf('mixed', ns)).toBeUndefined();
  });

  it('a rational/complex atom (needs a tag) and a Data body both have no class', () => {
    const ns = new Map<string, TypeDefinition>([
      ['rational', def({ kind: 'rational_type' })],
      ['op', def({ kind: 'operation' })],
    ]);
    expect(discriminationClassOf('rational', ns)).toBeUndefined();
    expect(discriminationClassOf('op', ns)).toBeUndefined();
  });
});

describe('isChoiceDisjoint / computeDisjointness (§5.4)', () => {
  it('is true when every variant has a distinct class', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['text', text],
      ['int32', int32],
    ]);
    expect(isChoiceDisjoint([{ name: 'text' }, { name: 'int32' }], namespace)).toBe(true);
  });

  it('is false when two variants share one class -- even though their value sets never overlap', () => {
    // §5.4: "MUST NOT prove more (value-set separation... does not make a choice disjoint)".
    const namespace = new Map<string, TypeDefinition>([
      ['text', text],
      ['other_text', def({ kind: 'text_type' })],
    ]);
    expect(isChoiceDisjoint([{ name: 'text' }, { name: 'other_text' }], namespace)).toBe(false);
  });

  it('is false when a variant has no class at all', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['text', text],
      ['rational', def({ kind: 'rational_type' })],
    ]);
    expect(isChoiceDisjoint([{ name: 'text' }, { name: 'rational' }], namespace)).toBe(false);
  });

  it('computeDisjointness only touches choice-bodied entries, and keeps everything else by reference', () => {
    const choice = def({
      kind: 'choice',
      variants: [
        { name: 'text', arguments: [], annotations: [] },
        { name: 'int32', arguments: [], annotations: [] },
      ],
    });
    const entries = new Map<string, TypeDefinition>([
      ['text', text],
      ['int32', int32],
      ['choice', choice],
    ]);
    const result = computeDisjointness(entries);
    expect(result.get('choice')?.disjoint).toBe(true);
    expect(result.get('text')).toBe(text); // untouched, same reference
  });
});

describe('checkDisjointAssertions (§5.4)', () => {
  it('is silent when the assertion is verified (disjoint: true)', () => {
    const choice = def(
      { kind: 'choice', variants: [] },
      { annotations: [{ name: 'disjoint' }], disjoint: true },
    );
    const merged = new Map([['c', choice]]);
    expect(() => {
      checkDisjointAssertions(merged, new Set(['c']), { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('throws (fail-fast) when @disjoint is asserted but the derived fact is false', () => {
    const choice = def(
      {
        kind: 'choice',
        variants: [
          { name: 'text', arguments: [], annotations: [] },
          { name: 'other', arguments: [], annotations: [] },
        ],
      },
      { annotations: [{ name: 'disjoint' }], disjoint: false },
    );
    const merged = new Map([['c', choice]]);
    expect(() => {
      checkDisjointAssertions(merged, new Set(['c']), { schemaId: 'https://x/s.tn' });
    }).toThrow(TsonSchemaValidationError);
  });

  it('reports through a receiver instead of throwing when one is supplied', () => {
    const choice = def(
      { kind: 'choice', variants: [] },
      { annotations: [{ name: 'disjoint' }], disjoint: false },
    );
    const merged = new Map([['c', choice]]);
    const diagnostics = collector();
    checkDisjointAssertions(merged, new Set(['c']), {
      schemaId: 'https://x/s.tn',
      receiver: diagnostics,
    });
    expect(diagnostics.diagnostics).toHaveLength(1);
    expect(diagnostics.diagnostics[0]?.code).toBe('SCHEMA_ERROR');
  });

  it('does nothing for a choice with no @disjoint assertion at all, whatever the derived fact', () => {
    const choice = def({ kind: 'choice', variants: [] }, { disjoint: false, annotations: [] });
    const merged = new Map([['c', choice]]);
    expect(() => {
      checkDisjointAssertions(merged, new Set(['c']), { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });

  it('skips an imported entry (not in localNames) even if its own assertion looks unverified', () => {
    const choice = def(
      { kind: 'choice', variants: [] },
      { annotations: [{ name: 'disjoint' }], disjoint: false },
    );
    const merged = new Map([['imported_c', choice]]);
    expect(() => {
      checkDisjointAssertions(merged, new Set(), { schemaId: 'https://x/s.tn' });
    }).not.toThrow();
  });
});
