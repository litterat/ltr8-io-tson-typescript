/**
 * The end-to-end gate for the compiler and the writers: one user schema, three schemas deep, put
 * through every stage a real caller uses -- resolve, link, compile, validate a conforming
 * document, reject a non-conforming one, and round-trip the result back out through both writer
 * entry points.
 *
 * **Three schemas deep is the point.** `catalog.tn` below declares nothing but its own five
 * types; every leaf type its fields name (`uuid`, `datetime`, `non_empty_text`, `int32`,
 * `float64`, `text`, `boolean`) comes from `!!import`ing the real, vendored `spec/m/core.tn`,
 * whose own constraint constructors (`uuid_type`, `datetime_type`, `float_type`, ...) are
 * declared in `spec/m/meta.tn`, whose kernel constructors (`integer_type`, `text_type`, `enum`,
 * `record`, `map`, `array`, `choice`) are declared in `spec/m/meta-kernel.tn`. Nothing here is
 * hand-built: the chain is the shipped one, resolved and linked by this implementation from the
 * vendored bytes (§2.2.3 for the merged namespace, §5 for constructor application).
 *
 * **The schemas are read from `spec/`, never fetched.** `compiler-schema-fixtures.ts` resolves
 * each bundled schema from the vendored file and stubs `!!meta`/`!!import` resolution to hand
 * back the already-linked namespace, since no test in this suite reaches the network.
 *
 * **Reading is asserted by value, not by absence of error.** The conforming document's whole tree
 * is compared against the values it actually carries -- a `Uuid`'s 16 bytes, a `PlainDateTime`'s
 * fields, `-12.5` as a host number, `true` as a host boolean (§9's `boolean => !enum [true
 * false]`, narrowed by `compiler/atomBuilder.ts`) -- so a reader that accepted the document while
 * losing its content would fail here.
 */
import { describe, expect, it } from 'vitest';

import { compile, read, validate, type CompiledSchema } from '../src/compiler/compile.js';
import { parseDocument } from '../src/compiler/dataParser.js';
import { TsonReadError } from '../src/core/errors.js';
import { fromBytes, runSync } from '../src/io/bytes.js';
import type { LinkedSchema } from '../src/link/link.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import { tsonDocument } from '../src/tree/nodes.js';
import { writeDocument } from '../src/write/astWriter.js';
import { writeTree, writeTreeValue } from '../src/write/treeWriter.js';
import { resolvedBundled, resolveUserSchema } from './compiler-schema-fixtures.js';

// ── The user schema, and the two documents it governs ─────────────────────────────────────────

const USER_SCHEMA = `
!!id:"test://catalog.tn"
!!meta:"https://tson.io/2026/34/m/meta.tn"
!!import:"https://tson.io/2026/34/m/core.tn"
{
  reading => {
    id: uuid
    label: non_empty_text
    recorded: datetime
    sample: sample
    tags: [text]
    limits: {text => float64}
    site: site?
  }
  site => {
    name: non_empty_text
    elevation: int32
  }
  sample => (temperature | pressure)
  temperature => { celsius: float64 }
  pressure => { kilopascals: float64  gauge: boolean }
}
`;

/** Exercises every container the compiler wires (record, array, map, choice, nested record) and an optional field that is present. */
const CONFORMING = `{
  id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
  label: "north ridge"
  recorded: "2026-08-27T09:15:00Z"
  sample: !temperature { celsius: -12.5 }
  tags: ["alpine" "hourly"]
  limits: { "low" => -40.0  "high" => 55.0 }
  site: { name: "Ridge 4" elevation: 2310 }
}`;

/** `label` violates `non_empty_text`'s `min_length: 1`; `elevation` overflows `int32`. Everything else conforms, so both problems are reachable in one collecting read. */
const NON_CONFORMING = `{
  id: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"
  label: ""
  recorded: "2026-08-27T09:15:00Z"
  sample: !temperature { celsius: 1.0 }
  tags: []
  limits: { "low" => 1.0 }
  site: { name: "Ridge 4" elevation: 99999999999 }
}`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// One resolve+link+compile for the whole file: the chain is the same schema every test reads
// against, and resolving it per test would only re-measure the fixture loader.
const linked: LinkedSchema = resolveUserSchema(USER_SCHEMA);
const compiled: CompiledSchema = compile(linked);

/**
 * The type name `typeName`'s own field `field` declares. Used instead of hard-coding the two
 * desugarer-injected names (`[text]` and `{text => float64}` are lifted to structurally-named
 * entries, §5.3/§8.2), so the expectations below assert the compiler's own output against the
 * schema rather than against a hash spelling.
 */
