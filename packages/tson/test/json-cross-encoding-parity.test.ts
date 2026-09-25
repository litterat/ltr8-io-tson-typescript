/**
 * A port of the Java reference's `CrossEncodingParityTest`
 * (`tson-json/src/test/java/io/ltr8/tson/json/CrossEncodingParityTest.java`) -- [TSON-JSON] §1.5's
 * Class 3 equivalence check: one schema, one document in two encodings, one verdict.
 *
 * **This is a drift guard, and it exists because the schema-directed readers are two
 * implementations.** `src/json/` has its own compiled reader stack rather than sharing
 * `src/compiler/`'s (`IDIOM-DEBT.md`'s own entry says why that is the right trade), and the cost of
 * the trade is that the field rules ([TSON-SCHEMA] §5.2's marks read through a field's facts,
 * injection, the FIXED check, closure, duplicate members) are written twice and can drift apart
 * silently.
 *
 * [TSON-JSON] §9.4 makes that a specification obligation rather than a tidiness: this encoding
 * reports in [TSON-DATA] §8.1's four categories and adds none of its own, so one document that is
 * wrong in one encoding is wrong in the other, for the same stated reason, at the same place. What
 * is compared is therefore the `Diagnostic.code` and the RFC 6901 `path` -- the two components a
 * consumer routes on -- generally never the message.
 *
 * **One deliberate difference from the Java test class: message-text parity is not asserted.** The
 * Java's own `sameRule` additionally compares `expected`/`message`, because the reference's two
 * stacks share one prose source for a handful of rules (`base.diagnostics`). This port's two
 * stacks write their own prose independently top to bottom (`CLAUDE.md`'s "the field rules... are
 * written twice" is exactly this port's own shape too), so nothing here claims the two stacks phrase
 * a refusal identically -- only that they agree on the code and the pointer, which is what a
 * consumer actually routes on. Where the Java's own case name says "AndStatedDifferently" this port
 * already does not assert prose equality anywhere, so those cases collapse into the same shape as
 * every other `sameRule` case here.
 *
 * What is deliberately *not* asserted is the schema pointer: both ends name the path the read took,
 * but the two front doors enter through different roots (a TSON document names its own root type;
 * a JSON one is bound out of band), so the pointers legitimately differ in their first step.
 */
import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../src/core/diagnostic.js';
import { compile, type CompiledSchema } from '../src/compiler/compile.js';
import { readTree, validate as validateText } from '../src/facade/tree.js';
import { compileJsonSchema, type JsonCompiledSchema } from '../src/json/schema/compile.js';
import { readJsonTree, validateJson } from '../src/json/facade.js';
import { tokenPolicy } from '../src/unicode/policy.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

// ── One schema, both encodings -- a straight port of the Java class's own `SCHEMA` ─────────────

const SCHEMA_SOURCE = `
!!id:"https://example.test/parity-1.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  person => {
    name:   text
    tries?: int32 ~ 0
    kind?:  text = "person"
    labels: [text]
  }
  sized  => [text; 2..3]
  unique => set<text>
  stamps => set<datetime>
  pair   => [text, int32]
  bounded => {
    value: int32
    ( min: int32 | max: int32 )
  }
  counts    => { text => int32 }
  by_number => { number => text }
  by_date   => { date => number }
  point     => { x: int32  y: int32 }
  by_point  => { point => text }
  route     => { name: text  stops: [point] }
  employee  => person & { department: text }
  robot     => { serial: text }
  holder    => { who: person  labels: [text] }
  scalars   => ( text | int32 | boolean )
  circle    => { radius: float64 }
  square    => { side: float64 }
  shape     => ( circle | square )
  picked    => { pick: scalars }
  shaped    => { outline: shape }
  pet       => abstract { pet_type: text =?  name: text }
  dog       => pet & { pet_type?: = "dog"  breed: text }
  cat       => pet & { pet_type?: = "cat"  indoor: boolean }
  figure    => abstract { area: int32 }
  disc      => figure & { side: int32 }
  kennel    => { p: pet }
  dog_of    => dog
  pet_of    => pet
  gallery   => { f: figure }
  garage    => { r: robot }
  outcome    => abstract <T> { code: T }
  won        => <T> outcome<T> & { prize: text }
  outcome_of => outcome<text>
  won_of     => won<text>
  ledger     => { o: outcome<text> }
  box        => <T> { v: T }
  int_box    => box<int32>
  text_box   => box<text>
  crate      => { b: box }
  marks      => {
    nickname?: text
    from:      int32?
    timeout?:  int32? ~ 30
    version:   text = "2.0"
  }
}
`;

