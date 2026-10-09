import { describe, expect, it } from 'vitest';

import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { collector } from '../src/core/diagnostic.js';
import {
  TsonBindMismatchError,
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import {
  resolveSchema,
  type ImportedSchema,
  type Schema,
  type SchemaResolverDeps,
} from '../src/compiler/schemaResolver.js';
import { metaFormOfLexer } from '../src/compiler/tokenForms.js';
import { FIELDS, NAME, OPTIONAL, field } from '../src/compiler/wireForm.js';
import type { HeldBody } from '../src/compiler/heldBody.js';
import type { DataValue, RecordValue, TokenValue } from '../src/ast/value.js';
import type { SchemaDocument } from '../src/ast/schema/document.js';
import type { ArrayBody, EnumBody, RecordBody, RecordField } from '../src/schema/meta/bodies.js';
import type { Top, TypeArgument, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';
import { typeParameters } from '../src/schema/meta/typedef.js';

// ── Parsing helper ───────────────────────────────────────────────────────────────────────────

function parse(header: string, declarations: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(`${header} { ${declarations} }`)));
}

/** The common case: one meta, no imports, `!!id` present -- every declaration text is the caller's own. */
function document(declarations: string, id = 'https://example.com/s.tn'): SchemaDocument {
  return parse(`!!id:"${id}" !!meta:"https://example.com/m.tn"`, declarations);
}

// ── A minimal hand-rolled reader for `record`/`array` binding records ──────────────────────────
//
// Just enough of `definitionMetaReader`'s contract to bind what `definitionResolver.ts`/
// `templates.ts` actually hand it in these tests: the wire shapes `desugar.ts` and `heldBody.ts`
// themselves produce for a fresh record body and an array sugar lift. Not a stand-in for a real
// compiled reader (no field-level validation, no defaults) -- this package's own conformance
// suite exercises the real thing; this file only has to prove `schemaResolver.ts`'s own driving
// logic, which is agnostic to how a value gets bound.

function fieldOf(record: RecordValue, name: string): DataValue | undefined {
  return record.fields.find((f) => f.name === name)?.value.value;
}

function typeRefField(record: RecordValue, name: string): TypeRef {
  const value = fieldOf(record, name)?.coreValue;
  if (value === undefined) throw new Error(`missing '${name}'`);
  if (value.kind === 'token') return { name: value.text, arguments: [], annotations: [] };
  throw new Error(`unsupported type_ref wire shape for '${name}'`);
}

function testMetaReader(type: string, value: DataValue): Top {
  const record = value.coreValue as RecordValue;
  if (type === 'record') {
    const fieldsField = fieldOf(record, 'fields')?.coreValue;
    const fields: RecordField[] = [];
    if (fieldsField?.kind === 'array') {
      for (const element of fieldsField.elements) {
        const fieldRecord = element.value.coreValue as RecordValue;
        const name = (fieldOf(fieldRecord, 'name')?.coreValue as TokenValue).text;
        fields.push({
          name,
          type: typeRefField(fieldRecord, 'type'),
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        });
      }
    }
    const extensionField = fieldOf(record, 'extension')?.coreValue;
    const extension =
      extensionField?.kind === 'token' && extensionField.text === 'ABSTRACT'
        ? 'ABSTRACT'
        : extensionField?.kind === 'token' && extensionField.text === 'FINAL'
          ? 'FINAL'
          : 'OPEN';
    const discriminatorsField = fieldOf(record, 'discriminators')?.coreValue;
    const discriminators: string[] = [];
    if (discriminatorsField?.kind === 'array') {
      for (const element of discriminatorsField.elements) {
        const token = element.value.coreValue as TokenValue;
        discriminators.push(token.text);
      }
    }
    return {
      kind: 'record',
      supertypes: [],
      fields,
      groups: [],
      extension,
      discriminators,
    } satisfies RecordBody;
  }
  if (type === 'array') {
    return {
      kind: 'array',
      elementType: typeRefField(record, 'element_type'),
      voidable: false,
      ordered: true,
      uniqueItems: false,
    } satisfies ArrayBody;
  }
  throw new Error(`testMetaReader: unhandled constructor '${type}'`);
}

const neverCalled = (type: string): Top => {
  throw new Error(`not exercised by this test: '${type}'`);
};

/**
 * A structure namespace with the two constructors these tests' sugar/template forms apply --
 * enough vocabulary for `checkTemplateBindings` (§5.10's own declaration-time check) and
 * `testMetaReader` to have somewhere to bind them, mirroring the real `record`/`array` shapes
 * `spec/m/meta-kernel-resolved.tn` declares (`heldBody.ts`'s own `RECORD`/`ARRAY` wire fields).
 */
