import { describe, expect, it } from 'vitest';

import { TsonParseError } from '../src/core/errors.js';
import { fromString, runSync } from '../src/io/bytes.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import type { SchemaDocument } from '../src/ast/schema/document.js';
import type { TypeDef } from '../src/ast/schema/typedef.js';

/** Parses a complete schema document over already-complete input. */
function parse(text: string): SchemaDocument {
  return runSync(parseSchemaDocument(fromString(text)));
}

function thrownBy(text: string): unknown {
  try {
    parse(text);
  } catch (e) {
    return e;
  }
  throw new Error(`expected parsing '${text}' to throw, but it completed`);
}

const META = '!!meta:"https://example.com/m.tn1"';

/** Wraps `body` as a declaration's type-def and returns just that `TypeDef`. */
function typeDefOf(body: string): TypeDef {
  const doc = parse(`${META} { x => ${body} }`);
  const decl = doc.body.declarations.get('x');
  if (decl === undefined) throw new Error('declaration x missing');
  return decl.typeDef;
}

// ── Document header (§2.1, §2.2) ────────────────────────────────────────

describe('schema document header (§2.2)', () => {
  it('parses !!meta alone', () => {
    const doc = parse(`${META} { x => uuid }`);
    expect(doc.id).toBeUndefined();
    expect(doc.meta).toBe('https://example.com/m.tn1');
    expect(doc.imports).toEqual([]);
  });

  it('parses !!id, !!meta, and repeated !!import in order', () => {
    const doc = parse(
      `!!id:"https://example.com/task.tn" ${META} ` +
        `!!import:"https://example.com/a.tn" !!import:"https://example.com/b.tn" ` +
        `{ x => uuid }`,
    );
    expect(doc.id).toBe('https://example.com/task.tn');
    expect(doc.meta).toBe('https://example.com/m.tn1');
    expect(doc.imports).toEqual(['https://example.com/a.tn', 'https://example.com/b.tn']);
  });

  it('rejects a document with no !!meta at all', () => {
    expect(thrownBy('{ x => uuid }')).toBeInstanceOf(TsonParseError);
  });

  it('rejects !!meta not immediately after !!id', () => {
    expect(
      thrownBy(
        `!!id:"https://example.com/a.tn" !!import:"https://example.com/b.tn" ${META} { x => uuid }`,
      ),
    ).toBeInstanceOf(TsonParseError);
  });

  it('rejects a directive after !!import that is neither another !!import nor the schema map', () => {
    expect(thrownBy(`${META} !!schema:"https://example.com/s.tn" { x => uuid }`)).toBeInstanceOf(
      TsonParseError,
    );
  });

  it('rejects unexpected content after the schema map', () => {
    expect(thrownBy(`${META} { x => uuid } garbage`)).toBeInstanceOf(TsonParseError);
  });
});

// ── Schema map (§2.1) ────────────────────────────────────────────────────

describe('schema map (§2.1, §12.1)', () => {
  it('rejects an empty schema map', () => {
    expect(thrownBy(`${META} {}`)).toBeInstanceOf(TsonParseError);
  });

  it('preserves declaration insertion order and a later duplicate name overwrites the earlier entry', () => {
    const doc = parse(`${META} { a => uuid  b => text  a => text }`);
    expect([...doc.body.declarations.keys()]).toEqual(['a', 'b']);
    expect(doc.body.declarations.get('a')?.typeDef).toEqual({
      kind: 'referenceTypeDef',
      typeParams: [],
      ref: { kind: 'simpleRef', name: 'text' },
    });
  });

  it('binds annotations before "{" to the schema map, and key/type-def annotations to the right place', () => {
    const doc = parse(`${META} @doc:"schema doc" { @doc:"key doc" x => @doc:"def doc" uuid }`);
    expect(doc.body.annotations).toEqual([
      {
        name: 'doc',
        value: {
          annotations: [],
          coreValue: { kind: 'token', text: 'schema doc', form: 'single-line' },
        },
      },
    ]);
    const decl = doc.body.declarations.get('x');
    expect(decl?.nameAnnotations[0]?.name).toBe('doc');
    expect(decl?.typeDefAnnotations[0]?.name).toBe('doc');
  });

  it('rejects a declaration name that matches the number grammar (§12.1)', () => {
    expect(thrownBy(`${META} { 42 => uuid }`)).toBeInstanceOf(TsonParseError);
  });
});