const LINKED = resolveUserSchema(SCHEMA_SOURCE);
const JSON_SCHEMA: JsonCompiledSchema = compileJsonSchema(LINKED);
const TEXT_SCHEMA: CompiledSchema = compile(LINKED);

function tson(rootType: string, body: string): readonly Diagnostic[] {
  return validateText(bytesOf(body), { schema: TEXT_SCHEMA, root: rootType }).diagnostics;
}

function json(rootType: string, body: string): readonly Diagnostic[] {
  return validateJson(body, { schema: JSON_SCHEMA, root: rootType }).diagnostics;
}

/** A diagnostic reduced to what a consumer routes on: which rule fired, and where in the data. */
interface Verdict {
  readonly code: string;
  readonly path: string;
}

function verdictsOf(diagnostics: readonly Diagnostic[]): readonly Verdict[] {
  return diagnostics.map((d) => ({ code: d.code, path: d.path ?? '?' }));
}

/**
 * Asserts the two encodings agree, and that they agreed on *something* -- an assertion that both
 * sides reported nothing would pass for a reader that had not run at all, which is how a parity
 * guard comes to hold vacuously.
 */
function sameVerdict(rootType: string, tsonBody: string, jsonBody: string): void {
  const fromTson = tson(rootType, tsonBody);
  expect(
    fromTson.length,
    'the TSON side reported nothing, so this compares nothing',
  ).toBeGreaterThan(0);
  expect(verdictsOf(json(rootType, jsonBody))).toEqual(verdictsOf(fromTson));
}

/**
 * As {@link sameVerdict}, comparing the codes alone -- for a case where the two documents
 * genuinely have different *shapes*: §6.5's pairs form makes a compound-keyed map a JSON array of
 * pairs, so a pointer into it names an entry index where the TSON map has a key. What still must
 * agree is which rule fired.
 */
function sameCodes(rootType: string, tsonBody: string, jsonBody: string): void {
  const fromTson = tson(rootType, tsonBody).map((d) => d.code);
  expect(
    fromTson.length,
    'the TSON side reported nothing, so this compares nothing',
  ).toBeGreaterThan(0);
  expect(json(rootType, jsonBody).map((d) => d.code)).toEqual(fromTson);
}

/**
 * The strongest comparison this port asserts: the code and the data pointer. Not `expected`
 * either, alongside `message` (this file's own top note says why): each stack's `expected` is its
 * own independently-authored rendering of "what would have been admitted here" (`one of (dog |
 * cat)` against `dog | cat`, `'robot'` against `robot`, ...), never literally shared the way the
 * Java reference's `base.diagnostics` makes a handful of its own. This collapses the Java test
 * class's own separate `sameRule`/`sameCodeAndPath` helpers into one: with `expected` and
 * `message` both out of the comparison, the two ask the same question here.
 */
function sameRule(rootType: string, tsonBody: string, jsonBody: string): void {
  const fromTson = tson(rootType, tsonBody);
  expect(
    fromTson.length,
    'the TSON side reported nothing, so this compares nothing',
  ).toBeGreaterThan(0);
  const fromJson = json(rootType, jsonBody);
  expect(verdictsOf(fromJson)).toEqual(verdictsOf(fromTson));
}

