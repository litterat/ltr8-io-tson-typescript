import { describe, expect, it } from 'vitest';

import { renames, rewrite } from '../src/compiler/syntheticMerge.js';
import type { TemplateMaterialiser } from '../src/compiler/templates.js';
import { refValue, scoped } from '../src/compiler/wireForm.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { Declaration } from '../src/ast/schema/document.js';
import type { RecordField, RecordValue } from '../src/ast/value.js';
import type { TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

function refT(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

/** A generated `!C value` declaration -- the shape `desugar.ts`'s own lift injects. */
function generatedDeclaration(
  name: string,
  typeParams: readonly string[],
  typeRef: string,
  coreValue: RecordValue,
): Declaration {
  return {
    nameAnnotations: [],
    name,
    typeDefAnnotations: [],
    typeDef: { kind: 'instance', typeParams, value: { annotations: [], typeRef, coreValue } },
  };
}

/** An `!array { element_type: <TypeRef> }` binding record, `wireForm.ts`'s own held spelling. */
function arrayBinding(elementType: TypeRef): RecordValue {
  return {
    kind: 'record',
    fields: [{ name: 'element_type', value: scoped(refValue(elementType)) }],
  };
}

function stubMaterialiser(
  closedFormName: (head: string, fields: readonly RecordField[]) => string,
): TemplateMaterialiser {
  return {
    closeApplication(): string {
      throw new Error('not exercised by this test');
    },
    materialise() {
      throw new Error('not exercised by this test');
    },
    syntheticNames(): ReadonlySet<string> {
      return new Set();
    },
    setParameterKinds(): void {
      // not exercised by this test
    },
    closedFormName,
  };
}

function record(name: string, body: TypeDefinition['body'], source?: TypeRef): TypeDefinition {
  return {
    ...(source === undefined ? {} : { source }),
    kind: 'PRODUCT',
    parameters: [],
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

// ── renames ──────────────────────────────────────────────────────────────────────────────────

describe('renames', () => {
  it('§8.2 motivating case: `[box<text>]` written directly re-derives to the name `[T]` closed with `T := text` would take', () => {
    // The eager name `desugar.ts` minted from the *unreduced* record (as written) -- irrelevant to
    // this test beyond being a key in `generated`/`declarations`.
    const eagerName = 'array_box_text_heager1';
    const declarations = new Map<string, Declaration>([
      [
        eagerName,
        generatedDeclaration(
          eagerName,
          [],
          'array',
          arrayBinding({
            name: 'box',
            arguments: [{ kind: 'ref', ref: refT('text') }],
            annotations: [],
          }),
        ),
      ],
    ]);
    // The name the *closed* record (`box<text>` already reduced to its own entry) re-derives to --
    // exactly what `[T]` closed with `T := text` would mint through `closeHeldTemplate`.
    const closedName = 'array_boxed_text_hclosed1';
    const materialiser = stubMaterialiser(() => closedName);
    const result = renames(declarations, new Set([eagerName]), materialiser);
    expect(result).toEqual(new Map([[eagerName, closedName]]));
  });

  it('is a no-op when the closed name and the eager name coincide', () => {
    const name = 'array_text_h1';
    const declarations = new Map<string, Declaration>([
      [name, generatedDeclaration(name, [], 'array', arrayBinding(refT('text')))],
    ]);
    const materialiser = stubMaterialiser(() => name);
    expect(renames(declarations, new Set([name]), materialiser).size).toBe(0);
  });

  it('skips an open synthetic (non-empty type parameters) -- it has its own identity rule (§8.2)', () => {
    const name = 'array_p0_h1';
    const declarations = new Map<string, Declaration>([
      [name, generatedDeclaration(name, ['T'], 'array', arrayBinding(refT('T')))],
    ]);
    const materialiser = stubMaterialiser(() => {
      throw new Error('closedFormName must not be asked about an open synthetic');
    });
    expect(renames(declarations, new Set([name]), materialiser).size).toBe(0);
  });

  it('skips a generated name with no binding record recoverable (no declaration, or not an Instance)', () => {
    const materialiser = stubMaterialiser(() => {
      throw new Error('closedFormName must not be asked with nothing to close');
    });
    expect(renames(new Map(), new Set(['missing']), materialiser).size).toBe(0);
  });

  it('never asks the materialiser about a form that holds no application -- nothing to reduce', () => {
    const name = 'array_text_h1';
    const declarations = new Map<string, Declaration>([
      [name, generatedDeclaration(name, [], 'array', arrayBinding(refT('text')))],
    ]);
    const materialiser = stubMaterialiser(() => {
      throw new Error('closedFormName must not be asked when holdsApplication is false');
    });
    expect(renames(declarations, new Set([name]), materialiser).size).toBe(0);
  });

  it('skips a form the materialiser cannot yet close (its schema is being reported anyway)', () => {
    const eagerName = 'array_box_text_h1';
    const declarations = new Map<string, Declaration>([
      [
        eagerName,
        generatedDeclaration(
          eagerName,
          [],
          'array',
          arrayBinding({
            name: 'box',
            arguments: [{ kind: 'ref', ref: refT('text') }],
            annotations: [],
          }),
        ),
      ],
    ]);
    const materialiser = stubMaterialiser(() => {
      throw new TsonSchemaValidationError('cannot close');
    });
    expect(renames(declarations, new Set([eagerName]), materialiser).size).toBe(0);
  });

  it('finds an application nested inside an array element (not only at the top slot)', () => {
    const eagerName = 'array_array_box_text_h1';
    const nestedBinding: RecordValue = {
      kind: 'record',
      fields: [
        {
          name: 'element_type',
          value: scoped({
            kind: 'array',
            elements: [
              scoped(
                refValue({
                  name: 'box',
                  arguments: [{ kind: 'ref', ref: refT('text') }],
                  annotations: [],
                }),
              ),
            ],
          }),
        },
      ],
    };
    const declarations = new Map<string, Declaration>([
      [eagerName, generatedDeclaration(eagerName, [], 'array', nestedBinding)],
    ]);
    const closedName = 'array_array_boxed_text_h2';
    const materialiser = stubMaterialiser(() => closedName);
    expect(renames(declarations, new Set([eagerName]), materialiser)).toEqual(
      new Map([[eagerName, closedName]]),
    );
  });
});

// ── rewrite ──────────────────────────────────────────────────────────────────────────────────

describe('rewrite', () => {
  it("rewrites a field's type, a `source`, and an array's `elementType` onto the merged name", () => {
    const entries = new Map<string, TypeDefinition>([
      [
        'a',
        record('a', {
          kind: 'record',
          supertypes: [],
          groups: [],
          fields: [{ name: 'v', type: refT('eager'), state: 'REQUIRED', annotations: [] }],
        }),
      ],
      [
        'b',
        record(
          'b',
          {
            kind: 'array',
            elementType: refT('eager'),
            state: 'REQUIRED',
            unordered: false,
            uniqueItems: false,
          },
          refT('eager'),
        ),
      ],
    ]);
    rewrite(entries, new Map([['eager', 'closed']]));
    const a = entries.get('a');
    const b = entries.get('b');
    if (a === undefined || b === undefined || !('fields' in a.body) || !('elementType' in b.body)) {
      throw new Error('unreachable');
    }
    expect(a.body.fields[0]?.type.name).toBe('closed');
    expect(b.body.elementType.name).toBe('closed');
    expect(b.source?.name).toBe('closed');
  });

  it('leaves a reference untouched when it names nothing in the rename map', () => {
    const entries = new Map<string, TypeDefinition>([
      [
        'a',
        record('a', {
          kind: 'record',
          supertypes: [],
          groups: [],
          fields: [{ name: 'v', type: refT('untouched'), state: 'REQUIRED', annotations: [] }],
        }),
      ],
    ]);
    rewrite(entries, new Map([['eager', 'closed']]));
    const a = entries.get('a');
    if (a === undefined || !('fields' in a.body)) throw new Error('unreachable');
    expect(a.body.fields[0]?.type.name).toBe('untouched');
  });
});
