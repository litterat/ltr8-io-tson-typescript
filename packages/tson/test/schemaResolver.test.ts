import { describe, expect, it } from 'vitest';

import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { collector } from '../src/core/diagnostic.js';
import {
  TsonBindMismatchError,
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaFetchError,
  TsonLimitRefusedError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import {
  resolveSchema,
  type ImportedSchema,
  type Schema,
  type SchemaResolverDeps,
} from '../src/compiler/schemaResolver.js';
import { bootstrapKernel } from '../src/schema/bootstrap.js';
import { linkSchema, type LinkedSchema } from '../src/link/link.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { META_TN } from '../src/stdlib/schemas.generated.js';
import { toCoreValue } from '../src/bind/encode.js';
import { defaultAtomEncoder } from '../src/write/bindingWriter.js';
import { topBinding } from '../src/schema/bindings.js';
import { createDefinitionMetaReader } from '../src/schema/metaReader.js';
import { createDefinitionValueReader } from '../src/schema/namespaceReader.js';
import type { SchemaDocument } from '../src/ast/schema/document.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import { fieldMapOf, namedField } from '../src/schema/meta/bodies.js';
import type { Top, TypeExpr, TypeRef } from '../src/schema/meta/typedef.js';
import type { DataValue } from '../src/ast/value.js';
import {
  applicationOf,
  parentsOf,
  supertypesOf,
  typeParameters,
} from '../src/schema/meta/typedef.js';

// ── Parsing helper ───────────────────────────────────────────────────────────────────────────

function parse(header: string, declarations: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(`${header} !schema { ${declarations} }`)));
}

/** The common case: one meta, no imports, `!!id` present -- every declaration text is the caller's own. */
function document(declarations: string, id = 'https://example.com/s.tn'): SchemaDocument {
  return parse(`!!id:"${id}" !!import:"${KERNEL_URI}"`, declarations);
}

// ── Real readers over the real kernel ───────────────────────────────────────────────────────────
//
// Every test here drives `resolveSchema` with the readers the library itself uses and the real,
// pre-loaded kernel as its one import: what a constructor application binds to, and what an
// application's argument is read as, are the kernel's to say (§4.1, §5.10), so a stand-in reader
// would only test itself.

const KERNEL_URI = 'https://tson.io/2026/40/m/meta.tn';

const kernel = linkSchema(bootstrapKernel(encodeUtf8(META_TN)));

/** `linked` as one of the schemas another imports. */
function importedFrom(linked: LinkedSchema): ImportedSchema {
  return {
    entries: linked.entries,
    facts: linked.facts,
    keyAnnotations: linked.keyAnnotations,
    originOf: (entry) => linked.origins.get(entry) ?? linked.id,
    enumForms: linked.enumForms,
    nameTypes: linked.nameTypes,
  };
}

function deps(overrides: Partial<SchemaResolverDeps> = {}): SchemaResolverDeps {
  return {
    readers:
      overrides.readers ??
      ((lookup) => ({
        meta: createDefinitionMetaReader(lookup),
        value: createDefinitionValueReader(lookup),
      })),
    encodeSourceBody:
      overrides.encodeSourceBody ?? ((body) => toCoreValue(topBinding, body, defaultAtomEncoder)),
    resolveImport: overrides.resolveImport ?? (() => importedFrom(kernel)),
  };
}

/** The real readers over the real kernel -- what every sugar/template test in this file needs. */
function depsWithReader(): SchemaResolverDeps {
  return deps();
}

function richDeps(): SchemaResolverDeps {
  return deps();
}

function isRecordBody(body: Top): body is RecordBody {
  return body.kind === 'record';
}

function entryOf(schema: Schema, name: string): Top {
  const entry = schema.entries.get(name);
  if (entry === undefined) throw new Error(`resolved schema has no entry '${name}'`);
  return entry;
}

function recordBodyOf(schema: Schema, name: string): RecordBody {
  const body = entryOf(schema, name);
  if (!isRecordBody(body)) throw new Error(`'${name}' is not record-shaped`);
  return body;
}

function fieldNamesOf(body: RecordBody): string[] {
  return [...body.fields.entries.keys()];
}

function fieldExprOf(schema: Schema, name: string, field: string): TypeExpr {
  const found = namedField(recordBodyOf(schema, name), field);
  if (found === undefined) throw new Error(`'${name}' has no field '${field}'`);
  return found.type;
}

function fieldTypeOf(schema: Schema, name: string, field: string): TypeRef {
  const type = fieldExprOf(schema, name, field);
  if (type.kind === 'inline') throw new Error(`'${name}.${field}' is typed by a type in place`);
  return type;
}

// ── !!id / header handling ───────────────────────────────────────────────────────────────────