function bothAccept(rootType: string, tsonBody: string, jsonBody: string): void {
  expect(tson(rootType, tsonBody)).toEqual([]);
  expect(json(rootType, jsonBody)).toEqual([]);
}

// ── §5.2 one mark per question ───────────────────────────────────────────────────────────────

describe('§5.2 one mark per question', () => {
  it('nickname?: text may be omitted and refuses _: one rule, stated once, in both encodings', () => {
    sameRule(
      'marks',
      '{ nickname: _  from: 1  version: "2.0" }',
      '{"nickname": null, "from": 1, "version": "2.0"}',
    );
  });

  it('from: int32? admits _ and must be written; version: text = "2.0" must be too', () => {
    bothAccept('marks', '{ from: _  version: "2.0" }', '{"from": null, "version": "2.0"}');
    sameRule('marks', '{ version: "2.0" }', '{"version": "2.0"}');
    sameRule('marks', '{ from: 1 }', '{"from": 1}');
  });

  /**
   * Both trees keep the spelling of absence (§7.2): a field written `_` or `null` stands as the
   * absent node in the tree, and a field never written is not there at all -- the text tree's
   * `kind: 'absent'` and the JSON tree's `kind: 'null'` at the same fields, in both directions.
   */
  it('both trees keep which spelling of absence arrived', () => {
    const text = readTree(bytesOf('{ from: _  timeout: _  version: "2.0" }'), {
      schema: TEXT_SCHEMA,
      root: 'marks',
    });
    if (text.kind !== 'record') throw new Error(`expected a record, got '${text.kind}'`);
    const json = readJsonTree('{"from": null, "timeout": null, "version": "2.0"}', {
      schema: JSON_SCHEMA,
      root: 'marks',
    });
    if (json.kind !== 'object') throw new Error(`expected an object, got '${json.kind}'`);
    for (const field of ['from', 'timeout']) {
      expect(text.fields.get(field)?.kind, field).toBe('absent');
      expect(json.members.get(field)?.kind, field).toBe('null');
    }
    expect(text.fields.has('nickname')).toBe(false);
    expect(json.members.has('nickname')).toBe(false);
  });
});

// ── §7.2 subsumption ────────────────────────────────────────────────────────────────────────

describe('§7.2 subsumption', () => {
  it('a tag naming an inadmissible type is one rule in both (TYPE_MISMATCH)', () => {
    sameRule(
      'holder',
      '{ who: !robot { serial: "x" }  labels: [] }',
      '{"who":{"$type":"robot","serial":"x"},"labels":[]}',
    );
  });

  it('the same rule where the position’s type has no subtypes at all', () => {
    sameRule(
      'garage',
      '{ r: !person { name: "Ada"  labels: [] } }',
      '{"r":{"$type":"person","name":"Ada","labels":[]}}',
    );
  });
});

// ── Subtype families ([TSON-SCHEMA] §5.2, [TSON-JSON] §6.1.5) ──────────────────────────────────