// ── type-def dispatch (§5, §12.1, §12.2) ────────────────────────────────

describe('type-def: plain reference (§8.3)', () => {
  it('a bare type-name is a ReferenceTypeDef with an empty typeParams', () => {
    expect(typeDefOf('uuid')).toEqual({
      kind: 'referenceTypeDef',
      typeParams: [],
      ref: { kind: 'simpleRef', name: 'uuid' },
    });
  });

  it('a generic application is a ReferenceTypeDef wrapping a GenericRef', () => {
    expect(typeDefOf('map<text, integer>')).toEqual({
      kind: 'referenceTypeDef',
      typeParams: [],
      ref: {
        kind: 'genericRef',
        name: 'map',
        args: [
          { kind: 'ref', ref: { kind: 'simpleRef', name: 'text' } },
          { kind: 'ref', ref: { kind: 'simpleRef', name: 'integer' } },
        ],
      },
    });
  });

  it('inline choice sugar reaches type-def through type-ref', () => {
    const def = typeDefOf('(email | phone)');
    expect(def.kind).toBe('referenceTypeDef');
    if (def.kind !== 'referenceTypeDef') throw new Error('unreachable');
    expect(def.ref).toEqual({
      kind: 'choiceRef',
      variants: [
        { kind: 'simpleRef', name: 'email' },
        { kind: 'simpleRef', name: 'phone' },
      ],
    });
  });

  it('a type-def-level declaration may carry its own type parameters', () => {
    const def = typeDefOf('<V> map<text, V>');
    if (def.kind !== 'referenceTypeDef') throw new Error('unreachable');
    expect(def.typeParams).toEqual(['V']);
  });

  it('after a bare type-ref, "{" is a parse error suggesting ^ or &', () => {
    expect(thrownBy(`${META} { x => uuid { y: text } }`)).toBeInstanceOf(TsonParseError);
  });
});