function testStructureNamespace(): (name: string) => TypeDefinition | undefined {
  const anyType: TypeRef = { name: 'any', arguments: [], annotations: [] };
  const constructorEntry = (fields: readonly RecordField[]): TypeDefinition => ({
    // IS-A `top` through `product` (hand-built) is what makes `isConstructor` true.
    supertypes: ['product', 'top'],
    subtypes: [],
    body: {
      kind: 'record',
      supertypes: [],
      fields,
      groups: [],
      extension: 'OPEN',
    },
    annotations: [],
  });
  const structure = new Map<string, TypeDefinition>([
    [
      'record',
      constructorEntry([
        {
          name: 'fields',
          type: anyType,
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
      ]),
    ],
    [
      'array',
      constructorEntry([
        {
          name: 'element_type',
          type: anyType,
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
      ]),
    ],
  ]);
  return (name) => structure.get(name);
}

function deps(overrides: Partial<SchemaResolverDeps> = {}): SchemaResolverDeps {
  return {
    definitionMetaReader: overrides.definitionMetaReader ?? neverCalled,
    metaDefinitions: overrides.metaDefinitions ?? (() => undefined),
    ...(overrides.annotationValueReader === undefined
      ? {}
      : { annotationValueReader: overrides.annotationValueReader }),
    ...(overrides.encodeSourceBody === undefined
      ? {}
      : { encodeSourceBody: overrides.encodeSourceBody }),
    ...(overrides.resolveImport === undefined ? {} : { resolveImport: overrides.resolveImport }),
  };
}

/** `deps()` plus a working `record`/`array` reader and structure namespace -- what every sugar/template test in this file needs. */
function depsWithReader(): SchemaResolverDeps {
  return deps({ definitionMetaReader: testMetaReader, metaDefinitions: testStructureNamespace() });
}

function isRecordBody(body: Top): body is RecordBody {
  return 'fields' in body;
}

function isArrayBody(body: Top): body is ArrayBody {
  return 'elementType' in body;
}

function entryOf(schema: Schema, name: string): TypeDefinition {
  const entry = schema.entries.get(name);
  if (entry === undefined) throw new Error(`resolved schema has no entry '${name}'`);
  return entry;
}

function recordBodyOf(schema: Schema, name: string): RecordBody {
  const body = entryOf(schema, name).body;
  if (!isRecordBody(body)) throw new Error(`'${name}' is not record-shaped`);
  return body;
}

function fieldTypeOf(schema: Schema, name: string, field: string): TypeRef {
  const found = recordBodyOf(schema, name).fields.find((f) => f.name === field);
  if (found === undefined) throw new Error(`'${name}' has no field '${field}'`);
  return found.type;
}

/**
 * Whether a *still-open* entry's held wire (`wireForm.ts`'s own `heldRecord` spelling, §5.10)
 * marks one field `optional` -- `heldRecord` writes the `optional` member only when the fact is
 * `true`, so this reads the held text directly rather than through a `RecordBody`, which a held
 * entry's `TypeDefinition.body` is not (it is a `HeldBody`, unread until its parameters close).
 */
function heldFieldOptional(schema: Schema, name: string, fieldName: string): boolean {
  const body = entryOf(schema, name).body;
  if (!('application' in body)) throw new Error(`'${name}' is not a held (open) entry`);
  const coreValue = (body as HeldBody).application.coreValue;
  if (coreValue.kind !== 'record') throw new Error(`'${name}' holds no record wire`);
  const fieldsValue = field(coreValue, FIELDS);
  if (fieldsValue?.kind !== 'array') throw new Error(`'${name}' holds no 'fields' array`);
  for (const element of fieldsValue.elements) {
    const fieldRecord = element.value.coreValue;
    if (fieldRecord.kind !== 'record') continue;
    const nameToken = field(fieldRecord, NAME);
    if (nameToken?.kind === 'token' && nameToken.text === fieldName) {
      return field(fieldRecord, OPTIONAL) !== undefined;
    }
  }
  throw new Error(`'${name}' has no held field '${fieldName}'`);
}

// ── !!id / header handling ───────────────────────────────────────────────────────────────────

describe('!!id and header handling', () => {
  it('throws TsonSchemaValidationError when !!id is absent', () => {
    const doc = parse('!!meta:"https://example.com/m.tn"', 'x => { v: text }');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('carries !!id/!!meta/!!import straight through to the result', () => {
    const doc = parse(
      '!!id:"https://example.com/s.tn" !!meta:"https://example.com/m.tn" ' +
        '!!import:"https://example.com/i.tn"',
      'x => { v: text }',
    );
    const schema = resolveSchema(
      doc,
      deps({
        resolveImport: (): ImportedSchema => ({
          entries: new Map(),
          originOf: () => 'https://example.com/i.tn',
        }),
      }),
    );
    expect(schema.id).toBe('https://example.com/s.tn');
    expect(schema.meta).toBe('https://example.com/m.tn');
    expect(schema.imports).toEqual(['https://example.com/i.tn']);
    expect(schema.bootstrap).toBe(false);
  });
});

// ── The driving loop: dependency order, not source order (§3.4.1) ──────────────────────────────

describe('resolving a whole document, on demand and dependency-following', () => {
  it('resolves a composition supertype declared LATER in the same schema', () => {
    const doc = document('child => parent & { y: text } parent => { x: text }');
    const schema = resolveSchema(doc, deps());
    expect(schema.entries.size).toBe(2);
    const child = recordBodyOf(schema, 'child');
    expect(child.fields.map((f) => f.name).sort()).toEqual(['x', 'y']);
    expect(child.supertypes).toEqual([{ name: 'parent', arguments: [], annotations: [] }]);
  });

  it('resolves every declaration exactly once, however many others depend on it', () => {
    const doc = document('a => base & {} b => base & {} base => { x: text }');
    const schema = resolveSchema(doc, deps());
    expect(schema.entries.size).toBe(3);
    expect(recordBodyOf(schema, 'a').supertypes).toEqual([
      { name: 'base', arguments: [], annotations: [] },
    ]);
    expect(recordBodyOf(schema, 'b').supertypes).toEqual([
      { name: 'base', arguments: [], annotations: [] },
    ]);
  });

  it('rejects a circular composition chain', () => {
    const doc = document('a => b & {} b => a & {}');
    expect(() => resolveSchema(doc, deps())).toThrow(/circular/);
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('rejects a composition supertype naming nothing this schema declares', () => {
    const doc = document('a => nowhere & {}');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });
});

// ── !!import merging ─────────────────────────────────────────────────────────────────────────

describe('!!import merging into the type-name namespace', () => {
  it('lets a local declaration compose with an imported one', () => {
    const imported = new Map<string, TypeDefinition>([
      [
        'base',
        {
          supertypes: [],
          subtypes: [],
          body: {
            kind: 'record',
            supertypes: [],
            fields: [],
            groups: [],
            extension: 'OPEN',
          },
          annotations: [],
        },
      ],
    ]);
    const doc = parse(
      '!!id:"https://example.com/s.tn" !!meta:"https://example.com/m.tn" ' +
        '!!import:"https://example.com/i.tn"',
      'child => base & { y: text }',
    );
    const schema = resolveSchema(
      doc,
      deps({
        resolveImport: (uri): ImportedSchema => {
          expect(uri).toBe('https://example.com/i.tn');
          return { entries: imported, originOf: () => uri };
        },
      }),
    );
    expect(recordBodyOf(schema, 'child').supertypes).toEqual([
      { name: 'base', arguments: [], annotations: [] },
    ]);
    // Imported entries are visible during resolution but never part of the local-only result.
    expect(schema.entries.has('base')).toBe(false);
  });

  it('rejects a local declaration colliding with an imported name', () => {
    const imported = new Map<string, TypeDefinition>([
      [
        'base',
        {
          supertypes: [],
          subtypes: [],
          body: {
            kind: 'record',
            supertypes: [],
            fields: [],
            groups: [],
            extension: 'OPEN',
          },
          annotations: [],
        },
      ],
    ]);
    const doc = parse(
      '!!id:"https://example.com/s.tn" !!meta:"https://example.com/m.tn" ' +
        '!!import:"https://example.com/i.tn"',
      'base => { x: text }',
    );
    expect(() =>
      resolveSchema(
        doc,
        deps({
          resolveImport: (uri): ImportedSchema => ({ entries: imported, originOf: () => uri }),
        }),
      ),
    ).toThrow(TsonSchemaValidationError);
  });

  it('reports TsonNotImplementedError for a document that writes !!import with no loader supplied', () => {
    const doc = parse(
      '!!id:"https://example.com/s.tn" !!meta:"https://example.com/m.tn" ' +
        '!!import:"https://example.com/i.tn"',
      'x => { v: text }',
    );
    expect(() => resolveSchema(doc, deps())).toThrow(TsonNotImplementedError);
  });
});

// ── Collecting mode: a receiver lets every other declaration still resolve ─────────────────────

describe('collecting mode (a DiagnosticsReceiver in options)', () => {
  it('fails fast with no receiver: the first bad declaration throws and nothing is returned', () => {
    const doc = document('bad => nowhere & {} good => { x: text }');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('with a receiver, reports the bad declaration and still resolves the rest', () => {
    const doc = document('bad => nowhere & {} good => { x: text }');
    const receiver = collector();
    const schema = resolveSchema(doc, deps(), { receiver });
    expect(receiver.diagnostics).toHaveLength(1);
    expect(receiver.diagnostics[0]?.code).toBe('SCHEMA_ERROR');
    expect(receiver.diagnostics[0]?.schemaPointer).toBe('/bad');
    // `good` resolved cleanly despite `bad`'s failure.
    expect(recordBodyOf(schema, 'good').fields.map((f) => f.name)).toEqual(['x']);
    // `bad` is present as an absorbing placeholder, not missing.
    expect(schema.entries.has('bad')).toBe(true);
    expect(recordBodyOf(schema, 'bad').fields).toEqual([]);
  });
});

// ── Positive classification: every reportable failure gets its own code, nothing falls to a
//    catch-all, and an error none of the four categories claims still propagates as itself ─────

/** A structure namespace exposing one constructor entry, `ctorName`, for `!ctorName { }` declarations to resolve against. */
function structureNamespaceWith(ctorName: string): (name: string) => TypeDefinition | undefined {
  const entry: TypeDefinition = {
    // IS-A `top` through `product` (hand-built) is what makes `isConstructor` true.
    supertypes: ['product', 'top'],
    subtypes: [],
    body: {
      kind: 'record',
      supertypes: [],
      fields: [],
      groups: [],
      extension: 'OPEN',
    },
    annotations: [],
  };
  return (name) => (name === ctorName ? entry : undefined);
}

describe('positive classification of a failed declaration', () => {
  it("reports BIND_MISMATCH for a TsonBindMismatchError the meta reader throws while binding '!ctor { }'", () => {
    const doc = document('bad => !something { }  good => { x: text }');
    const receiver = collector();
    const schema = resolveSchema(
      doc,
      deps({
        definitionMetaReader: () => {
          throw new TsonBindMismatchError("bound class disagrees with 'something'");
        },
        metaDefinitions: structureNamespaceWith('something'),
      }),
      { receiver },
    );
    expect(receiver.diagnostics).toHaveLength(1);
    expect(receiver.diagnostics[0]?.code).toBe('BIND_MISMATCH');
    expect(receiver.diagnostics[0]?.schemaPointer).toBe('/bad');
    expect(recordBodyOf(schema, 'good').fields.map((f) => f.name)).toEqual(['x']);
  });

  it('reports the code belonging to the fetch reason for a TsonSchemaFetchError the structure namespace throws', () => {
    // Injected through `metaDefinitions` rather than `definitionMetaReader`: the latter's own
    // caller (`definitionResolver.ts`'s `bindAtomInstance`) already folds an unrecognised error
    // from that particular seam into `TsonNotImplementedError`, so a fetch failure can only reach
    // this resolver's own classifier unwrapped through a namespace lookup, exactly as a governing
    // meta backed by a real schema loader would raise one.
    const doc = document('bad => !something { }  good => { x: text }');
    const receiver = collector();
    const schema = resolveSchema(
      doc,
      deps({
        metaDefinitions: (name) => {
          if (name === 'something') {
            throw new TsonSchemaFetchError(
              'https://example.com/unreachable.tn',
              'not-permitted',
              'no configured source would supply this schema',
            );
          }
          return undefined;
        },
      }),
      { receiver },
    );
    expect(receiver.diagnostics).toHaveLength(1);
    expect(receiver.diagnostics[0]?.code).toBe('SCHEMA_NOT_PERMITTED');
    expect(receiver.diagnostics[0]?.schemaPointer).toBe('/bad');
    expect(recordBodyOf(schema, 'good').fields.map((f) => f.name)).toEqual(['x']);
  });

  it('rethrows a BIND_MISMATCH-worthy error unchanged when there is no receiver (fail-fast)', () => {
    const doc = document('bad => !something { }');
    expect(() =>
      resolveSchema(
        doc,
        deps({
          definitionMetaReader: () => {
            throw new TsonBindMismatchError('mismatch');
          },
          metaDefinitions: structureNamespaceWith('something'),
        }),
      ),
    ).toThrow(TsonBindMismatchError);
  });

  it('never classifies an unrecognised error as a verdict -- it propagates as itself, not SCHEMA_ERROR', () => {
    // `metaDefinitions` throwing is a bug in the caller-supplied structure namespace, not any of
    // the four reportable categories -- injected here rather than through `definitionMetaReader`,
    // since `definitionResolver.ts`'s own `bindAtomInstance` already folds an unrecognised error
    // from *that* seam into `TsonNotImplementedError` (a deliberate, lower-level classification
    // this test is not the one to re-cover).
    const doc = document('bad => !something { }');
    const receiver = collector();
    expect(() =>
      resolveSchema(
        doc,
        deps({
          metaDefinitions: () => {
            throw new TsonInternalError('a bug in this namespace, not a document problem');
          },
        }),
        { receiver },
      ),
    ).toThrow(TsonInternalError);
    // Nothing was reported -- the fault propagated instead of being laundered into a diagnostic.
    expect(receiver.diagnostics).toHaveLength(0);
  });
});

// ── §5.3 sugar lift and the @synthetic key marker (§8.2) ────────────────────────────────────────

describe('a sugar form lifts to a synthetic entry, marked @synthetic at its key', () => {
  it('desugars [text] to a synthetic array instance and marks only that key', () => {
    const doc = document('wrapper => { v: [text] }');
    const schema = resolveSchema(doc, depsWithReader());
    expect(schema.entries.size).toBe(2); // wrapper + one lifted array entry
    const fieldType = fieldTypeOf(schema, 'wrapper', 'v');
    const synthetic = entryOf(schema, fieldType.name);
    expect(synthetic.source).toEqual({ name: 'array', arguments: [], annotations: [] });
    expect(schema.keyAnnotations.get(fieldType.name)).toEqual([{ name: 'synthetic' }]);
    // The author's own declaration carries no @synthetic marker.
    expect(schema.keyAnnotations.has('wrapper')).toBe(false);
  });
});

// ── §5.10 template materialisation, wired through the real templates.ts ────────────────────────

describe('template materialisation (§5.10), end to end through the real TemplateMaterialiser', () => {
  it('closes text_box => box<text> to the instantiation entry a record template denotes (§5.10, §8.2)', () => {
    const doc = document('box => <T> { v: T } text_box => box<text>');
    const schema = resolveSchema(doc, depsWithReader());
    // `box` itself stays a template (it is still open, with a parameter list).
    expect(typeParameters(entryOf(schema, 'box'))).toEqual(['T']);
    // §8.2: a declaration whose body is a fully-bound application IS the instantiation entry --
    // `text_box` is the closed record itself, carrying the application in its own `source`, with
    // no minted twin beside it and no `!reference` hop.
    const text_box = entryOf(schema, 'text_box');
    // Not `kindOf` (whose own note says it never needs the structure-namespace fourth branch in
    // this file's fixtures): `text_box` is a genuine, closed `!record` body, not a `!reference`.
    expect(isRecordBody(text_box.body)).toBe(true);
    expect(text_box.source).toEqual({
      name: 'box',
      arguments: [{ kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } }],
      annotations: [],
    });
    expect(fieldTypeOf(schema, 'text_box', 'v').name).toBe('text');
  });

  it('closes a composition supertype that is a closed generic application on demand, during resolution', () => {
    const doc = document('box => <T> { v: T } wrapped => box<text> & { w: text }');
    const schema = resolveSchema(doc, depsWithReader());
    const wrapped = recordBodyOf(schema, 'wrapped');
    // Absorbed box<text>'s own field (v: text) plus wrapped's own (w: text).
    expect(wrapped.fields.map((f) => f.name).sort()).toEqual(['v', 'w']);
  });

  it('rejects head abstraction -- a type parameter applied to arguments (§5.10)', () => {
    const doc = document('bad => <T> { v: T<text> }');
    expect(() => resolveSchema(doc, depsWithReader())).toThrow(TsonSchemaValidationError);
  });

  it('a record-bodied template is a family base, ABSTRACT and derived, with no discriminators of its own to erase (§5.10, §8.1)', () => {
    const doc = document('box => <T> { v: T }');
    const schema = resolveSchema(doc, depsWithReader());
    const box = entryOf(schema, 'box');
    expect(typeParameters(box)).toEqual(['T']);
    // Never OPEN and never FINAL: nothing is ever read against the template itself (§5.10).
    expect((box.body as { readonly extension?: string }).extension).toBe('ABSTRACT');
    // The list is present only where a selector survives erasure of the parameters, so a base
    // with none is tag-dispatched (§5.10).
    expect(
      (box.body as { readonly discriminators?: readonly string[] }).discriminators,
    ).toBeUndefined();
  });

  it("an author-written 'abstract' on a record template travels inside the held text to every instantiation (§5.10)", () => {
    const doc = document('outcome => abstract <T> { code: T } outcome_of => outcome<text>');
    const schema = resolveSchema(doc, depsWithReader());
    // The template's own entry states the derived fact regardless of the author's own word.
    expect((entryOf(schema, 'outcome').body as { readonly extension?: string }).extension).toBe(
      'ABSTRACT',
    );
    // §8.2: `outcome_of` is the instantiation entry itself (no minted twin) -- and the `abstract`
    // the author wrote on `outcome` is baked into the held text, so this *closed* record's own
    // `extension` states it too (the "instantiation's own... stated, by `abstract` inside the held
    // text" level, distinct from the template's own derived fact just above).
    const outcomeOf = entryOf(schema, 'outcome_of');
    expect(isRecordBody(outcomeOf.body) && outcomeOf.body.extension).toBe('ABSTRACT');
  });

  it("'final' on a template is refused -- a template's applications are subtypes by construction (§5.10)", () => {
    const doc = document('sneaky => final <T> { v: T }');
    expect(() => resolveSchema(doc, depsWithReader())).toThrow(TsonSchemaValidationError);
  });

  it('a selector whose declared type mentions a type parameter is refused (§5.10)', () => {
    const doc = document('bad => <T> { sel: T =? }');
    expect(() => resolveSchema(doc, depsWithReader())).toThrow(TsonSchemaValidationError);
  });
});

// ── A richer reader/structure namespace: application record-forms and `enum` ───────────────
//
// `testMetaReader`/`testStructureNamespace` above only ever meet a bare name in `element_type`/
// `type`. The two describe blocks below need a slot that reads an *application* (§5.10's
// materialisation closing one first) and a governing meta with `enum`/`enum_set`/`identifier`
// wired up (§5.10's own VALUE-parameter motivating case) -- so they get their own, richer pair.

function richTypeRefField(record: RecordValue, name: string): TypeRef {
  const value = fieldOf(record, name)?.coreValue;
  if (value === undefined) throw new Error(`missing '${name}'`);
  if (value.kind === 'token') return { name: value.text, arguments: [], annotations: [] };
  const argsRecord = value as RecordValue;
  const head = (fieldOf(argsRecord, 'name')?.coreValue as TokenValue).text;
  const argumentsValue = fieldOf(argsRecord, 'arguments')?.coreValue;
  const args: TypeArgument[] = [];
  if (argumentsValue?.kind === 'array') {
    for (const element of argumentsValue.elements) {
      const argRecord = element.value.coreValue as RecordValue;
      const literal = fieldOf(argRecord, 'value')?.coreValue;
      if (literal !== undefined) {
        const token = literal as TokenValue;
        args.push({
          kind: 'value',
          value: { text: token.text, form: metaFormOfLexer(token.form) },
        });
      } else {
        args.push({ kind: 'ref', ref: richTypeRefField(argRecord, 'name') });
      }
    }
  }
  return { name: head, arguments: args, annotations: [] };
}

/** `true` when `record`'s `name` field is a `token` holding the literal `"true"` -- §5.2's `optional`/`voidable` wire fields, written only when `true` (`desugar.ts`'s own `recordFieldValue`). */
function richBooleanField(record: RecordValue, name: string): boolean {
  const value = fieldOf(record, name)?.coreValue;
  return value?.kind === 'token' && value.text === 'true';
}

function richMetaReader(type: string, value: DataValue): Top {
  const record = value.coreValue as RecordValue;
  if (type === 'record') {
    const fieldsField = fieldOf(record, 'fields')?.coreValue;
    const fields: RecordField[] = [];
    if (fieldsField?.kind === 'array') {
      for (const element of fieldsField.elements) {
        const fieldRecord = element.value.coreValue as RecordValue;
        const fname = (fieldOf(fieldRecord, 'name')?.coreValue as TokenValue).text;
        const roleWire = fieldOf(fieldRecord, 'role')?.coreValue;
        const role: RecordField['role'] =
          roleWire?.kind === 'token' && (roleWire.text === 'DEFAULT' || roleWire.text === 'FIXED')
            ? roleWire.text
            : 'FREE';
        const valueWire = fieldOf(fieldRecord, 'value')?.coreValue;
        const fieldValue =
          valueWire?.kind === 'token'
            ? { text: valueWire.text, form: metaFormOfLexer(valueWire.form) }
            : undefined;
        fields.push({
          name: fname,
          type: richTypeRefField(fieldRecord, 'type'),
          optional: richBooleanField(fieldRecord, 'optional'),
          voidable: richBooleanField(fieldRecord, 'voidable'),
          role,
          ...(fieldValue === undefined ? {} : { value: fieldValue }),
          annotations: [],
        });
      }
    }
    return {
      kind: 'record',
      supertypes: [],
      fields,
      groups: [],
      extension: 'OPEN',
    } satisfies RecordBody;
  }
  if (type === 'array') {
    return {
      kind: 'array',
      elementType: richTypeRefField(record, 'element_type'),
      voidable: false,
      ordered: true,
      uniqueItems: false,
    } satisfies ArrayBody;
  }
  if (type === 'enum') {
    const membersField = fieldOf(record, 'members')?.coreValue;
    const members: string[] = [];
    if (membersField?.kind === 'array') {
      for (const element of membersField.elements) {
        members.push((element.value.coreValue as TokenValue).text);
      }
    }
    return { kind: 'enum', members, type: 'identifier' } satisfies EnumBody;
  }
  throw new Error(`richMetaReader: unhandled constructor '${type}'`);
}

/**
 * A structure namespace whose `record.fields[].type`/`array.element_type` are genuinely typed
 * `type_ref` (unlike `testStructureNamespace()`'s placeholder `any`, which the other describe
 * blocks in this file don't care about) -- §5.10's `ParameterKinds` walk classifies a parameter
 * by the slot's *declared* type, so this is the one thing a realistic governing meta must get
 * right for these two describe blocks. Plus `enum`/`enum_set`/`identifier`, the VALUE-parameter
 * motivating case's own vocabulary.
 */
function richStructureNamespace(): (name: string) => TypeDefinition | undefined {
  const typeRefType: TypeRef = { name: 'type_ref', arguments: [], annotations: [] };
  const constructorEntry = (fields: readonly RecordField[]): TypeDefinition => ({
    // IS-A `top` through `product` (hand-built) is what makes `isConstructor` true.
    supertypes: ['product', 'top'],
    subtypes: [],
    body: {
      kind: 'record',
      supertypes: [],
      fields,
      groups: [],
      extension: 'OPEN',
    },
    annotations: [],
  });
  const extra = new Map<string, TypeDefinition>([
    [
      'record',
      constructorEntry([
        {
          name: 'fields',
          type: typeRefType,
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
      ]),
    ],
    [
      'array',
      constructorEntry([
        {
          name: 'element_type',
          type: typeRefType,
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
      ]),
    ],
    [
      'enum',
      constructorEntry([
        {
          name: 'members',
          type: { name: 'enum_set', arguments: [], annotations: [] },
          optional: false,
          voidable: false,
          role: 'FREE',
          annotations: [],
        },
      ]),
    ],
    [
      'enum_set',
      {
        supertypes: ['product', 'top'],
        subtypes: [],
        body: {
          kind: 'array',
          elementType: { name: 'identifier', arguments: [], annotations: [] },
          voidable: false,
          ordered: true,
          uniqueItems: false,
        },
        annotations: [],
      },
    ],
    [
      'identifier',
      {
        supertypes: ['atom', 'top'],
        subtypes: [],
        body: { kind: 'text_type', normalization: 'NONE' },
        annotations: [],
      },
    ],
  ]);
  return (name) => extra.get(name);
}

function richDeps(): SchemaResolverDeps {
  return deps({ definitionMetaReader: richMetaReader, metaDefinitions: richStructureNamespace() });
}

// ── §5.10 parameter kinds: an argument is classified by the parameter it binds ──────────────

describe('§5.10 parameter kinds, end to end through the real schemaResolver', () => {
  it(
    "the enum-member motivating case: 'e => <M> !enum { members: [a b M] }' applied as 'e<c>' " +
      "records source.arguments as a literal, not a namespace reference to a type called 'c'",
    () => {
      const doc = document('e => <M> !enum { members: [a b M] } used => e<c>');
      const schema = resolveSchema(doc, richDeps());
      expect(typeParameters(entryOf(schema, 'e'))).toEqual(['M']);
      // §8.2, §8.3: `used => e<c>` names a fully-bound application, so `used` IS the instantiation
      // entry itself -- `source` the canonical application, the substituted binding record its own
      // body, with nothing minted beside it and no `!reference` hop.
      const used = entryOf(schema, 'used');
      expect(used.source).toEqual({
        name: 'e',
        arguments: [{ kind: 'value', value: { text: 'c', form: 'UNQUOTED' } }],
        annotations: [],
      });
      expect((used.body as EnumBody).members).toEqual(['a', 'b', 'c']);
    },
  );
});

// ── §5.8's last sentence: a fully-bound application at a composition operand ────────────────

describe('§5.8 composition operand that is a fully-bound application, end to end', () => {
  it(
    '\'dog => pet<"dog", text> & { breed: text }\' subsumes the application where it stands -- ' +
      'one IS-A edge to the template itself, and no instantiation entry is minted for it',
    () => {
      const doc = document(
        'pet => <N, T> { type: text = N  pet: T } dog => pet<"dog", text> & { breed: text }',
      );
      const schema = resolveSchema(doc, richDeps());
      const dog = entryOf(schema, 'dog');
      // One IS-A edge, to the template `pet` itself -- never to a minted `pet_dog_text_...`.
      expect(dog.supertypes).toEqual(['pet']);
      const dogBody = recordBodyOf(schema, 'dog');
      // `record.supertypes` names `pet` bare too: the hand-written equivalent this sentence
      // states (`dog => pet & { type?: = "dog"  pet: text  breed: text }`) never carries the
      // application's own arguments forward, because there is no entry for them to belong to.
      expect(dogBody.supertypes).toEqual([{ name: 'pet', arguments: [], annotations: [] }]);
      // The application's own arguments are absorbed as the member's own contribution.
      expect(dogBody.fields.map((f) => f.name)).toEqual(['type', 'pet', 'breed']);
      expect(fieldTypeOf(schema, 'dog', 'type').name).toBe('text');
      expect(fieldTypeOf(schema, 'dog', 'pet').name).toBe('text');
      // §5.7 "Open modifiers": `type: text = N` in `pet`'s held body is a marker, and binds to the
      // literal "dog" the moment this operand's own parameters close with the name mark the
      // author wrote -- unmarked, so a document states `type` (§3.2 item 33).
      const typeField = dogBody.fields.find((f) => f.name === 'type');
      expect(typeField?.optional).toBe(false);
      expect(typeField?.role).toBe('FIXED');
      expect(typeField?.value).toEqual({ text: 'dog', form: 'SINGLE_LINE_QUOTED' });
      // No instantiation entry was minted for `pet<"dog", text>` -- `pet` and `dog` are the whole
      // namespace this schema produces.
      expect([...schema.entries.keys()]).toEqual(['pet', 'dog']);
    },
  );

  it(
    'an outer parameter riding through the operand ("<S> pet<S, text> & { extra: text }") ' +
      'binds the value when the enclosing template closes, leaving the name mark as the author ' +
      'wrote it (§5.7 "Open modifiers", §5.8)',
    () => {
      const doc = document(
        'pet => <N, T> { type: text = N  pet: T } ' +
          'w => <S> pet<S, text> & { extra: text } ' +
          'used => w<"dog">',
      );
      const schema = resolveSchema(doc, richDeps());
      // `w` stays open while resolving the composition operand (its own `S` is unbound): the
      // routed field's substituted value is `S` itself, and the held wire states the name mark
      // the author wrote.
      expect(heldFieldOptional(schema, 'w', 'type')).toBe(false);
      // Once `w<"dog">` itself closes, `S` becomes concrete: the field is the marker the
      // fully-bound operand reaches directly (the test above).
      const usedType = recordBodyOf(schema, 'used').fields.find((f) => f.name === 'type');
      expect(usedType?.optional).toBe(false);
      expect(usedType?.role).toBe('FIXED');
      expect(usedType?.value).toEqual({ text: 'dog', form: 'SINGLE_LINE_QUOTED' });
    },
  );

  it(
    'a removal drops an open application from the lineage a template keeps for names ' +
      '(§5.9 rule 10): `ok => <T> result<T> - { extra }` composes no IS-A edge to `result`',
    () => {
      const doc = document(
        'result => <T> { payload: T  extra: text } ok => <T> result<T> - { extra } ' +
          'used => ok<text>',
      );
      const schema = resolveSchema(doc, richDeps());
      // §5.9: subtraction breaks IS-A -- `ok` itself (still open) carries no edge to `result`.
      expect(entryOf(schema, 'ok').supertypes).toEqual([]);
      // `ok<text>`'s own instantiation carries no edge to `result` or to any instantiation of it
      // -- only #13's own self-edge to its family base, `ok` -- and its own closed
      // `record.supertypes` is empty too: rule 10's dropped open application never survived
      // substitution to close into a live edge one pass later.
      const used = entryOf(schema, 'used');
      expect(used.supertypes).toEqual(['ok']);
      const usedBody = recordBodyOf(schema, 'used');
      expect(usedBody.supertypes).toEqual([]);
      expect(usedBody.fields.map((f) => f.name)).toEqual(['payload']);
      expect([...schema.entries.keys()].some((k) => k.startsWith('result_'))).toBe(false);
    },
  );
});

// ── §8.2 synthetic merge: the two lift channels land on one entry ───────────────────────────

describe('§8.2 synthetic merge (SyntheticMerge), end to end through the real schemaResolver', () => {
  it(
    "'[box<text>]' written directly and the same sugar form closing inside a materialised " +
      'template merge onto one array entry, not two',
    () => {
      // §8.2's own two channels: `holder.items` lifts `[box<text>]` eagerly, at desugar time;
      // `carrier`'s own field `boxed: [T]` lifts the same bracket sugar to an *open* synthetic
      // while `carrier` is still a template, which closes only once `carrier<box<text>>` applies,
      // at materialisation. (This is distinct from a template *application* itself, which is
      // always its own instantiation entry, declared or not -- covered by the '§5.10 parameter
      // kinds' describe block above; the merge here is between two SUGAR lifts of `[box<text>]`,
      // one direct and one arising from substitution, not between an application and a sugar
      // form.) Both resolve to the identical array form and MUST dedupe onto one entry.
      const doc = document(
        'box => <T> { v: T } holder => { items: [box<text>] } ' +
          'carrier => <T> { boxed: [T] } used => carrier<box<text>>',
      );
      const schema = resolveSchema(doc, richDeps());
      const eagerName = fieldTypeOf(schema, 'holder', 'items').name;
      const materialisedName = fieldTypeOf(schema, 'used', 'boxed').name;
      // One array entry survives the merge, referenced from both places -- not two.
      expect(materialisedName).toBe(eagerName);
      expect(schema.entries.has(eagerName)).toBe(true);
      const form = entryOf(schema, eagerName);
      if (!isArrayBody(form.body)) throw new Error('unreachable');
      expect(form.body.elementType.arguments).toEqual([]);
      const elementTypeName = form.body.elementType.name;
      // No leftover second entry for the eager (unreduced) spelling of the same form.
      const arrayEntries = [...schema.entries.values()].filter(
        (e) => isArrayBody(e.body) && e.body.elementType.name === elementTypeName,
      );
      expect(arrayEntries).toHaveLength(1);
    },
  );
});

// ── Small internal-consistency guard ────────────────────────────────────────────────────────

describe('an internal invariant', () => {
  it('never lets a plain TsonInternalError escape as a schema verdict for these ordinary documents', () => {
    const doc = document('a => { x: text }');
    expect(() => resolveSchema(doc, deps())).not.toThrow(TsonInternalError);
  });
});