describe('subtype families', () => {
  it('a sealed family’s value is tag-free in both encodings -- the headline', () => {
    bothAccept(
      'kennel',
      '{ p: { pet_type: dog  name: Rex  breed: corgi } }',
      '{"p": {"pet_type": "dog", "name": "Rex", "breed": "corgi"}}',
    );
  });

  it('the other pin selects the other member in both', () => {
    bothAccept(
      'kennel',
      '{ p: { pet_type: cat  name: Tom  indoor: true } }',
      '{"p": {"pet_type": "cat", "name": "Tom", "indoor": true}}',
    );
  });

  it('two spellings of one instant are one set element in both -- value identity over instants', () => {
    sameRule(
      'stamps',
      '[ "2026-01-01T00:00:30Z" "2026-01-01T01:00:30+01:00" ]',
      '["2026-01-01T00:00:30Z", "2026-01-01T01:00:30+01:00"]',
    );
  });

  /**
   * One rule, one code, one pointer in both -- the Java reference's own
   * `aMissingDiscriminatorIsOneRuleInBothAndJsonSaysWhereItGoes` asserts full `sameCodeAndPath`
   * parity for this exact document, and so does this port: a missing discriminator is refused on
   * its own terms alone, a single `FIELD_REQUIRED` at the discriminator field, and nothing else
   * about the record -- `breed` included -- is inspected once that refusal fires
   * (`compiler/subsumption.ts#buildMemberDispatchReader`, `json/schema/dispatchMember.ts`).
   */
  it('a missing discriminator is one rule in both, JSON saying where it goes', () => {
    sameRule(
      'kennel',
      '{ p: { name: Rex  breed: corgi } }',
      '{"p": {"name": "Rex", "breed": "corgi"}}',
    );
    const fromJson = json('kennel', '{"p": {"name": "Rex", "breed": "corgi"}}');
    expect(fromJson.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
    expect(fromJson[0]?.path).toBe('/p/pet_type');
    expect(fromJson[0]?.message).toContain('missing discriminator');
  });

  it('a discriminator with no member that pins it is one rule in both', () => {
    sameRule(
      'kennel',
      '{ p: { pet_type: dgo  name: Rex } }',
      '{"p": {"pet_type": "dgo", "name": "Rex"}}',
    );
  });

  /**
   * A divergence, pinned rather than asserted equal -- and, in this port, not the same divergence
   * the Java reference's own `CrossEncodingParityTest` documents for this scenario (its own
   * comment says its *text* stack reports a plain `TYPE_MISMATCH`; this port's own text stack
   * carries a dedicated check for exactly this shape instead, `compiler/subsumption.ts`'s member
   * dispatcher comparing a present tag against the discriminator it names once the record is
   * fully read, and reports the more specific `VALIDATION_ERROR` "contradicts the discriminator").
   * JSON's sealed dispatcher sends a tagged value where its tag names, and the selected member's
   * own reader refuses the pin the document contradicts as an ordinary `FIELD_FIXED` check at the
   * discriminator field. Both refuse the document; they say so differently, and neither is wrong.
   */
  it('DIVERGENCE: a tag contradicting the discriminator is refused in both, stated differently', () => {
    const fromTson = tson('kennel', '{ p: !cat { pet_type: dog  name: Rex  breed: corgi } }');
    expect(fromTson.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    expect(fromTson[0]?.path).toBe('/p');
    expect(fromTson[0]?.message).toContain('contradicts the discriminator');
    const fromJson = json(
      'kennel',
      '{"p": {"$type": "cat", "pet_type": "dog", "name": "Rex", "breed": "corgi"}}',
    );
    expect(fromJson.some((d) => d.code === 'FIELD_FIXED' && d.path === '/p/pet_type')).toBe(true);
  });

  it('an abstract position requires its tag in both', () => {
    sameRule('gallery', '{ f: { area: 4 } }', '{"f": {"area": 4}}');
  });

  it('a tag naming the abstract base is one rule in both -- not a redundant restatement', () => {
    sameRule('gallery', '{ f: !figure { area: 4 } }', '{"f": {"$type": "figure", "area": 4}}');
  });

  it('an abstract position takes the tagged subtype in both', () => {
    bothAccept(
      'gallery',
      '{ f: !disc { area: 4  side: 2 } }',
      '{"f": {"$type": "disc", "area": 4, "side": 2}}',
    );
  });

  it('an alias of a sealed member agrees in both', () => {
    bothAccept(
      'kennel',
      '{ p: !dog_of { pet_type: "dog"  name: "Rex"  breed: "lab" } }',
      '{"p": {"$type": "dog_of", "pet_type": "dog", "name": "Rex", "breed": "lab"}}',
    );
  });

  it('an alias of a sealed base selects nothing in both', () => {
    sameRule(
      'kennel',
      '{ p: !pet_of { pet_type: "dog"  name: "Rex"  breed: "lab" } }',
      '{"p": {"$type": "pet_of", "pet_type": "dog", "name": "Rex", "breed": "lab"}}',
    );
  });

  it('an alias of a template family member selects it in both', () => {
    bothAccept(
      'ledger',
      '{ o: !won_of { code: "c"  prize: "p" } }',
      '{"o": {"$type": "won_of", "code": "c", "prize": "p"}}',
    );
  });

  it('an alias of a template family base selects nothing in both', () => {
    sameRule(
      'ledger',
      '{ o: !outcome_of { code: "c" } }',
      '{"o": {"$type": "outcome_of", "code": "c"}}',
    );
  });

  it('the untagged case over a template family in both, comparing expected too', () => {
    sameRule('ledger', '{ o: { code: "c"  prize: "p" } }', '{"o": {"code": "c", "prize": "p"}}');
  });
});

// ── A bare template at a type position ──────────────────────────────────────────────────────
//    `crate => { b: box }` names the template itself, which is the family base its
//    instantiations close from (§5.10). The base is ABSTRACT by derivation, so the tag is the
//    selector in both encodings, and every member is minted, so an alias is the only name either
//    document has for one.

describe('a bare template at a type position', () => {
  it('a member of a bare template base reads in both, by alias', () => {
    bothAccept('crate', '{ b: !int_box { v: 1 } }', '{"b": {"$type": "int_box", "v": 1}}');
  });

  it('the other member reads in both, which makes the dispatch a dispatch', () => {
    bothAccept('crate', '{ b: !text_box { v: "x" } }', '{"b": {"$type": "text_box", "v": "x"}}');
  });

  it('untagged selects nothing: both encodings require the tag', () => {
    sameRule('crate', '{ b: { v: 1 } }', '{"b": {"v": 1}}');
  });

  it('a tag naming the base itself selects nothing either', () => {
    sameRule('crate', '{ b: !box { v: 1 } }', '{"b": {"$type": "box", "v": 1}}');
  });
});

// ── Base cases ───────────────────────────────────────────────────────────────────────────────

describe('base cases', () => {
  it('a conforming document is accepted by both', () => {
    bothAccept(
      'person',
      '{ name: "Ada"  tries: 1  kind: "person"  labels: [ "x" ] }',
      '{"name": "Ada", "tries": 1, "kind": "person", "labels": ["x"]}',
    );
  });

  it('a composite where a scalar is due', () => {
    sameVerdict('person', '{ name: { a: 1 }  labels: [] }', '{"name": {"a": 1}, "labels": []}');
  });

  /**
   * The one place the two encodings legitimately differ, asserted as a difference so it cannot
   * drift into one by accident. JSON has six value kinds and TSON text has tokens: `42` at a
   * `text` position is the unquoted token `42`, whose content `text`'s contract accepts
   * ([TSON-DATA] §5.2), while JSON's `42` is of the number kind and §5.6 admits only strings at
   * `text`. Neither reader is wrong.
   */
  it('DIVERGENCE: an unquoted token and a JSON number are not the same thing at a text field', () => {
    expect(
      tson('person', '{ name: 42  labels: [] }'),
      'an unquoted token is text’s content in TSON',
    ).toEqual([]);
    const fromJson = json('person', '{"name": 42, "labels": []}');
    expect(verdictsOf(fromJson), 'a JSON number is not of the string kind').toEqual([
      { code: 'TYPE_MISMATCH', path: '/name' },
    ]);
  });

  it('a missing required field', () => {
    sameRule('person', '{ labels: [] }', '{"labels": []}');
  });

  it('a field the type does not declare', () => {
    sameRule(
      'person',
      '{ name: "Ada"  labels: []  shoe_size: 9 }',
      '{"name": "Ada", "labels": [], "shoe_size": 9}',
    );
  });

  it('a field stated twice', () => {
    sameRule(
      'person',
      '{ name: "Ada"  name: "Grace"  labels: [] }',
      '{"name": "Ada", "name": "Grace", "labels": []}',
    );
  });

  it('a contradicted fixed value', () => {
    sameRule(
      'person',
      '{ name: "Ada"  kind: "robot"  labels: [] }',
      '{"name": "Ada", "kind": "robot", "labels": []}',
    );
  });

  it('the absent sentinel at a required field: _ in text, null in JSON, one verdict', () => {
    sameRule('person', '{ name: _  labels: [] }', '{"name": null, "labels": []}');
  });

  it('§6.1.2: the absent sentinel at a defaulted field -- the fix is omission, and stating absence is refused in both', () => {
    sameRule(
      'person',
      '{ name: "Ada"  tries: _  labels: [] }',
      '{"name": "Ada", "tries": null, "labels": []}',
    );
  });

  it('a composite element where a scalar is due', () => {
    sameVerdict(
      'person',
      '{ name: "Ada"  labels: [ "x", [ 2 ] ] }',
      '{"name": "Ada", "labels": ["x", [2]]}',
    );
  });

  it('an absent element in a required-element array: _ in text, null in JSON, one verdict at one index', () => {
    sameRule(
      'person',
      '{ name: "Ada"  labels: [ "x", _ ] }',
      '{"name": "Ada", "labels": ["x", null]}',
    );
  });

  it('an array outside its size bounds', () => {
    sameRule('sized', '[ "a" ]', '["a"]');
  });

  it('a repeated set element', () => {
    sameRule('unique', '[ "a", "a" ]', '["a", "a"]');
  });

  it('a tuple of the wrong length', () => {
    sameRule('pair', '[ "a" ]', '["a"]');
  });

  it('a required group with no member present', () => {
    sameRule('bounded', '{ value: 1 }', '{"value": 1}');
  });

  it('a required group with two members present', () => {
    sameRule('bounded', '{ value: 1  min: 0  max: 9 }', '{"value": 1, "min": 0, "max": 9}');
  });
});

// ── §8.2 discrimination: the derived `disjoint` fact, dispatched twice ─────────────────────────
//
// A choice is exercised at a *nested* position, not as a root type: in text the root type-ref is
// both the binding and, at a choice position, the variant tag, so `!scalars "hi"` is refused and
// the document names `text` instead, leaving "the root is a scalars" with no carrier -- JSON binds
// out of band (§3.4), so a root type and a tag are separate statements and reading JSON as
// `scalars` is ordinary. The *values* still agree; only the way the root type is stated differs,
// which is §3.4's business. A field position has a position in both, so that is where the
// predicate itself can be compared.

describe('§8.2 discrimination, dispatched twice', () => {
  it('a disjoint, class-stable choice dispatches untagged in both', () => {
    bothAccept('picked', '{ pick: "hi" }', '{"pick": "hi"}');
    bothAccept('picked', '{ pick: 42 }', '{"pick": 42}');
    bothAccept('picked', '{ pick: true }', '{"pick": true}');
  });

  it('the selected variant is validated as itself -- an out-of-range value is refused in both', () => {
    sameVerdict('picked', '{ pick: 99999999999 }', '{"pick": 99999999999}');
  });

  it('two record variants sharing the brace class are not disjoint, and neither may recover the variant from the form', () => {
    sameCodes('shaped', '{ outline: { side: 1.0 } }', '{"outline": {"side": 1.0}}');
  });

  /**
   * A tag naming something that is no variant: checked rather than assumed to agree, and the
   * codes do -- the pointers legitimately differ, which is why this compares codes alone: in JSON
   * the tag *is a member* with a location of its own (`/outline/$type`); in text it is an
   * annotation beside the value, and the value's own pointer is the nearest thing there is.
   */
  it('a tag naming a non-variant is refused by both, codes agree', () => {
    sameCodes(
      'shaped',
      '{ outline: !person { name: "Ada"  labels: [] } }',
      '{"outline": {"$type": "person", "name": "Ada", "labels": []}}',
    );
  });

  it('a tagged variant reads in both', () => {
    bothAccept(
      'shaped',
      '{ outline: !circle { radius: 1.0 } }',
      '{"outline": {"$type": "circle", "radius": 1.0}}',
    );
  });
});

// ── §6.1.5 subsumption: !employee in text, $type in JSON ───────────────────────────────────────

describe('§6.1.5 subsumption at a field position', () => {
  it('a subtype selected at a field position', () => {
    bothAccept(
      'holder',
      '{ who: !employee { name: "Ada"  department: "Engines"  labels: [] }  labels: [] }',
      '{"who": {"$type": "employee", "name": "Ada", "department": "Engines", "labels": []}, "labels": []}',
    );
  });

  it('without a tag the value is exactly the position’s type -- no structural recovery, in either encoding', () => {
    sameRule(
      'holder',
      '{ who: { name: "Ada"  department: "Engines"  labels: [] }  labels: [] }',
      '{"who": {"name": "Ada", "department": "Engines", "labels": []}, "labels": []}',
    );
  });

  it('the selected type validates in full, so a field it adds and the document omits is still missing', () => {
    sameVerdict(
      'holder',
      '{ who: !employee { name: "Ada"  labels: [] }  labels: [] }',
      '{"who": {"$type": "employee", "name": "Ada", "labels": []}, "labels": []}',
    );
  });

  // Codes only, not the full rule: JSON's own `notAMember` (`dispatchMember.ts`) reports
  // at `/p/$type`, since the name genuinely resolves nowhere (or resolves outside the family)
  // this position admits and no shared-with-text rule is in play; TSON text's tag is an
  // annotation with no pointer step of its own, so it reports at `/p` -- the same
  // pointer-convention split `dispatchTag.ts`'s own top note documents for the "own.has"
  // self-tag case, and `dispatchChoice.ts`'s tag-mismatch cases too.
  it('§7.2’s two-step rule at a sealed position: a tag resolving nowhere is UNKNOWN_TYPE_REF in both encodings, never a "contradicts" validation error', () => {
    sameCodes(
      'kennel',
      '{ p: !nope { pet_type: dog  name: "Rex"  breed: "corgi" } }',
      '{"p": {"$type": "nope", "pet_type": "dog", "name": "Rex", "breed": "corgi"}}',
    );
  });

  it('a sealed position’s tag resolving to a real type outside the family is TYPE_MISMATCH in both encodings -- admissible somewhere, not admitted here', () => {
    sameCodes(
      'kennel',
      '{ p: !robot { pet_type: dog  name: "Rex"  breed: "corgi" } }',
      '{"p": {"$type": "robot", "pet_type": "dog", "name": "Rex", "breed": "corgi"}}',
    );
  });
});

// ── §6.5 maps ───────────────────────────────────────────────────────────────────────────────

describe('§6.5 maps', () => {
  it('a map entry value of the wrong shape', () => {
    sameVerdict('counts', '{ "a" => { b: 1 } }', '{"a": {"b": 1}}');
  });

  it('an entry value absent where values are required: _ in text, null in JSON, one verdict at one key', () => {
    sameRule('counts', '{ "a" => _ }', '{"a": null}');
  });

  it('a key the contract rejects -- §5.1’s boundary applied to a key token', () => {
    sameVerdict('by_date', '{ "not-a-date" => 12.5 }', '{"not-a-date": 12.5}');
  });

  it('§6.5: two spellings of one key (1, 1.0) are one key under a number key type, in both encodings', () => {
    sameRule('by_number', '{ 1 => "a"  1.0 => "b" }', '{"1": "a", "1.0": "b"}');
  });

  it('a compound key takes §6.5’s pairs form in JSON and the ordinary map form in text -- codes agree, pointers cannot', () => {
    sameCodes(
      'by_point',
      '{ { x: 1  y: 2 } => "a"  { y: 2  x: 1 } => "b" }',
      '[[{"x": 1, "y": 2}, "a"], [{"y": 2, "x": 1}, "b"]]',
    );
  });
});

// ── All-or-nothing, cross-encoding (a port of the Java reference's `AllOrNothingReadTest`,
// `tson-json/src/test/java/io/ltr8/tson/json/AllOrNothingReadTest.java`) ──────────────────────
//
// `aBindReadThatReportedAnythingReadsToNothingInBothEncodings` has no analogue: there is no
// `objectReader` here at all (`STATUS.md`'s own JSON section, and every other file in this suite
// that says the same).
//
// `aTokenRefusalLeavesNothingInEveryModeAndBothEncodings` still has no *cross-encoding* analogue,
// though the gap it used to be blocked on is now half-closed: `ReadJsonOptions.tokenPolicy`
// exists and is wired through (`json/schema/tokenHygiene.ts`, exercised in full by
// `json-token-policy.test.ts`'s own port of `JsonTokenPolicyTest`), but the Java case compares
// **four** modes -- TSON tree, TSON bind, JSON tree, JSON bind -- and none of the four map onto
// what this port can build a genuine four-way comparison from: TSON bind and JSON bind have no
// analogue at all (above), the *schemaless* TSON tree reader honours `tokenPolicy`
// (`reader/schemaless/tree.ts`) but this package's own schemaless JSON door deliberately does not
// (`STATUS.md`'s own "Known gaps": [TSON-JSON] §3.4 gives a schemaless JSON read no field names,
// no `$type`, no schema-typed position at all for a policy to reach), and the *schema-directed*
// TSON text reader (`compiler/compile.ts`) has no `tokenPolicy` wiring of its own to compare
// against either -- a separate, pre-existing gap outside this file's JSON-only scope. What
// **is** buildable and real is an all-or-nothing case within the JSON encoding alone, below.

describe('AllOrNothingReadTest: a token refusal leaves nothing (JSON only -- see the note above)', () => {
  it('a route whose name fails the token policy reads to nothing, with exactly the one refusal', () => {
    const CYRILLIC_A = 'а';
    const json = `{"name": "l${CYRILLIC_A}op", "stops": [{"x": 1, "y": 2}]}`;
    const result = validateJson(json, {
      schema: JSON_SCHEMA,
      root: 'route',
      tokenPolicy: tokenPolicy('ASCII_ONLY'),
    });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual(['RESTRICTED_SCRIPT']);
  });
});

describe('AllOrNothingReadTest: a read that reported anything reads to nothing, in both encodings', () => {
  const BAD_TSON = '{ name: loop  stops: [ { x: 1  y: 2 } { x: a  y: 2 } ] }';
  const BAD_JSON = '{"name": "loop", "stops": [{"x": 1, "y": 2}, {"x": "a", "y": 2}]}';

  it('a tree read refused two levels down reads to nothing in both encodings, at the same pointer', () => {
    const fromTson = validateText(bytesOf(BAD_TSON), { schema: TEXT_SCHEMA, root: 'route' });
    expect(fromTson.value).toBeUndefined();
    expect(fromTson.diagnostics.map((d) => d.path)).toEqual(['/stops/1/x']);

    const fromJson = validateJson(BAD_JSON, { schema: JSON_SCHEMA, root: 'route' });
    expect(fromJson.value).toBeUndefined();
    expect(fromJson.diagnostics.map((d) => d.path)).toEqual(['/stops/1/x']);
  });

  it('the same documents made valid read whole -- the nulls above are the rule, not a broken read', () => {
    const goodTson = BAD_TSON.replace('x: a', 'x: 3');
    const goodJson = BAD_JSON.replace('"x": "a"', '"x": 3');
    expect(
      validateText(bytesOf(goodTson), { schema: TEXT_SCHEMA, root: 'route' }).value,
    ).not.toBeUndefined();
    expect(
      validateJson(goodJson, { schema: JSON_SCHEMA, root: 'route' }).value,
    ).not.toBeUndefined();
  });
});
