import { describe, expect, it } from 'vitest';

import { inferAll, inferOne } from '../src/compiler/parameterKinds.js';
import { createHeldBody } from '../src/compiler/heldBody.js';
import { refValue, scoped, tokenValue } from '../src/compiler/wireForm.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { CoreValue } from '../src/ast/value.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

function refT(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function record(fields: Record<string, CoreValue>): CoreValue {
  return {
    kind: 'record',
    fields: Object.entries(fields).map(([name, value]) => ({ name, value: scoped(value) })),
  };
}

function array(...values: CoreValue[]): CoreValue {
  return { kind: 'array', elements: values.map((v) => scoped(v)) };
}

function token(text: string): CoreValue {
  return tokenValue(text);
}

/** `<parameters> => !typeRef coreValue` -- an open declaration, held the way `definitionResolver.ts` holds one. */
function template(
  parameters: readonly string[],
  typeRef: string,
  coreValue: CoreValue,
): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters,
    constructor: false,
    supertypes: [],
    subtypes: [],
    body: createHeldBody({ annotations: [], typeRef, coreValue }),
    annotations: [],
  };
}

function recordVocab(
  fields: readonly { readonly name: string; readonly type: string }[],
): TypeDefinition {
  const body: RecordBody = {
    kind: 'record',
    supertypes: [],
    groups: [],
    fields: fields.map((f) => ({
      name: f.name,
      type: refT(f.type),
      state: 'REQUIRED',
      annotations: [],
    })),
  };
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: true,
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

function arrayVocab(elementType: string): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters: [],
    constructor: true,
    supertypes: [],
    subtypes: [],
    body: {
      kind: 'array',
      elementType: refT(elementType),
      state: 'REQUIRED',
      unordered: false,
      uniqueItems: false,
    },
    annotations: [],
  };
}

function atomVocab(): TypeDefinition {
  return {
    kind: 'ATOM',
    parameters: [],
    constructor: true,
    supertypes: [],
    subtypes: [],
    body: { kind: 'unit' },
    annotations: [],
  };
}

/**
 * Just enough of the meta-kernel's own vocabulary for `array.element_type` to be `type_ref`,
 * `enum.members` a set of `identifier`, and `reference.target` a `type_ref` -- the exact three
 * slots §5.10's own motivating cases classify against.
 */
function baseMeta(): Map<string, TypeDefinition> {
  return new Map<string, TypeDefinition>([
    ['array', recordVocab([{ name: 'element_type', type: 'type_ref' }])],
    ['enum', recordVocab([{ name: 'members', type: 'enum_set' }])],
    ['enum_set', arrayVocab('identifier')],
    ['identifier', atomVocab()],
    ['reference', recordVocab([{ name: 'target', type: 'type_ref' }])],
    [
      'both',
      recordVocab([
        { name: 'x', type: 'type_ref' },
        { name: 'y', type: 'identifier' },
      ]),
    ],
  ]);
}

function noReports(): { report(name: string, error: TsonSchemaValidationError): void } {
  return {
    report(name: string): void {
      throw new Error(`unexpected report for '${name}'`);
    },
  };
}

// ── inferOne: one template's own occurrences ────────────────────────────────────────────────

describe('inferOne', () => {
  it('a parameter standing at a `type_ref`-typed slot is a TYPE parameter', () => {
    const box = template(['T'], 'array', record({ element_type: token('T') }));
    const kinds = inferOne(box, (name) => baseMeta().get(name));
    expect(kinds.get('T')).toBe('TYPE');
  });

  it(
    "the enum-member motivating case: 'e => <M> !enum { members: [a b M] }' -- M is a VALUE " +
      'parameter, not a reference (§5.10)',
    () => {
      const e = template(
        ['M'],
        'enum',
        record({ members: array(token('a'), token('b'), token('M')) }),
      );
      const kinds = inferOne(e, (name) => baseMeta().get(name));
      expect(kinds.get('M')).toBe('VALUE');
    },
  );

  it('a parameter standing for a whole collection (neither type_ref nor scalar) is refused, not deferred', () => {
    // `<T> !enum { members: T }` -- T stands for the whole `enum_set`, an ArrayBody, not one of
    // its elements.
    const bad = template(['T'], 'enum', record({ members: token('T') }));
    expect(() => inferOne(bad, (name) => baseMeta().get(name))).not.toThrow();
    expect(inferOne(bad, (name) => baseMeta().get(name)).size).toBe(0);
  });

  it('a parameter used as both a type and a value parameter yields no kinds (a conflict, caught by the batch pass)', () => {
    const both = template(['T'], 'both', record({ x: token('T'), y: token('T') }));
    const kinds = inferOne(both, (name) => baseMeta().get(name));
    expect(kinds.size).toBe(0);
  });

  it('a non-template (no parameters) or a non-held body yields no kinds', () => {
    const plain: TypeDefinition = {
      kind: 'PRODUCT',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [] },
      annotations: [],
    };
    expect(inferOne(plain, (name) => baseMeta().get(name)).size).toBe(0);
  });
});