function fieldTypeName(typeName: string, field: string): string {
  const body = linked.entries.get(typeName)?.body;
  // `Top`'s union mixes closed literal-`kind` members with `Data`'s open `kind: string`, so a
  // plain comparison narrows nothing -- the same runtime guard `compiler/compile.ts` uses.
  const record: RecordBody | undefined =
    body !== undefined && 'kind' in body && body.kind === 'record'
      ? (body as RecordBody)
      : undefined;
  if (record === undefined) throw new Error(`'${typeName}' is not a record in the linked schema`);
  const declared = record.fields.find((candidate) => candidate.name === field);
  if (declared === undefined) throw new Error(`'${typeName}' declares no field '${field}'`);
  return declared.type.name;
}

/**
 * The type name declared at `pointer` -- an RFC 6901 pointer into the schema, as a diagnostic's
 * own `schemaPointer` carries it (`/reading/site/elevation`): the first segment names the entry,
 * each one after it names a field, and the last one's declared type is the answer.
 */
function declaredTypeAt(pointer: string): string {
  const [entry, ...fields] = pointer.split('/').filter((segment) => segment !== '');
  let typeName = entry ?? '';
  for (const field of fields) typeName = fieldTypeName(typeName, field);
  return typeName;
}

const TAGS_TYPE = fieldTypeName('reading', 'tags');
const LIMITS_TYPE = fieldTypeName('reading', 'limits');

const NO_ANNOTATIONS = { values: [] };
const atom = (value: unknown, typeRef: string): unknown => ({
  kind: 'atom',
  value,
  typeRef,
  annotations: NO_ANNOTATIONS,
});

/** The document's own values, spelled out: what `CONFORMING` carries, independently of how it was read. */
const EXPECTED_TREE = {
  kind: 'record',
  typeRef: 'reading',
  annotations: NO_ANNOTATIONS,
  fields: new Map<string, unknown>([
    [
      'id',
      atom(
        {
          bytes: new Uint8Array([
            0xf8, 0x1d, 0x4f, 0xae, 0x7d, 0xec, 0x11, 0xd0, 0xa7, 0x65, 0x00, 0xa0, 0xc9, 0x1e,
            0x6b, 0xf6,
          ]),
        },
        'uuid',
      ),
    ],
    ['label', atom('north ridge', 'non_empty_text')],
    [
      'recorded',
      atom(
        {
          date: { year: 2026, month: 8, day: 27 },
          time: { hour: 9, minute: 15, second: 0, nanosecond: 0, offset: { totalMinutes: 0 } },
        },
        'datetime',
      ),
    ],
    [
      'sample',
      {
        kind: 'record',
        typeRef: 'temperature',
        annotations: NO_ANNOTATIONS,
        fields: new Map<string, unknown>([['celsius', atom(-12.5, 'float64')]]),
      },
    ],
    [
      'tags',
      {
        kind: 'array',
        typeRef: TAGS_TYPE,
        annotations: NO_ANNOTATIONS,
        elements: [atom('alpine', 'text'), atom('hourly', 'text')],
      },
    ],
    [
      'limits',
      {
        kind: 'map',
        typeRef: LIMITS_TYPE,
        annotations: NO_ANNOTATIONS,
        entries: [
          { key: atom('low', 'text'), value: atom(-40, 'float64') },
          { key: atom('high', 'text'), value: atom(55, 'float64') },
        ],
      },
    ],
    [
      'site',
      {
        kind: 'record',
        typeRef: 'site',
        annotations: NO_ANNOTATIONS,
        fields: new Map<string, unknown>([
          ['name', atom('Ridge 4', 'non_empty_text')],
          ['elevation', atom(2310, 'int32')],
        ]),
      },
    ],
  ]),
};

// ── 1. The chain ─────────────────────────────────────────────────────────────────────────────