describe('!!id and header handling', () => {
  it('throws TsonSchemaValidationError when !!id is absent', () => {
    const doc = parse('', 'x => { v: text }');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('carries !!id/!!import straight through to the result', () => {
    const doc = parse(
      '!!id:"https://example.com/s.tn" ' + '!!import:"https://example.com/i.tn"',
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
    expect(fieldNamesOf(child).sort()).toEqual(['x', 'y']);
    expect(supertypesOf(child)).toEqual(['parent']);
  });

  it('resolves every declaration exactly once, however many others depend on it', () => {
    const doc = document('a => base & {} b => base & {} base => { x: text }');
    const schema = resolveSchema(doc, deps());
    expect(schema.entries.size).toBe(3);
    expect(supertypesOf(recordBodyOf(schema, 'a'))).toEqual(['base']);
    expect(supertypesOf(recordBodyOf(schema, 'b'))).toEqual(['base']);
  });

  it('rejects a wait cycle, naming the entries on it in wait order (§3.4.1)', () => {
    const doc = document('a => b & {} b => a & {}');
    expect(() => resolveSchema(doc, deps())).toThrow(/'a' waits on 'b' waits on 'a'/);
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });

  it('refuses a chain of waits past max_wait_depth at its head, in any declaration order (§11.5)', () => {
    // e waits on d waits on c waits on b waits on a: four waits from the head.
    const forward = document('a => {} b => a & {} c => b & {} d => c & {} e => d & {}');
    const backward = document('e => d & {} d => c & {} c => b & {} b => a & {} a => {}');
    for (const doc of [forward, backward]) {
      expect(() => resolveSchema(doc, { ...deps(), maxWaitDepth: 3 })).toThrow(
        TsonLimitRefusedError,
      );
      expect(() => resolveSchema(doc, { ...deps(), maxWaitDepth: 4 })).not.toThrow();
    }
  });

  it('rejects a composition supertype naming nothing this schema declares', () => {
    const doc = document('a => nowhere & {}');
    expect(() => resolveSchema(doc, deps())).toThrow(TsonSchemaValidationError);
  });
});

// ── !!import merging ─────────────────────────────────────────────────────────────────────────

describe('!!import merging into the type-name namespace', () => {
  it('lets a local declaration compose with an imported one', () => {
    const imported = new Map<string, Top>([
      ['base', { kind: 'record', fields: fieldMapOf([]), groups: [], extension: 'OPEN' }],
    ]);
    const doc = parse(
      '!!id:"https://example.com/s.tn" ' + '!!import:"https://example.com/i.tn"',
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
    expect(supertypesOf(recordBodyOf(schema, 'child'))).toEqual(['base']);
    // Imported entries are visible during resolution but never part of the local-only result.
    expect(schema.entries.has('base')).toBe(false);
  });

  it('rejects a local declaration colliding with an imported name', () => {
    const imported = new Map<string, Top>([
      ['base', { kind: 'record', fields: fieldMapOf([]), groups: [], extension: 'OPEN' }],
    ]);
    const doc = parse(
      '!!id:"https://example.com/s.tn" ' + '!!import:"https://example.com/i.tn"',
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
      '!!id:"https://example.com/s.tn" ' + '!!import:"https://example.com/i.tn"',
      'x => { v: text }',
    );
    const { resolveImport: _loader, ...noLoader } = deps();
    void _loader;
    expect(() => resolveSchema(doc, noLoader)).toThrow(TsonNotImplementedError);
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
    expect(fieldNamesOf(recordBodyOf(schema, 'good'))).toEqual(['x']);
    // `bad` is present as an absorbing placeholder, not missing.
    expect(schema.entries.has('bad')).toBe(true);
    expect(fieldNamesOf(recordBodyOf(schema, 'bad'))).toEqual([]);
  });
});

// ── Positive classification: every reportable failure gets its own code, nothing falls to a
//    catch-all, and an error none of the four categories claims still propagates as itself ─────

describe('positive classification of a failed declaration', () => {
  /** The real readers, with `meta` replaced: what a constructor application's payload is bound through. */
  function depsWithMeta(meta: (type: string, value: DataValue) => Top): SchemaResolverDeps {
    return deps({
      readers: (lookup) => ({ meta, value: createDefinitionValueReader(lookup) }),
    });
  }

  /** The real readers, with `value` replaced: what a value entry's payload is read through. */
  function depsWithValue(value: (type: string, payload: DataValue) => never): SchemaResolverDeps {
    return deps({
      readers: (lookup) => ({ meta: createDefinitionMetaReader(lookup), value }),
    });
  }

  it("reports BIND_MISMATCH for a TsonBindMismatchError the meta reader throws while binding '!ctor { }'", () => {
    const doc = document('bad => !meta.record { }  good => { x: text }');
    const receiver = collector();
    const schema = resolveSchema(
      doc,
      depsWithMeta(() => {
        throw new TsonBindMismatchError("bound class disagrees with 'record'");
      }),
      { receiver },
    );
    expect(receiver.diagnostics).toHaveLength(1);
    expect(receiver.diagnostics[0]?.code).toBe('BIND_MISMATCH');
    expect(receiver.diagnostics[0]?.schemaPointer).toBe('/bad');
    expect(fieldNamesOf(recordBodyOf(schema, 'good'))).toEqual(['x']);
  });

  it('reports the code belonging to the fetch reason for a TsonSchemaFetchError a value read throws', () => {
    // Injected through the value reader rather than the meta reader: the latter's own caller
    // (`definitionResolver.ts`'s `bindAtomInstance`) already folds an unrecognised error from that
    // particular seam into `TsonNotImplementedError`, so a fetch failure can only reach this
    // resolver's own classifier unwrapped through the value reader, as a reader backed by a real
    // schema loader would raise one.
    const doc = document('thing => { x: text }  bad => !thing { x: abc }  good => { x: text }');
    const receiver = collector();
    const schema = resolveSchema(
      doc,
      depsWithValue(() => {
        throw new TsonSchemaFetchError(
          'https://example.com/unreachable.tn',
          'not-permitted',
          'no configured source would supply this schema',
        );
      }),
      { receiver },
    );
    expect(receiver.diagnostics).toHaveLength(1);
    expect(receiver.diagnostics[0]?.code).toBe('SCHEMA_NOT_PERMITTED');
    expect(receiver.diagnostics[0]?.schemaPointer).toBe('/bad');
    expect(fieldNamesOf(recordBodyOf(schema, 'good'))).toEqual(['x']);
  });

  it('rethrows a BIND_MISMATCH-worthy error unchanged when there is no receiver (fail-fast)', () => {
    const doc = document('bad => !meta.record { }');
    expect(() =>
      resolveSchema(
        doc,
        depsWithMeta(() => {
          throw new TsonBindMismatchError('mismatch');
        }),
      ),
    ).toThrow(TsonBindMismatchError);
  });

  it('never classifies an unrecognised error as a verdict -- it propagates as itself, not SCHEMA_ERROR', () => {
    // A value reader throwing a library fault is not any of the four reportable categories --
    // injected here rather than through the meta reader, since `definitionResolver.ts`'s own
    // `bindAtomInstance` already folds an unrecognised error from *that* seam into
    // `TsonNotImplementedError` (a deliberate, lower-level classification this test is not the
    // one to re-cover).
    const doc = document('thing => { x: text }  bad => !thing { x: abc }');
    const receiver = collector();
    expect(() =>
      resolveSchema(
        doc,
        depsWithValue(() => {
          throw new TsonInternalError('a bug in this reader, not a document problem');
        }),
        { receiver },
      ),
    ).toThrow(TsonInternalError);
    // Nothing was reported -- the fault propagated instead of being laundered into a diagnostic.
    expect(receiver.diagnostics).toHaveLength(0);
  });
});

// ── §5.3 sugar lift and the @synthetic key marker (§8.2) ────────────────────────────────────────

describe('a sugar form stays where it is written (§4.2, §5.3)', () => {
  it('holds [text] at the field in place, lifting no entry and marking no key', () => {
    const doc = document('wrapper => { v: [text] }');
    const schema = resolveSchema(doc, depsWithReader());
    expect([...schema.entries.keys()]).toEqual(['wrapper']);
    const fieldType = fieldExprOf(schema, 'wrapper', 'v');
    expect(fieldType.kind === 'inline' && fieldType.head).toBe('meta.array');
    expect(
      fieldType.kind === 'inline' && fieldType.of.kind === 'array' && fieldType.of.elementType,
    ).toEqual({
      name: 'text',
      annotations: [],
    });
    expect(schema.keyAnnotations.has('wrapper')).toBe(false);
  });
});

// ── §5.10 parametric records and their applications ─────────────────────────────────────────

describe('parametric records and their applications (§5.10), end to end', () => {
  it('closes text_box => box<text> to the substituted record under the declared name (§5.10, §8.2)', () => {
    const doc = document('box => <T> { v: T } text_box => box<text>');
    const schema = resolveSchema(doc, depsWithReader());
    // `box` itself stays a parametric record, carrying its parameter list.
    expect(typeParameters(entryOf(schema, 'box'))).toEqual(['T']);
    // §8.2: a declared application is the substituted record itself, carrying the application as its key's
    // `@meta.application`, with nothing minted beside it and no alias hop.
    const text_box = entryOf(schema, 'text_box');
    expect(isRecordBody(text_box)).toBe(true);
    expect(applicationOf(schema.keyAnnotations.get('text_box'))).toEqual({
      kind: 'apply',
      head: { name: 'box', annotations: [] },
      arguments: [{ name: 'text', annotations: [] }],
    });
    expect(fieldTypeOf(schema, 'text_box', 'v').name).toBe('text');
  });

  it('closes a composition supertype that is a closed generic application on demand, during resolution', () => {
    const doc = document('box => <T> { v: T } wrapped => box<text> & { w: text }');
    const schema = resolveSchema(doc, depsWithReader());
    const wrapped = recordBodyOf(schema, 'wrapped');
    // Absorbed box<text>'s own field (v: text) plus wrapped's own (w: text).
    expect(fieldNamesOf(wrapped).sort()).toEqual(['v', 'w']);
  });

  it('rejects head abstraction -- a type parameter applied to arguments (§5.10)', () => {
    const doc = document('bad => <T> { v: T<text> }');
    expect(() => resolveSchema(doc, richDeps())).toThrow(TsonSchemaValidationError);
  });

  it("a parametric record states the extension its author wrote, each application's own (§5.10, §8.1)", () => {
    const doc = document('box => <T> { v: T }');
    const schema = resolveSchema(doc, depsWithReader());
    const box = entryOf(schema, 'box');
    expect(typeParameters(box)).toEqual(['T']);
    // OPEN where the author wrote no mark (§5.10).
    expect((box as { readonly extension?: string }).extension).toBe('OPEN');
    // The list is present only where a selector survives erasure of the parameters, so a base
    // with none is tag-dispatched (§5.10).
    expect((box as { readonly discriminators?: readonly string[] }).discriminators).toBeUndefined();
  });

  it("an author-written 'abstract' on a parametric record travels to every application (§5.10)", () => {
    const doc = document('outcome => abstract <T> { code: T } outcome_of => outcome<text>');
    const schema = resolveSchema(doc, depsWithReader());
    // The parametric record states the mark its author wrote.
    expect((entryOf(schema, 'outcome') as { readonly extension?: string }).extension).toBe(
      'ABSTRACT',
    );
    // §8.2: `outcome_of` is the instantiation entry itself (no minted twin) -- and the `abstract`
    // the author wrote on `outcome` is each application's, so this *closed* record's own
    // `extension` states it too, distinct from the template's own derived fact just above.
    const outcomeOf = entryOf(schema, 'outcome_of');
    expect(isRecordBody(outcomeOf) && outcomeOf.extension).toBe('ABSTRACT');
  });

  it("'final' on a parametric record is refused -- it is applied to be composed (§5.10)", () => {
    const doc = document('sneaky => final <T> { v: T }');
    expect(() => resolveSchema(doc, depsWithReader())).toThrow(TsonSchemaValidationError);
  });

  it('a selector whose declared type mentions a type parameter is refused (§5.10)', () => {
    const doc = document('bad => <T> { sel: T =? }');
    expect(() => resolveSchema(doc, depsWithReader())).toThrow(TsonSchemaValidationError);
  });
});

// ── §5.10: a parametric record's body is a record body ──────────────────────────────────────

describe('a parameter list stands before a record body alone (§5.10)', () => {
  it("'e => <M> !enum { members: [a b M] }' is refused: there are no parametric enums, and an argument is a type", () => {
    const doc = document('e => <M> !enum { members: [a b M] }');
    expect(() => resolveSchema(doc, richDeps())).toThrow(TsonSchemaValidationError);
  });
});

// ── §5.8's last sentence: a fully-bound application at a composition operand ────────────────

describe('§5.8 composition operand that is a fully-bound application, end to end', () => {
  it("'dog => pet<text> & { breed: text }' absorbs the application where it stands, minting no entry for it", () => {
    const doc = document('pet => <T> { pet: T } dog => pet<text> & { breed: text }');
    const schema = resolveSchema(doc, richDeps());
    const dogBody = recordBodyOf(schema, 'dog');
    // A closed record keeps no written parents.
    expect(parentsOf(dogBody)).toEqual([]);
    // The application's substituted fields are absorbed as the record's own.
    expect(fieldNamesOf(dogBody)).toEqual(['pet', 'breed']);
    expect(fieldTypeOf(schema, 'dog', 'pet').name).toBe('text');
    expect([...schema.entries.keys()]).toEqual(['pet', 'dog']);
  });

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
      expect(supertypesOf(entryOf(schema, 'ok'))).toEqual([]);
      expect(parentsOf(entryOf(schema, 'ok'))).toEqual([]);
      // `ok<text>`'s own instantiation carries no edge to `result` or to any instantiation of it,
      // and none to `ok` either: no application is IS-A its head (§5.10).
      const used = entryOf(schema, 'used');
      expect(supertypesOf(used)).toEqual([]);
      expect(fieldNamesOf(recordBodyOf(schema, 'used'))).toEqual(['payload']);
      expect([...schema.entries.keys()].some((k) => k.startsWith('result_'))).toBe(false);
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