describe('type-def: atom refinement and instance (§5.5)', () => {
  it('an atom refinement body is data, not the record-def the ABNF names (§5.5)', () => {
    // Deliberate, documented divergence from §12.1's literal ABNF — see CLAUDE.md's spec-feedback
    // section. The grammar says `atom-refinement = "!" type-name ws "^" ws record-def`, and
    // record-def's field-def admits only a type-ref or a `~`/`=` modifier over a BARE token. Under
    // that reading `spec/m/core.tn` line 105 is invalid, and core.tn is a live bundled schema the
    // reference implementation resolves. The reference parses a core-value here; so does this.
    const simple = typeDefOf('!integer ^ { min: 1 }');
    expect(simple.kind).toBe('atomRefinement');

    const nested = typeDefOf('!integer ^ { size: { bits: 8  signed: true } }');
    expect(nested.kind).toBe('atomRefinement');
    if (nested.kind !== 'atomRefinement') throw new Error('unreachable');
    expect(nested.target).toBe('integer');
    expect(nested.bindings.coreValue.kind).toBe('record');
  });

  it("rejects the ABNF's `~`/`=` field modifiers in a refinement body", () => {
    // The other side of the same divergence, stated so it is not rediscovered as a regression:
    // reading the body as data means the schema-only modifier syntax has no meaning here.
    expect(thrownBy(`${META} { x => !integer ^ { min: ~ 1 } }`)).toBeInstanceOf(TsonParseError);
  });
  it("parses a real atom refinement's bindings as data, not as type definitions (§5.5)", () => {
    // A refinement body holds constraint VALUES. `{ size: { bits: 8  signed: true } }` is
    // spec/m/core.tn line 105; parsed with the schema record-def production its inner `bits: 8`
    // reads as a type definition and the document is rejected — which is why
    // AtomRefinement.bindings is a DataValue, the shape the reference implementation carries.
    const simple = typeDefOf('!integer ^ { min: 1 }');
    expect(simple.kind).toBe('atomRefinement');

    const nested = typeDefOf('!integer ^ { size: { bits: 8  signed: true } }');
    expect(nested.kind).toBe('atomRefinement');
  });

  it('rejects a parameterized atom refinement (§12.1: refinement has no parameter slot)', () => {
    expect(thrownBy(`${META} { x => <T> !integer ^ { min: 1 } }`)).toBeInstanceOf(TsonParseError);
  });

  it('rejects an atom refinement whose body is not a brace', () => {
    expect(thrownBy(`${META} { x => !integer ^ 5 }`)).toBeInstanceOf(TsonParseError);
  });

  it('instance with a token core-value', () => {
    expect(typeDefOf('!enum [OPEN ACTIVE DONE]')).toEqual({
      kind: 'instance',
      typeParams: [],
      value: {
        annotations: [],
        typeRef: 'enum',
        coreValue: {
          kind: 'array',
          elements: [
            {
              value: {
                annotations: [],
                coreValue: { kind: 'token', text: 'OPEN', form: 'unquoted' },
              },
            },
            {
              value: {
                annotations: [],
                coreValue: { kind: 'token', text: 'ACTIVE', form: 'unquoted' },
              },
            },
            {
              value: {
                annotations: [],
                coreValue: { kind: 'token', text: 'DONE', form: 'unquoted' },
              },
            },
          ],
        },
      },
    });
  });

  it('instance with typeParams is a template with the same payload shape -- a collection payload is ordinary', () => {
    // The payload is read with the *data* grammar (§2.3-§2.9): 'variants: [T error]' is a
    // record field holding an array of two bare tokens, exactly as ordinary as a scalar payload.
    const def = typeDefOf('<T> !choice { variants: [T error] }');
    expect(def.kind).toBe('instance');
    if (def.kind !== 'instance') throw new Error('unreachable');
    expect(def.typeParams).toEqual(['T']);
    expect(def.value.typeRef).toBe('choice');
    expect(def.value.annotations).toEqual([]);
    expect(def.value.coreValue).toEqual({
      kind: 'record',
      fields: [
        {
          name: 'variants',
          value: {
            value: {
              annotations: [],
              coreValue: {
                kind: 'array',
                elements: [
                  {
                    value: {
                      annotations: [],
                      coreValue: { kind: 'token', text: 'T', form: 'unquoted' },
                    },
                  },
                  {
                    value: {
                      annotations: [],
                      coreValue: { kind: 'token', text: 'error', form: 'unquoted' },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });
  });

  it("requires '!' to be immediately adjacent to the type name", () => {
    expect(thrownBy(`${META} { x => ! integer }`)).toBeInstanceOf(TsonParseError);
  });

  it('rejects a numeric name after "!"', () => {
    expect(thrownBy(`${META} { x => !42 }`)).toBeInstanceOf(TsonParseError);
  });
});

describe('type-def: structural forms (§5.7-§5.9)', () => {
  it('a bare record body is a StructuralTypeDef with constructor: false', () => {
    expect(typeDefOf('{ id: uuid  title: text }')).toEqual({
      kind: 'structuralTypeDef',
      typeParams: [],
      constructor: false,
      body: {
        kind: 'recordDef',
        entries: [
          {
            kind: 'fieldDef',
            annotations: [],
            name: 'id',
            type: { typeRef: { kind: 'simpleRef', name: 'uuid' }, optional: false },
          },
          {
            kind: 'fieldDef',
            annotations: [],
            name: 'title',
            type: { typeRef: { kind: 'simpleRef', name: 'text' }, optional: false },
          },
        ],
      },
    });
  });

  it("an empty record body is the zero-field case ({}, top's shape)", () => {
    expect(typeDefOf('{}')).toEqual({
      kind: 'structuralTypeDef',
      typeParams: [],
      constructor: false,
      body: { kind: 'recordDef', entries: [] },
    });
  });

  it('"~" marks a fresh record as a constructor', () => {
    const def = typeDefOf('~{ x: uuid }');
    expect(def.kind).toBe('structuralTypeDef');
    if (def.kind !== 'structuralTypeDef') throw new Error('unreachable');
    expect(def.constructor).toBe(true);
  });

  it('refinement ("^") targets a bare type-name and takes a record-def body', () => {
    expect(typeDefOf('customer ^ { vip: boolean }')).toEqual({
      kind: 'structuralTypeDef',
      typeParams: [],
      constructor: false,
      body: {
        kind: 'refinedDef',
        target: { kind: 'simpleRef', name: 'customer' },
        body: {
          kind: 'recordDef',
          entries: [
            {
              kind: 'fieldDef',
              annotations: [],
              name: 'vip',
              type: { typeRef: { kind: 'simpleRef', name: 'boolean' }, optional: false },
            },
          ],
        },
      },
    });
  });

  it('"~" then a refinement head is a constructor refinement', () => {
    const def = typeDefOf('~pair<uuid, text> ^ { }');
    expect(def.kind).toBe('structuralTypeDef');
    if (def.kind !== 'structuralTypeDef') throw new Error('unreachable');
    expect(def.constructor).toBe(true);
    expect(def.body.kind).toBe('refinedDef');
  });

  it('composition chains "&"-joined supertypes and admits a trailing body', () => {
    // §5.8's own worked examples always spell the trailing body with its own leading '&'
    // ('customer => address & contact & { loyalty_tier: text }') -- never bodyless-of-'&' even
    // though the ABNF's first construction-def alternative's own '[ws record-def]' slot has no
    // operator prefix. This parser follows the worked examples (and the Java reference, which
    // only ever looks for a record-def immediately after consuming '&'), so the body needs its
    // own '&' here too.
    expect(typeDefOf('address & contact & { vip: boolean }')).toEqual({
      kind: 'structuralTypeDef',
      typeParams: [],
      constructor: false,
      body: {
        kind: 'constructionDef',
        supertypes: [
          { kind: 'simpleRef', name: 'address' },
          { kind: 'simpleRef', name: 'contact' },
        ],
        body: {
          kind: 'recordDef',
          entries: [
            {
              kind: 'fieldDef',
              annotations: [],
              name: 'vip',
              type: { typeRef: { kind: 'simpleRef', name: 'boolean' }, optional: false },
            },
          ],
        },
      },
    });
  });

  it('composition with no trailing body is valid', () => {
    const def = typeDefOf('address & contact');
    expect(def.kind).toBe('structuralTypeDef');
    if (def.kind !== 'structuralTypeDef') throw new Error('unreachable');
    expect(def.body).toEqual({
      kind: 'constructionDef',
      supertypes: [
        { kind: 'simpleRef', name: 'address' },
        { kind: 'simpleRef', name: 'contact' },
      ],
    });
  });

  it('subtraction attaches a non-empty removal set', () => {
    const def = typeDefOf('customer -{ vip }');
    expect(def.kind).toBe('structuralTypeDef');
    if (def.kind !== 'structuralTypeDef') throw new Error('unreachable');
    expect(def.body).toEqual({
      kind: 'constructionDef',
      supertypes: [{ kind: 'simpleRef', name: 'customer' }],
      removal: { fieldNames: ['vip'] },
    });
  });

  it("a removal clause's '-' must be separated from the preceding token by whitespace", () => {
    // 'customer-' lexes as one unquoted token (hyphen absorbed), so no removal clause exists
    // and the following '{' has nothing valid to attach to.
    expect(thrownBy(`${META} { x => customer -{ vip } y => customer- { vip } }`)).toBeInstanceOf(
      TsonParseError,
    );
  });

  it('composition operands are restricted to a bare supertype-ref, never a choice/bracket/map form (§4.3, §5.8)', () => {
    // Deliberate divergence from the Java reference, which reads continuation operands with the
    // unrestricted type-ref parser; this port enforces §12.1's own `supertype-ref` production.
    expect(thrownBy(`${META} { x => customer & (a | b) }`)).toBeInstanceOf(TsonParseError);
  });

  it('the removal set requires at least one field name', () => {
    expect(thrownBy(`${META} { x => customer -{} }`)).toBeInstanceOf(TsonParseError);
  });
});

// ── Fields and groups (§5.2, §5.11) ─────────────────────────────────────

describe('field states (§5.2)', () => {
  function fieldsOf(recordBody: string) {
    const def = typeDefOf(recordBody);
    if (def.kind !== 'structuralTypeDef' || def.body.kind !== 'recordDef') {
      throw new Error('expected a record body');
    }
    return def.body.entries;
  }

  it('REQUIRED: type only', () => {
    expect(fieldsOf('{ f: integer }')).toEqual([
      {
        kind: 'fieldDef',
        annotations: [],
        name: 'f',
        type: { typeRef: { kind: 'simpleRef', name: 'integer' }, optional: false },
      },
    ]);
  });

  it('OPTIONAL: type with adjacent "?"', () => {
    const [f] = fieldsOf('{ f: integer? }');
    expect(f).toMatchObject({ type: { optional: true } });
  });

  it("rejects '?' separated from the type by whitespace", () => {
    expect(thrownBy(`${META} { x => { f: integer ? } }`)).toBeInstanceOf(TsonParseError);
  });

  it('REQUIRED_DEFAULT: type then "~ value"', () => {
    expect(fieldsOf('{ f: integer ~ 3 }')).toEqual([
      {
        kind: 'fieldDef',
        annotations: [],
        name: 'f',
        type: { typeRef: { kind: 'simpleRef', name: 'integer' }, optional: false },
        modifier: {
          kind: 'default',
          value: { kind: 'literal', token: { kind: 'token', text: '3', form: 'unquoted' } },
        },
      },
    ]);
  });

  it('REQUIRED_FIXED: type then "= value"', () => {
    const [f] = fieldsOf('{ f: status = OPEN }');
    expect(f).toMatchObject({ modifier: { kind: 'fixed' } });
  });

  it('OPTIONAL_FIXED with an absent fixed value ("= _"), legal only on an optional field grammatically permitted here', () => {
    expect(fieldsOf('{ f: text? = _ }')).toEqual([
      {
        kind: 'fieldDef',
        annotations: [],
        name: 'f',
        type: { typeRef: { kind: 'simpleRef', name: 'text' }, optional: true },
        modifier: { kind: 'fixed', value: { kind: 'absent' } },
      },
    ]);
  });

  it('a modifier alone (elided type-ref) parses -- legality of eliding is a later, semantic-layer check', () => {
    // field-def always requires its ':' (§12.1): only what follows it may omit the type.
    expect(fieldsOf('{ f: ~ 3 }')).toEqual([
      {
        kind: 'fieldDef',
        annotations: [],
        name: 'f',
        modifier: {
          kind: 'default',
          value: { kind: 'literal', token: { kind: 'token', text: '3', form: 'unquoted' } },
        },
      },
    ]);
  });

  it("rejects a field-modifier value that is a container, since field-modifier admits only a token or '_'", () => {
    expect(thrownBy(`${META} { x => { f: text = [1 2] } }`)).toBeInstanceOf(TsonParseError);
  });

  it("rejects '=>' at a non-first record-entry position, naming the record/map confusion", () => {
    // The FIRST entry after '{' at type-def position is what §12.2's one-token-lookahead brace
    // dispatch decides between record and map ('f =>' there commits to the map sugar, correctly
    // -- see the map-sugar tests below); this checks a later entry, once the body has already
    // committed to being a record.
    expect(thrownBy(`${META} { x => { f: text  g => text } }`)).toBeInstanceOf(TsonParseError);
  });
});

describe('field groups (§5.11)', () => {
  it('a group requires at least two members, separated by "|"', () => {
    const def = typeDefOf('{ (email_addr: email | phone_num: phone) }');
    if (def.kind !== 'structuralTypeDef' || def.body.kind !== 'recordDef') {
      throw new Error('expected a record body');
    }
    expect(def.body.entries).toEqual([
      {
        kind: 'groupDef',
        annotations: [],
        members: [
          { annotations: [], name: 'email_addr', typeRef: { kind: 'simpleRef', name: 'email' } },
          { annotations: [], name: 'phone_num', typeRef: { kind: 'simpleRef', name: 'phone' } },
        ],
        optional: false,
      },
    ]);
  });

  it('a trailing "?" makes the group optional', () => {
    const def = typeDefOf('{ (a: text | b: text)? }');
    if (def.kind !== 'structuralTypeDef' || def.body.kind !== 'recordDef') {
      throw new Error('expected a record body');
    }
    expect(def.body.entries[0]).toMatchObject({ optional: true });
  });

  it('rejects a group with only one member', () => {
    expect(thrownBy(`${META} { x => { (a: text) } }`)).toBeInstanceOf(TsonParseError);
  });
});

// ── Type expressions (§5.3, §5.4) ───────────────────────────────────────

describe('choice types (§5.4)', () => {
  it('requires at least two variants', () => {
    expect(thrownBy(`${META} { x => (email) }`)).toBeInstanceOf(TsonParseError);
  });
});

describe('bracket forms: array and tuple (§5.3)', () => {
  it('one element with no size is an unconstrained array', () => {
    expect(typeDefOf('[text]')).toEqual({
      kind: 'referenceTypeDef',
      typeParams: [],
      ref: {
        kind: 'arrayRef',
        elementType: { typeRef: { kind: 'simpleRef', name: 'text' }, optional: false },
      },
    });
  });

  it('"N" is an exact size spec', () => {
    const def = typeDefOf('[text; 3]');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'arrayRef')
      throw new Error('expected an array ref');
    expect(def.ref.size).toEqual({ kind: 'exact', bound: '3' });
  });

  it('"N..M" is a ranged size spec', () => {
    const def = typeDefOf('[text; 1..2]');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'arrayRef')
      throw new Error('expected an array ref');
    expect(def.ref.size).toEqual({ kind: 'ranged', lower: '1', upper: '2' });
  });

  it('"N.." is a min size spec', () => {
    const def = typeDefOf('[text; 1..]');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'arrayRef')
      throw new Error('expected an array ref');
    expect(def.ref.size).toEqual({ kind: 'min', lower: '1' });
  });

  it('"..M" is a max size spec', () => {
    const def = typeDefOf('[text; ..2]');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'arrayRef')
      throw new Error('expected an array ref');
    expect(def.ref.size).toEqual({ kind: 'max', upper: '2' });
  });

  it('two or more elements is a tuple, each position carrying its own "?"', () => {
    const def = typeDefOf('[text, integer?]');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'tupleRef')
      throw new Error('expected a tuple ref');
    expect(def.ref.elementTypes).toEqual([
      { typeRef: { kind: 'simpleRef', name: 'text' }, optional: false },
      { typeRef: { kind: 'simpleRef', name: 'integer' }, optional: true },
    ]);
  });

  it('nesting: [[T; 2]; 3] is the recursion in element-type, needing no second production', () => {
    const def = typeDefOf('[[text; 2]; 3]');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'arrayRef')
      throw new Error('expected an array ref');
    expect(def.ref.elementType.typeRef).toEqual({
      kind: 'arrayRef',
      elementType: { typeRef: { kind: 'simpleRef', name: 'text' }, optional: false },
      size: { kind: 'exact', bound: '2' },
    });
  });
});

describe('map sugar (§5.3)', () => {
  it('parses {key => value}, legal at any type-ref position', () => {
    expect(typeDefOf('{text => integer}')).toEqual({
      kind: 'referenceTypeDef',
      typeParams: [],
      ref: {
        kind: 'mapRef',
        keyType: { kind: 'simpleRef', name: 'text' },
        valueType: { typeRef: { kind: 'simpleRef', name: 'integer' }, optional: false },
      },
    });
  });

  it('admits a generic key', () => {
    const def = typeDefOf('{enum_key<status> => integer}');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'mapRef')
      throw new Error('expected a map ref');
    expect(def.ref.keyType).toEqual({
      kind: 'genericRef',
      name: 'enum_key',
      args: [{ kind: 'ref', ref: { kind: 'simpleRef', name: 'status' } }],
    });
  });

  it('admits a size spec after ";"', () => {
    const def = typeDefOf('{text => integer; 1..10}');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'mapRef')
      throw new Error('expected a map ref');
    expect(def.ref.size).toEqual({ kind: 'ranged', lower: '1', upper: '10' });
  });

  it('rejects "?" on either side of "=>"', () => {
    expect(thrownBy(`${META} { x => {text? => integer} }`)).toBeInstanceOf(TsonParseError);
    expect(thrownBy(`${META} { x => {text => integer?} }`)).toBeInstanceOf(TsonParseError);
  });

  it('rejects a second entry: a map type is a single key => value entry', () => {
    expect(thrownBy(`${META} { x => {a => b  c => d} }`)).toBeInstanceOf(TsonParseError);
  });

  it('a bare record body is not spellable at a type position -- "{" there is always the map sugar', () => {
    expect(thrownBy(`${META} { x => field: { f: text } }`)).toBeInstanceOf(TsonParseError);
  });
});