// ── inferAll: the whole-namespace batch pass, with its fixed point ─────────────────────────────

describe('inferAll', () => {
  it('classifies a straightforward TYPE and VALUE case together', () => {
    const meta = baseMeta();
    const entries = new Map<string, TypeDefinition>([
      ['box', template(['T'], 'array', record({ element_type: token('T') }))],
      ['e', template(['M'], 'enum', record({ members: array(token('a'), token('M')) }))],
    ]);
    const kinds = inferAll(entries, new Set(entries.keys()), (name) => meta.get(name), noReports());
    expect(kinds.get('box')?.get('T')).toBe('TYPE');
    expect(kinds.get('e')?.get('M')).toBe('VALUE');
  });

  it(
    "a parameter riding another template's argument list takes the callee's kind, settled by a " +
      "fixed point (`wrap => <U> box<U>`, `box`'s own T is TYPE)",
    () => {
      const meta = baseMeta();
      const box = template(['T'], 'array', record({ element_type: token('T') }));
      const wrap = template(
        ['U'],
        'reference',
        record({
          target: refValue({
            name: 'box',
            arguments: [{ kind: 'ref', ref: refT('U') }],
            annotations: [],
          }),
        }),
      );
      const entries = new Map<string, TypeDefinition>([
        ['box', box],
        ['wrap', wrap],
      ]);
      const kinds = inferAll(
        entries,
        new Set(entries.keys()),
        (name) => meta.get(name),
        noReports(),
      );
      expect(kinds.get('box')?.get('T')).toBe('TYPE');
      expect(kinds.get('wrap')?.get('U')).toBe('TYPE');
    },
  );

  it(
    "a parameter grounded only by mutual template recursion ('loop => <T> loop<T>') is forced to " +
      'TYPE rather than reported as an error (§5.10, a deliberate divergence)',
    () => {
      const meta = baseMeta();
      const loop = template(
        ['T'],
        'reference',
        record({
          target: refValue({
            name: 'loop',
            arguments: [{ kind: 'ref', ref: refT('T') }],
            annotations: [],
          }),
        }),
      );
      const entries = new Map<string, TypeDefinition>([['loop', loop]]);
      const kinds = inferAll(
        entries,
        new Set(entries.keys()),
        (name) => meta.get(name),
        noReports(),
      );
      expect(kinds.get('loop')?.get('T')).toBe('TYPE');
    },
  );

  it('reports a declared entry whose parameter stands for a whole collection, at the declaration', () => {
    const meta = baseMeta();
    const bad = template(['T'], 'enum', record({ members: token('T') }));
    const entries = new Map<string, TypeDefinition>([['bad', bad]]);
    const reported: string[] = [];
    const kinds = inferAll(entries, new Set(['bad']), (name) => meta.get(name), {
      report(name, error): void {
        reported.push(name);
        expect(error).toBeInstanceOf(TsonSchemaValidationError);
      },
    });
    expect(reported).toEqual(['bad']);
    expect(kinds.has('bad')).toBe(false);
  });

  it('reports a declared entry whose parameter is used as both a type and a value parameter', () => {
    const meta = baseMeta();
    const both = template(['T'], 'both', record({ x: token('T'), y: token('T') }));
    const entries = new Map<string, TypeDefinition>([['both', both]]);
    const reported: string[] = [];
    const kinds = inferAll(entries, new Set(['both']), (name) => meta.get(name), {
      report(name, error): void {
        reported.push(name);
        expect(error.message).toContain('both a type position and a value position');
      },
    });
    expect(reported).toEqual(['both']);
    expect(kinds.has('both')).toBe(false);
  });

  it("never reports an imported entry's own failure against this schema (`declared` filters it)", () => {
    const meta = baseMeta();
    const bad = template(['T'], 'enum', record({ members: token('T') }));
    const entries = new Map<string, TypeDefinition>([['imported_bad', bad]]);
    const kinds = inferAll(entries, new Set(), (name) => meta.get(name), noReports());
    expect(kinds.has('imported_bad')).toBe(false);
  });

  it('skips a non-parameterised entry and one with no held body entirely', () => {
    const meta = baseMeta();
    const plain: TypeDefinition = {
      kind: 'PRODUCT',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields: [], groups: [] },
      annotations: [],
    };
    const entries = new Map<string, TypeDefinition>([['plain', plain]]);
    const kinds = inferAll(entries, new Set(entries.keys()), (name) => meta.get(name), noReports());
    expect(kinds.has('plain')).toBe(false);
  });
});