describe('the governing chain is three schemas deep', () => {
  it('links the user schema over core.tn, which is governed by meta.tn, which is governed by meta-kernel.tn', () => {
    const core = resolvedBundled('core');
    const meta = resolvedBundled('meta');
    const kernel = resolvedBundled('meta-kernel');

    expect(linked.imports).toEqual([core.id.split('?')[0]]);
    expect(linked.meta).toBe(meta.id.split('?')[0]);
    expect(core.meta).toBe(meta.id);
    expect(meta.imports).toEqual([kernel.id]);
    expect(meta.meta).toBe(kernel.id);
    expect(kernel.meta).toBe(kernel.id.split('?')[0]); // the one deliberate circularity (§2.2)
  });

  it("merges core.tn's whole namespace into the user schema's own (§2.2.3), origins recorded per entry", () => {
    const core = resolvedBundled('core');
    for (const name of core.entries.keys()) {
      expect(linked.entries.has(name)).toBe(true);
      expect(linked.origins.get(name)).toBe(core.id);
    }
    expect(linked.origins.get('reading')).toBe('catalog.tn'); // §2.2.1's canonical identity
  });

  it('resolves a core type through a constructor two schemas further down', () => {
    // core.tn spells `int32 => !integer ^ { size: { bits: 32  signed: true } }`, a refinement of
    // its own `integer => !integer_type {}`, whose constructor is meta-kernel.tn's `integer_type`.
    expect(linked.entries.get('int32')).toMatchObject({
      kind: 'ATOM',
      supertypes: ['integer'],
      body: { kind: 'integer_type', size: { bits: 32n, signed: true } },
    });
    // `boolean => !enum [true false]` -- the kernel's `enum` constructor, applied in core.
    expect(linked.entries.get('boolean')).toMatchObject({
      body: { kind: 'enum', members: ['true', 'false'] },
    });
    // The two layers the constructors actually come from: `integer_type` and `enum` are the
    // kernel's, `uuid_type` and `datetime_type` are meta's, and the document below is validated
    // by all of them at once.
    const meta = resolvedBundled('meta');
    const kernel = resolvedBundled('meta-kernel');
    expect(linked.entries.get('uuid')).toMatchObject({ source: { name: 'uuid_type' } });
    expect(linked.entries.get('datetime')).toMatchObject({ source: { name: 'datetime_type' } });
    for (const constructorName of ['uuid_type', 'datetime_type', 'float_type']) {
      expect(meta.entries.has(constructorName)).toBe(true);
      expect(kernel.entries.has(constructorName)).toBe(false);
    }
    for (const constructorName of ['integer_type', 'text_type', 'enum', 'record', 'choice']) {
      expect(kernel.entries.has(constructorName)).toBe(true);
    }
  });

  it('compiles a reader for every type the user schema names, its imported ones included', () => {
    for (const name of ['reading', 'site', 'sample', 'temperature', 'pressure']) {
      expect(compiled.reader(name)).toBeDefined();
    }
    for (const name of ['uuid', 'datetime', 'non_empty_text', 'int32', 'float64', 'boolean']) {
      expect(compiled.reader(name)).toBeDefined();
    }
  });
});

// ── 2. The conforming document ───────────────────────────────────────────────────────────────

describe('a conforming document', () => {
  it('validates with no diagnostics, producing the values the document carries', () => {
    const result = validate(compiled, 'reading', bytes(CONFORMING));
    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual(EXPECTED_TREE);
  });

  it('reads identically through the fail-fast entry point', () => {
    expect(read(compiled, 'reading', bytes(CONFORMING))).toEqual(EXPECTED_TREE);
  });

  it('leaves an absent optional field out of the tree rather than filling it in', () => {
    const withoutSite = CONFORMING.replace(/\n {2}site: \{[^}]*\}/u, '');
    const result = validate(compiled, 'reading', bytes(withoutSite));
    expect(result.diagnostics).toEqual([]);
    const root = result.value;
    if (root.kind !== 'record') throw new Error(`expected a record, found '${root.kind}'`);
    expect(root.fields.has('site')).toBe(false);
    expect([...root.fields.keys()]).toEqual([
      'id',
      'label',
      'recorded',
      'sample',
      'tags',
      'limits',
    ]);
  });
});

// ── 3. The non-conforming document ───────────────────────────────────────────────────────────