describe('type arguments (§12.1, §5.10)', () => {
  it('a quoted token is unambiguously a value', () => {
    const def = typeDefOf('keyed<"literal">');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'genericRef')
      throw new Error('expected a generic ref');
    expect(def.ref.args[0]).toEqual({
      kind: 'value',
      value: { kind: 'token', text: 'literal', form: 'single-line' },
    });
  });

  it('a numeric unquoted token is a value', () => {
    const def = typeDefOf('vector<pixel, 1920>');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'genericRef')
      throw new Error('expected a generic ref');
    expect(def.ref.args[1]).toEqual({
      kind: 'value',
      value: { kind: 'token', text: '1920', form: 'unquoted' },
    });
  });

  it('a non-numeric unquoted token always parses as a type-ref, never a value (deferred to the semantic layer)', () => {
    const def = typeDefOf('flagged<status, N>');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'genericRef')
      throw new Error('expected a generic ref');
    expect(def.ref.args[1]).toEqual({ kind: 'ref', ref: { kind: 'simpleRef', name: 'N' } });
  });

  it('rejects the absent sentinel as a type argument', () => {
    expect(thrownBy(`${META} { x => box<_> }`)).toBeInstanceOf(TsonParseError);
  });

  it('a choice, bracket, or map form is admitted as a type argument (wrapped as a ref)', () => {
    const def = typeDefOf('box<[text]>');
    if (def.kind !== 'referenceTypeDef' || def.ref.kind !== 'genericRef')
      throw new Error('expected a generic ref');
    expect(def.ref.args[0]).toEqual({
      kind: 'ref',
      ref: {
        kind: 'arrayRef',
        elementType: { typeRef: { kind: 'simpleRef', name: 'text' }, optional: false },
      },
    });
  });
});