describe('a non-conforming document is rejected with a located, named diagnostic', () => {
  it('names the field, the position, the constraint and the value, for every violation in one read', () => {
    const result = validate(compiled, 'reading', bytes(NON_CONFORMING));
    expect(result.diagnostics).toEqual([
      {
        code: 'ATOM_CONSTRAINT_VIOLATION',
        message: "'' is 0 characters, less than the minimum 1",
        path: '/label',
        schemaId: 'catalog.tn',
        schemaPointer: '/reading/label',
        expected: 'at least 1 characters',
        actual: '',
        dataPosition: { line: 3, column: 10, offset: 56 },
      },
      {
        code: 'ATOM_CONSTRAINT_VIOLATION',
        message:
          "'99999999999' is out of range for a signed 32-bit integer [-2147483648, 2147483647]",
        path: '/site/elevation',
        schemaId: 'catalog.tn',
        schemaPointer: '/reading/site/elevation',
        expected: '>= -2147483648 and <= 2147483647',
        actual: '99999999999',
        dataPosition: { line: 8, column: 38, offset: 209 },
      },
    ]);
  });

  it("locates the violated type through the diagnostic's own schema pointer", () => {
    // The diagnostic carries the constraint in prose but not the declared type's *name*; the name
    // is reached through `schemaPointer`, which points at the field declaration that names it.
    const result = validate(compiled, 'reading', bytes(NON_CONFORMING));
    const violated = result.diagnostics.map((diagnostic) =>
      declaredTypeAt(diagnostic.schemaPointer ?? ''),
    );
    expect(violated).toEqual(['non_empty_text', 'int32']);
  });

  it('rejects a value whose shape is not the declared container, naming both sides', () => {
    const result = validate(
      compiled,
      'reading',
      bytes(CONFORMING.replace('tags: ["alpine" "hourly"]', 'tags: "alpine"')),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'TYPE_MISMATCH',
      path: '/tags',
      expected: 'an array',
      actual: "token 'alpine'",
      message: `expected an array for '${TAGS_TYPE}', found token 'alpine'`,
    });
    expect(result.diagnostics[0]?.dataPosition).toEqual({ line: 6, column: 9, offset: 155 });
  });

  it('rejects a choice variant the schema does not declare, naming the members it does', () => {
    const result = validate(
      compiled,
      'reading',
      bytes(CONFORMING.replace('!temperature', '!humidity')),
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'UNKNOWN_TYPE_REF',
      message: "'!humidity' names no member of 'sample' (temperature | pressure)",
      path: '/sample',
      schemaPointer: '/reading/sample',
      expected: 'one of (temperature | pressure)',
      actual: '!humidity',
    });
    expect(result.diagnostics[0]?.dataPosition).toBeDefined();
  });

  it('reports a missing required field and an undeclared one, naming each (§7.2)', () => {
    const result = validate(
      compiled,
      'reading',
      bytes(CONFORMING.replace(/\n {2}recorded: "[^"]*"/u, '\n  colour: "red"')),
    );
    expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path])).toEqual([
      ['UNRECOGNIZED_FIELD', '/colour'],
      ['FIELD_REQUIRED', '/recorded'],
    ]);
    expect(result.diagnostics[0]?.message).toContain("unknown field 'colour' on 'reading'");
    expect(result.diagnostics[1]?.message).toBe("missing required field 'recorded' for 'reading'");
  });

  it('throws through the fail-fast entry point, carrying the whole diagnostic', () => {
    let thrown: unknown;
    try {
      read(compiled, 'reading', bytes(NON_CONFORMING));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TsonReadError);
    const error = thrown as TsonReadError;
    expect(error.diagnostic).toMatchObject({
      code: 'ATOM_CONSTRAINT_VIOLATION',
      path: '/label',
      schemaPointer: '/reading/label',
    });
    expect(error.toString()).toContain('3:10'); // line:column, from the diagnostic's own position
  });
});

// ── 4. Round trip ────────────────────────────────────────────────────────────────────────────

describe('round trip: parse, write, parse, compare', () => {
  const first = validate(compiled, 'reading', bytes(CONFORMING));

  it('the tree writer round-trips the whole value, schema-validating on the way back in', () => {
    const written = writeTreeValue(first.value);
    const second = validate(compiled, 'reading', bytes(written));
    expect(second.diagnostics).toEqual([]);
    expect(second.value).toEqual(first.value);
    expect(second.value).toEqual(EXPECTED_TREE);
  });

  it('the tree writer is idempotent: writing the re-read value gives the identical text', () => {
    const written = writeTreeValue(first.value);
    const rewritten = writeTreeValue(validate(compiled, 'reading', bytes(written)).value);
    expect(rewritten).toBe(written);
  });

  it('has one spelling: the document form is the header plus exactly the value form', () => {
    // `write/index.ts`'s own contract -- canonical and readable are the same call, so there is no
    // second entry point here whose whitespace could differ from this one's.
    const document = tsonDocument(first.value, 'test://reading-1', 'test://catalog.tn');
    expect(writeTree(document)).toBe(
      `!!id:"test://reading-1"\n!!schema:"test://catalog.tn"\n${writeTreeValue(first.value)}`,
    );
  });

  it('a written document keeps its header readable and its value equal on re-read', () => {
    const document = tsonDocument(first.value, 'test://reading-1', 'test://catalog.tn');
    const text = writeTree(document);
    const reparsed = runSync(parseDocument(fromBytes(bytes(text))));
    expect(reparsed.document.id).toBe('test://reading-1');
    expect(reparsed.document.schema).toBe('test://catalog.tn');
    const back = validate(compiled, 'reading', bytes(text));
    expect(back.diagnostics).toEqual([]);
    expect(back.value).toEqual(EXPECTED_TREE);
  });

  it('the AST writer round-trips the parsed document, and its output re-reads to the same tree', () => {
    const parsed = runSync(parseDocument(fromBytes(bytes(CONFORMING))));
    const written = writeDocument(parsed.document);
    const reparsed = runSync(parseDocument(fromBytes(bytes(written))));
    expect(reparsed.document).toEqual(parsed.document);
    expect(writeDocument(reparsed.document)).toBe(written); // byte-stable from the first write on
    const back = validate(compiled, 'reading', bytes(written));
    expect(back.diagnostics).toEqual([]);
    expect(back.value).toEqual(EXPECTED_TREE);
  });

  it('keeps the two writers distinct: the AST writer preserves the source spelling, the tree writer normalises it', () => {
    const parsed = runSync(parseDocument(fromBytes(bytes(CONFORMING))));
    const astText = writeDocument(parsed.document);
    const treeText = writeTreeValue(first.value);
    // The parse-preserving writer keeps what the author wrote: no type-refs the source did not
    // spell, and none of the schema's own names.
    expect(astText).not.toContain('!uuid');
    expect(astText).toContain('!temperature'); // the one type-ref the source itself carries
    // The value-preserving writer states every resolved type-ref, since a tree node carries one.
    expect(treeText).toContain('!uuid');
    expect(treeText).toContain('!int32');
    expect(treeText.startsWith('!reading ')).toBe(true);
  });
});