describe('type names (§12.1)', () => {
  it('rejects a numeric type parameter name', () => {
    expect(thrownBy(`${META} { x => <42> map<text, 42> }`)).toBeInstanceOf(TsonParseError);
  });
});

// ── Full worked example (spec §1.6) ─────────────────────────────────────

describe("the spec's own worked example (§1.6)", () => {
  it('parses end to end', () => {
    // `priority`'s own line in the spec is `!integer ^ { min: 1  max: 5 }` -- an atom
    // refinement with bare-value bindings, which this parser cannot yet build (see the
    // "does not yet parse a real atom refinement's bare-value bindings" test and this session's
    // report: `AtomRefinement.bindings`'s frozen `RecordDef` type cannot represent it). Every
    // other line is exactly as written in §1.6.
    const doc = parse(`
!!id:"https://example.com/task.tn"
${META}
!!import:"https://tson.io/2026/33/m/core.tn"
@doc:"Task-tracking example schema."
{
  priority => integer
  status   => !enum [OPEN ACTIVE DONE]
  flagged  => <T, N> { entry: T  priority: priority ~ N }
  task => {
    id:       uuid
    title:    non_empty_text
    priority: priority ~ 3
    status:   status ~ OPEN
    due:      date?
    tags:     [text]?
    history:  [flagged<status, 2>]?
  }
}
`);
    expect(doc.id).toBe('https://example.com/task.tn');
    expect([...doc.body.declarations.keys()]).toEqual(['priority', 'status', 'flagged', 'task']);
    const task = doc.body.declarations.get('task');
    if (task?.typeDef.kind !== 'structuralTypeDef' || task.typeDef.body.kind !== 'recordDef') {
      throw new Error('expected task to be a fresh record');
    }
    expect(task.typeDef.body.entries).toHaveLength(7);
    const history = task.typeDef.body.entries.find(
      (e): e is Extract<typeof e, { kind: 'fieldDef' }> =>
        e.kind === 'fieldDef' && e.name === 'history',
    );
    expect(history?.type).toMatchObject({
      optional: true,
      typeRef: {
        kind: 'arrayRef',
        elementType: {
          optional: false,
          typeRef: {
            kind: 'genericRef',
            name: 'flagged',
            args: [
              { kind: 'ref', ref: { kind: 'simpleRef', name: 'status' } },
              { kind: 'value', value: { kind: 'token', text: '2', form: 'unquoted' } },
            ],
          },
        },
      },
    });
  });
});