// ── 5. What this gate does not close ─────────────────────────────────────────────────────────

/**
 * Two behaviours the run above reaches but does not validate, pinned here as assertions rather
 * than left unsaid, so each one can only shrink.
 */
// ── §7.2 subsumption: a value's own type-ref must be admitted by the position it stands in ────

describe("§7.2's subsumption rule: a data type-ref at a typed position is verified, not skipped", () => {
  it('reports UNKNOWN_TYPE_REF for a wrong type-ref, and for one naming no type at all', () => {
    // §7.2: "At a position whose declared type is `T`, a value annotated `!S` is valid if and only
    // if [...] `S` is `T` or `T` appears in `S`'s transitive supertypes." `reading` has no
    // subtypes in this schema, so both `!site` (a real entry, but not one `reading` admits) and
    // `!nonsense` (naming nothing at all) are refused with the "has no subtypes" wording
    // (`compiler/subsumption.ts`).
    const wrongType = validate(compiled, 'reading', bytes(CONFORMING.replace('{', '!site {')));
    expect(wrongType.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(wrongType.diagnostics[0]?.message).toContain(
      "'!site' is not valid at a 'reading' position",
    );

    const noSuchType = validate(compiled, 'reading', bytes(CONFORMING.replace('{', '!nonsense {')));
    expect(noSuchType.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(noSuchType.diagnostics[0]?.message).toContain(
      "'!nonsense' is not valid at a 'reading' position",
    );
  });

  it("still admits the position's own type stated explicitly, and a choice's own variant tag", () => {
    // `sample: !temperature { celsius: -12.5 }` in `CONFORMING` already exercises a choice's own
    // dispatch surviving this guard (choices are excluded from it by name); this covers the other
    // two admitted shapes at the record root itself.
    const ownType = validate(compiled, 'reading', bytes(CONFORMING.replace('{', '!reading {')));
    expect(ownType.diagnostics).toEqual([]);
  });
});

describe('gaps this gate leaves open', () => {
  it('locates a root-level atom problem in the data but not in the schema', () => {
    // `compile.ts` hands `buildAtomReader` no `SchemaLocation`, so an atom anchors none of its
    // own on the *schema* side: inside a record it inherits the record's (asserted above --
    // `/reading/label` and friends), but read as the document root it has no enclosing anchor to
    // inherit and the diagnostic carries no `schemaId`/`schemaPointer` at all. The *data* side is
    // different: the root value is what failed, so `path` is `''` -- the root's own RFC 6901
    // pointer, and a real location, not an absence (`core/diagnostic.ts`'s own doc on why `path`
    // and `schemaPointer` read an empty string oppositely).
    const result = validate(compiled, 'int32', bytes('99999999999'));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'ATOM_CONSTRAINT_VIOLATION',
      expected: '>= -2147483648 and <= 2147483647',
      actual: '99999999999',
      dataPosition: { line: 1, column: 1, offset: 0 },
      path: '',
    });
    expect(result.diagnostics[0]?.schemaId).toBeUndefined();
    expect(result.diagnostics[0]?.schemaPointer).toBeUndefined();
  });
});
