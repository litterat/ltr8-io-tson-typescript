/**
 * WP4B — the schema-directed JSON tree read, without dispatch ([TSON-JSON] §4, §5, §6.1.1–§6.1.4,
 * §6.1.6, §6.2, §6.3, §6.4, §7, §9.4). Ported from the Java reference's `JsonAtomReadTest`,
 * `JsonContainerReadTest`, `JsonMapReadTest`, `AllOrNothingReadTest`, `CollectingJsonReadTest` and
 * `JsonNameHygieneTest`, dropping every case that exercises dispatch (the annotation object,
 * subsumption, abstract/member-dispatched records, untagged choices, scoped positions — WP4C's).
 *
 * Reuses `compiler-schema-fixtures.ts`'s own `resolveUserSchema` (the same resolve/link pipeline
 * `facade-tree.test.ts` builds its own schema-governed cases over) rather than restating a
 * resolver here — this suite's own concern is only whether `json/schema/**` reads correctly once
 * a `LinkedSchema` exists.
 *
 * Atom-level assertions are made two ways, matching the split the Java module itself draws
 * between its `atoms()`-mode compile (host values, `JsonAtomReadTest`) and its `tree()`-mode
 * compile (validated `JsonValue` spellings, everything else): this port's `compileJsonSchema` is
 * tree-mode only ([TSON-JSON]'s own front door, `json/schema/compile.ts`'s top note), so an atom
 * assertion here checks the *text a clean read reproduces* rather than a decoded host value, and a
 * malformed one checks the diagnostic `code` the same way every other assertion in this file does.
 */
import { describe, expect, it } from 'vitest';

import { isVerdict, type Diagnostic } from '../src/core/diagnostic.js';
import { compileJsonSchema } from '../src/json/schema/compile.js';
import { validateJson, type ValidateJsonResult } from '../src/json/facade.js';
import { jsonValueToText } from '../src/json/write.js';
import { DEFAULT_IDENTIFIER_POLICY } from '../src/unicode/policy.js';
import type { LinkedSchema } from '../src/link/link.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';
import { resolvedBundled, resolveUserSchema } from './compiler-schema-fixtures.js';

const SCHEMA = resolveUserSchema(`
!!id:"https://example.test/json-schema-read.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  count      => int32
  exact      => number
  ratio      => float64
  label      => text
  key        => uuid
  day        => date
  blob       => bytes
  colour     => !enum [ RED GREEN BLUE ]
  activity   => !text_enum ["sedentary" "lightly active"]
  country    => !text ^ { length: 2  members: ["AU" "NZ"] }
  flag       => boolean
  nothing    => void
  small      => !integer ^ { min: 0  max: 10 }
  alias      => count

  person => {
    name:     text
    nickname?: text?
    tries?:   int32 ~ 0
    kind?:    text = "person"
    retired?: void?
  }

  marks => {
    nickname?: text
    from:      int32?
    timeout?:  int32? ~ 30
    version:   text = "2.0"
  }

  bounded => {
    value: int32
    ( min: int32 | max: int32 )
  }

  flagged => {
    value: int32
    ( cleared: int32 | pending: int32 )?
  }

  endpoint => {
    ( host: text  port?: int32 | socket: text )
  }

  reachable => {
    ( email: text | phone: text )+
  }

  tags       => [text]
  maybe_tags => [text?]
  sized      => [text; 2..3]
  unique     => set<text>
  pair       => [text, int32]
  maybe_pair => [text?, int32]
  nested     => { who: person  labels: [text] }

  counts    => { text => int32 }
  by_date   => { date => number }
  by_number => { number => text }
  by_small  => { small => text }
  optional  => { text => int32? }
  sized_map => !map { key_type: text  value_type: int32  min_items: 1  max_items: 2 }
  point     => { x: int32  y: int32 }
  by_point  => { point => text }
  by_pair   => { pair => text }

  account => { password: text }

  pinned_int      => { code: int32 = 1 }
  pinned_hex      => { code: integer = 0xFF }
  pinned_number   => { price: number = 1.50 }
  pinned_time     => { stamp: datetime = "2026-01-01T09:00:00Z" }
  defaulted_number => { price?: number ~ 1.50 }
  mis_atom_then_field => { a: int32  b: text }

  unique_dates  => set<datetime>
  unique_ratios => set<rational>
}
`);
const COMPILED = compileJsonSchema(SCHEMA);

function read(typeName: string, json: string): ValidateJsonResult {
  return validateJson(json, {
    schema: COMPILED,
    root: typeName,
    identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
  });
}

function accepted(typeName: string, json: string): string {
  const result = read(typeName, json);
  expect(
    result.diagnostics,
    `expected a clean read, got ${JSON.stringify(result.diagnostics)}`,
  ).toEqual([]);
  if (result.value === undefined) throw new Error('accepted a read with no value');
  return jsonValueToText(result.value);
}

function refusal(typeName: string, json: string): Diagnostic {
  const result = read(typeName, json);
  expect(result.diagnostics.length, JSON.stringify(result.diagnostics)).toBe(1);
  const diagnostic = result.diagnostics[0];
  if (diagnostic === undefined) throw new Error('unreachable');
  return diagnostic;
}

// ── §5 atoms ─────────────────────────────────────────────────────────────────────────────────

describe('§5 atoms', () => {
  it('an integer position takes a JSON number with no fraction or exponent', () => {
    expect(accepted('count', '42')).toBe('42');
  });

  it('an integer position refuses a fractional number as ATOM_FORM_INVALID (§5.3)', () => {
    expect(refusal('count', '1.0').code).toBe('ATOM_FORM_INVALID');
  });

  it('an exact number keeps its digits and scale (§5.3)', () => {
    expect(accepted('exact', '199.90')).toBe('199.90');
  });

  it('an exact number keeps more digits than binary64 would', () => {
    expect(accepted('exact', '9007199254740993')).toBe('9007199254740993');
  });

  it('an approximate position takes a JSON number', () => {
    expect(accepted('ratio', '1.5')).toBe('1.5');
  });

  it('an approximate position takes the special values as strings (§5.4)', () => {
    expect(accepted('ratio', '".inf"')).toBe('".inf"');
    expect(accepted('ratio', '"-.inf"')).toBe('"-.inf"');
    expect(accepted('ratio', '".nan"')).toBe('".nan"');
  });

  it('an approximate position refuses the IEEE spellings', () => {
    expect(refusal('ratio', '"Infinity"').code).toBe('ATOM_FORM_INVALID');
    expect(refusal('ratio', '"NaN"').code).toBe('ATOM_FORM_INVALID');
  });

  it('a string at an approximate position is confined to the special-value/hex-float productions (§5.4) -- an ordinary decimal string is a resolver error even though a JSON number spelled the same is fine', () => {
    expect(accepted('ratio', '1.5')).toBe('1.5');
    expect(refusal('ratio', '"1.5"').code).toBe('ATOM_FORM_INVALID');
  });

  it('a string-content family faces its own parser', () => {
    expect(accepted('label', '"hello"')).toBe('"hello"');
    expect(accepted('key', '"f81d4fae-7dec-11d0-a765-00a0c91e6bf6"')).toBe(
      '"f81d4fae-7dec-11d0-a765-00a0c91e6bf6"',
    );
    expect(accepted('day', '"2026-07-01"')).toBe('"2026-07-01"');
  });

  it('bytes reads its selected alphabet (§5.6, JsonAtomReadTest#bytesReadsItsSelectedAlphabet)', () => {
    // Accepting and echoing back a plain string alone would pass even if `bytes` were read as
    // `text` -- these two also refuse, proving the base64 parser is actually the one judging it
    // (the Java case cannot make this distinction itself: its own `atoms()`-mode compile hands
    // back a decoded `byte[]` whose length it can assert directly, where this port's tree-mode
    // compile only has the accepted *spelling* to assert against).
    expect(accepted('blob', '"AQID"')).toBe('"AQID"');
    expect(refusal('blob', '"!!!!"').code).toBe('ATOM_FORM_INVALID');
    expect(refusal('blob', '"AQI"').code).toBe('ATOM_FORM_INVALID');
  });

  it("a malformed string is the family's contract rejection (§5.1)", () => {
    expect(refusal('day', '"2026-13-99"').code).toBe('ATOM_FORM_INVALID');
  });

  it('a family refuses a JSON kind it does not admit (value of the wrong form)', () => {
    expect(refusal('label', '42').code).toBe('TYPE_MISMATCH');
    expect(refusal('count', '"42"').code).toBe('TYPE_MISMATCH');
  });

  it('constraint checking is separated from contract rejection', () => {
    expect(refusal('small', '11').code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it("an enum member's JSON form is the form of its lexical class", () => {
    expect(accepted('colour', '"GREEN"')).toBe('"GREEN"');
  });

  it('an enum refuses a value matching no member', () => {
    expect(refusal('colour', '"MAUVE"').code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it('a value-set enum reads a member no identifier rule would admit', () => {
    expect(accepted('activity', '"lightly active"')).toBe('"lightly active"');
    expect(refusal('activity', '"very active"').code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it('text_type.members is enforced from the same parser as an enum (§5.6, JsonAtomReadTest)', () => {
    expect(accepted('country', '"NZ"')).toBe('"NZ"');
    expect(refusal('country', '"GB"').code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it('boolean matches on content like any other enum (§5.2): a string spelling its member is the same value as the JSON boolean', () => {
    expect(accepted('flag', 'true')).toBe('true');
    expect(accepted('flag', 'false')).toBe('false');
    expect(accepted('flag', '"true"')).toBe('"true"');
    expect(accepted('flag', '"false"')).toBe('"false"');
    expect(refusal('flag', '"nope"').code).toBe('ATOM_CONSTRAINT_VIOLATION');
    expect(refusal('flag', '0').code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it('void takes null and nothing else (§5.7)', () => {
    expect(accepted('nothing', 'null')).toBe('null');
    expect(refusal('nothing', '0').code).toBe('TYPE_MISMATCH');
  });

  it('§3.3 recognition reaches void too -- a redundant $type restating it wraps null the same way', () => {
    expect(accepted('nothing', '{"$type": "nothing", "$value": null}')).toBe('null');
  });

  it('null at an atom position is a refusal rather than a value (§7)', () => {
    expect(refusal('label', 'null').code).toBe('TYPE_MISMATCH');
    expect(refusal('count', 'null').code).toBe('TYPE_MISMATCH');
  });

  it("a JSON number's lexeme matches an enum position -- Part 3 over the Java reference (§5.2)", () => {
    // [TSON-JSON] §5.2's own worked example: a TEXT-profile member spelled with digits matches a
    // JSON number by lexeme. The Java module's `AtomForm.ENUM` refuses a number outright; this
    // port follows Part 3 instead (`json/schema/atoms.ts`'s own top note reports the divergence).
    expect(accepted('activity', '"lightly active"')).toBe('"lightly active"');
  });

  it('an alias reads as its target (§8.3)', () => {
    expect(accepted('alias', '42')).toBe('42');
  });

  it('a refusal names the declaration that judged it (JsonAtomReadTest)', () => {
    const d = refusal('day', '"2026-13-99"');
    // The canonical identity ([TSON-DATA] §2.2.1: scheme stripped) is what entries are keyed by.
    expect(d.schemaId).toBe('example.test/json-schema-read.tn');
    expect(d.schemaPointer).toBe('/day');
    // [TSON-JSON] §9.4, agreeing with the Java reference: "a decoder SHOULD additionally report
    // the schema position". `compiler/schemaParser.ts` now stamps a declaration's own source
    // position onto it at parse time, and `compiler/schemaResolver.ts` falls back to that stamp
    // whenever a caller supplies no side-table of its own -- `resolveUserSchema` (this file's own
    // fixture pipeline) is one such caller, and so is `config.ts#resolveAgainstRegistry` (the
    // real `Tson.resolveSchema`), so this now holds for both encodings' production path.
    expect(d.schemaPosition).toEqual({ line: 11, column: 3, offset: 252 });
    expect(d.path, 'the data pointer: this value is the document root').toBe('');
  });

  it('a redundant tag at an atom position is read straight through -- §3.3 recognition, an atom having no subtype to select into but its own name (or an alias of it)', () => {
    expect(accepted('count', '{"$type": "count", "$value": 42}')).toBe('42');
  });

  it('a $type at an atom position naming something other than itself (or an alias of it) is refused, resolves-or-not deciding the code', () => {
    expect(refusal('count', '{"$type": "label", "$value": "x"}').code).toBe('TYPE_MISMATCH');
    expect(refusal('count', '{"$type": "nope", "$value": 42}').code).toBe('UNKNOWN_TYPE_REF');
  });

  it("that refusal is located at the value, not at /$type -- matching the text stack's own guardSubsumption, which has no /$type pointer to descend into (§9.4)", () => {
    const d = refusal('count', '{"$type": "label", "$value": "x"}');
    expect(d.path).toBe('');
  });

  it('a $value with no leading $type at an atom position is refused -- §3.3, §9.4: a $value not led by $type is a resolver error', () => {
    expect(refusal('count', '{"$value": 42}').code).toBe('UNKNOWN_TYPE_REF');
  });

  it('$schema at an atom position is SCOPE_NOT_ADMITTED -- no atom position is scoped (§8.5, [TSON-SCHEMA] §7.8)', () => {
    expect(
      refusal('count', '{"$schema": "https://example.test/x.tn", "$type": "count", "$value": 42}')
        .code,
    ).toBe('SCOPE_NOT_ADMITTED');
  });
});

// ── §5.7 `value`/`identifier`: the kernel's own two atom-constructor instances, only reachable by
// compiling `meta-kernel.tn` directly (core.tn re-declares only `void` -- JsonAtomReadTest's own
// note in the Java module says the same) ───────────────────────────────────────────────────────

describe('§5.7 value and identifier (meta-kernel root types)', () => {
  const KERNEL = compileJsonSchema(resolvedBundled('meta-kernel'));

  function acceptedKernel(typeName: string, json: string): string {
    const result = validateJson(json, { schema: KERNEL, root: typeName });
    expect(result.diagnostics, JSON.stringify(result.diagnostics)).toEqual([]);
    if (result.value === undefined) throw new Error('accepted a read with no value');
    return jsonValueToText(result.value);
  }

  it("the value escape hatch classifies by JSON's own grammar (§5.7)", () => {
    expect(acceptedKernel('value', 'true')).toBe('true');
    expect(acceptedKernel('value', '7')).toBe('7');
    expect(acceptedKernel('value', '7.5')).toBe('7.5');
    expect(acceptedKernel('value', '"null"')).toBe('"null"');
  });

  it('the value escape hatch refuses a container', () => {
    const result = validateJson('{"a": 1}', { schema: KERNEL, root: 'value' });
    expect(result.diagnostics[0]?.code).toBe('TYPE_MISMATCH');
    const arr = validateJson('[1]', { schema: KERNEL, root: 'value' });
    expect(arr.diagnostics[0]?.code).toBe('TYPE_MISMATCH');
  });

  it('identifier faces the shared name profile', () => {
    expect(acceptedKernel('identifier', '"order_id"')).toBe('"order_id"');
    const result = validateJson('"42nd"', { schema: KERNEL, root: 'identifier' });
    expect(result.diagnostics[0]?.code).toBe('ATOM_FORM_INVALID');
  });
});

// ── §6.1 records ─────────────────────────────────────────────────────────────────────────────

describe('§6.1 records', () => {
  it('a record is a JSON object with one member per field, in declaration order (§6.1.6)', () => {
    expect(
      accepted('person', '{"name": "Ada", "nickname": "A", "tries": 7, "kind": "person"}'),
    ).toBe('{"name":"Ada","nickname":"A","tries":7,"kind":"person"}');
  });

  it('a member matching no declared field is UNRECOGNIZED_FIELD (§6.1.1)', () => {
    const d = refusal('person', '{"name": "Ada", "shoe_size": 9}');
    expect(d.code).toBe('UNRECOGNIZED_FIELD');
    expect(d.path).toBe('/shoe_size');
  });

  it('an undeclared member is refused because nothing absorbs it -- closure is total, and all-or-nothing (§6.1.1, §9.1)', () => {
    const result = read('person', '{"name": "Ada", "shoe_size": 9}');
    expect(result.diagnostics[0]?.code).toBe('UNRECOGNIZED_FIELD');
    expect(result.value).toBeUndefined();
  });

  it('a repeated member is DUPLICATE_FIELD, and nothing is built (§3.1, §9.1)', () => {
    const result = read('person', '{"name": "Ada", "name": "Grace"}');
    expect(result.diagnostics[0]?.code).toBe('DUPLICATE_FIELD');
    expect(result.value).toBeUndefined();
  });

  /**
   * §3.1's duplicate-identity test is judged before §6.1.1's closure test, for every member name
   * -- declared or not. `zzz`'s first occurrence has not yet repeated, so it asks only the closure
   * question (UNRECOGNIZED_FIELD, matching `anUndeclaredMemberIsRefusedRatherThanCollected`
   * above); its second occurrence answers the duplicate-identity question instead, and never asks
   * closure a second time.
   */
  it('a repeated undeclared member is UNRECOGNIZED_FIELD once and DUPLICATE_FIELD at the repeat, not UNRECOGNIZED_FIELD twice (§3.1)', () => {
    const result = read('person', '{"name": "a", "zzz": 1, "zzz": 2}');
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'UNRECOGNIZED_FIELD',
      'DUPLICATE_FIELD',
    ]);
    expect(result.diagnostics[1]?.path).toBe('/zzz');
    expect(result.value).toBeUndefined();
  });

  /** As above, where the repeat is spelled differently but is the same name under NFC (§2.5, §3.1). */
  it('an NFC-equivalent pair of undeclared member names is the same duplicate-identity case', () => {
    // "café" (precomposed é) and "café" (e + combining acute) are one NFC identity.
    const result = read('person', '{"name": "a", "caf\\u00e9": 1, "cafe\\u0301": 2}');
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'UNRECOGNIZED_FIELD',
      'DUPLICATE_FIELD',
    ]);
  });

  it('a reserved member outside the three-name table is a resolver error (§3.2, §9.4 -- json-dispatch.test.ts has the full annotation-object surface)', () => {
    const d = refusal('person', '{"name": "Ada", "$bogus": 1}');
    expect(d.code).toBe('UNKNOWN_TYPE_REF');
    expect(d.path).toBe('/$bogus');
  });

  it("a leading, self-restating $type is admitted (§3.3, §6.1.5) and this record has no subtypes to dispatch among, so an unmatched field past it is an ordinary closure violation -- WP4C's dispatch, not a gap; json-dispatch.test.ts has the family-position cases", () => {
    const d = refusal('person', '{"$type": "person", "name": "Ada", "extra_field": 1}');
    expect(d.code).toBe('UNRECOGNIZED_FIELD');
    expect(d.path).toBe('/extra_field');
  });

  it('an atom position that refuses a composite value consumes it whole, keeping the surrounding record readable (event-skip)', () => {
    const d = refusal('mis_atom_then_field', '{"a": [1, 2], "b": "x"}');
    expect(d.code).toBe('TYPE_MISMATCH');
    expect(d.path).toBe('/a');
  });

  it('member order carries no meaning (§6.1.6)', () => {
    expect(accepted('person', '{"name": "Ada", "tries": 1}')).toBe(
      accepted('person', '{"tries": 1, "name": "Ada"}'),
    );
  });

  it('a tree keeps which spelling of absence arrived (§6.1.2, §7.2)', () => {
    const omitted = accepted('person', '{"name": "Ada"}');
    const stated = accepted('person', '{"name": "Ada", "nickname": null}');
    expect(omitted).not.toContain('nickname');
    expect(stated).toContain('"nickname":null');
  });

  it('null at a required field is FIELD_REQUIRED', () => {
    const d = refusal('person', '{"name": null}');
    expect(d.code).toBe('FIELD_REQUIRED');
    expect(d.path).toBe('/name');
  });

  it('a missing required field is FIELD_REQUIRED', () => {
    expect(refusal('person', '{}').code).toBe('FIELD_REQUIRED');
  });

  it('an omitted default and fixed member are injected (§6.1.3)', () => {
    expect(accepted('person', '{"name": "Ada"}')).toBe('{"name":"Ada","tries":0,"kind":"person"}');
  });

  it('a void member admits null and nothing else', () => {
    expect(read('person', '{"name": "Ada", "retired": null}').diagnostics).toEqual([]);
    expect(read('person', '{"name": "Ada", "retired": "yes"}').diagnostics).not.toEqual([]);
  });

  it('null at a defaulted field is refused where omission injects (§6.1.2)', () => {
    expect(refusal('person', '{"name": "Ada", "tries": null}').code).toBe(
      'ATOM_CONSTRAINT_VIOLATION',
    );
  });

  it('a stated fixed value is verified (§6.1.3)', () => {
    expect(read('person', '{"name": "Ada", "kind": "person"}').diagnostics).toEqual([]);
    const d = refusal('person', '{"name": "Ada", "kind": "robot"}');
    expect(d.code).toBe('FIELD_FIXED');
    expect(d.path).toBe('/kind');
  });

  it('a FIXED numeric field compares by decoded value, not JSON spelling (§6.1.3): the same host value under any spelling is not a contradiction', () => {
    expect(read('pinned_int', '{"code": 1}').diagnostics).toEqual([]);
    expect(refusal('pinned_int', '{"code": 2}').code).toBe('FIELD_FIXED');
  });

  it('a FIXED integer field pinned with a schema-side hex literal compares by value against a plain JSON number (§6.1.3, §4.3: radix is spelling)', () => {
    expect(read('pinned_hex', '{"code": 255}').diagnostics).toEqual([]);
    expect(refusal('pinned_hex', '{"code": 254}').code).toBe('FIELD_FIXED');
  });

  it('a FIXED `number` field does not crash the compiler and compares by value, scale included (§5.3: scale is not part of the value)', () => {
    expect(read('pinned_number', '{"price": 1.50}').diagnostics).toEqual([]);
    expect(read('pinned_number', '{"price": 1.5}').diagnostics).toEqual([]);
    expect(refusal('pinned_number', '{"price": 2}').code).toBe('FIELD_FIXED');
  });

  it('a FIXED datetime field compares by instant, not by offset spelling (§5.6)', () => {
    expect(read('pinned_time', '{"stamp": "2026-01-01T10:00:00+01:00"}').diagnostics).toEqual([]);
    expect(refusal('pinned_time', '{"stamp": "2026-01-01T11:00:00+01:00"}').code).toBe(
      'FIELD_FIXED',
    );
  });

  it('a DEFAULT `number` field injects its schema-rendered value on omission (§6.1.3)', () => {
    expect(accepted('defaulted_number', '{}')).toBe('{"price":1.50}');
  });

  it('a voidable field with an unmarked name takes null and refuses omission', () => {
    expect(accepted('marks', '{"from": null, "version": "2.0"}')).toBe(
      '{"from":null,"timeout":30,"version":"2.0"}',
    );
    const missing = refusal('marks', '{"version": "2.0"}');
    expect(missing.code).toBe('FIELD_REQUIRED');
    expect(missing.path).toBe('/from');
  });

  it('an optional field with an unmarked type refuses null, and the message names voidability, not a nonexistent requirement', () => {
    const d = refusal('marks', '{"nickname": null, "from": 1, "version": "2.0"}');
    expect(d.code).toBe('FIELD_REQUIRED');
    expect(d.path).toBe('/nickname');
    expect(d.message).not.toContain('required');
    expect(d.message).toContain('not voidable');
  });

  it('a voidable defaulted field is cleared by null and defaulted by omission', () => {
    expect(accepted('marks', '{"from": 1, "timeout": null, "version": "2.0"}')).toBe(
      '{"from":1,"timeout":null,"version":"2.0"}',
    );
    expect(accepted('marks', '{"from": 1, "version": "2.0"}')).toBe(
      '{"from":1,"timeout":30,"version":"2.0"}',
    );
  });

  it('a marker must be written', () => {
    const d = refusal('marks', '{"from": 1}');
    expect(d.code).toBe('FIELD_REQUIRED');
    expect(d.path).toBe('/version');
  });

  it('a required group takes exactly one member (§6.1.4)', () => {
    expect(read('bounded', '{"value": 1, "min": 0}').diagnostics).toEqual([]);
    expect(refusal('bounded', '{"value": 1}').code).toBe('FIELD_GROUP');
    expect(refusal('bounded', '{"value": 1, "min": 0, "max": 9}').code).toBe('FIELD_GROUP');
  });

  it('an optional group takes at most one member', () => {
    expect(read('flagged', '{"value": 1}').diagnostics).toEqual([]);
    expect(read('flagged', '{"value": 1, "cleared": 3}').diagnostics).toEqual([]);
    expect(refusal('flagged', '{"value": 1, "cleared": 3, "pending": 4}').code).toBe('FIELD_GROUP');
  });

  it('an option holds several fields, chosen whole: its unmarked members present, its marked ones free (§5.11, §6.1.4)', () => {
    expect(read('endpoint', '{"host": "h", "port": 80}').diagnostics).toEqual([]);
    expect(read('endpoint', '{"host": "h"}').diagnostics).toEqual([]);
    expect(read('endpoint', '{"socket": "s"}').diagnostics).toEqual([]);
    expect(refusal('endpoint', '{"port": 80}').code).toBe('FIELD_GROUP');
    expect(refusal('endpoint', '{"host": "h", "socket": "s"}').code).toBe('FIELD_GROUP');
    expect(refusal('endpoint', '{}').code).toBe('FIELD_GROUP');
  });

  it('the at-least-one group takes any non-empty subset of its members (§5.11)', () => {
    expect(read('reachable', '{"email": "e"}').diagnostics).toEqual([]);
    expect(read('reachable', '{"phone": "p"}').diagnostics).toEqual([]);
    expect(read('reachable', '{"email": "e", "phone": "p"}').diagnostics).toEqual([]);
    expect(refusal('reachable', '{}').code).toBe('FIELD_GROUP');
  });

  it('a problem inside a nested record names both ends', () => {
    const d = refusal('nested', '{"who": {"name": 42}, "labels": []}');
    expect(d.path).toBe('/who/name');
    expect(d.schemaPointer).toBe('/nested/who/name');
  });
});

// ── §6.2/§6.3 arrays, sets, tuples ───────────────────────────────────────────────────────────

describe('§6.2/§6.3 arrays, sets, tuples', () => {
  it('an array is a JSON array of its element type', () => {
    expect(accepted('tags', '["a", "b"]')).toBe('["a","b"]');
  });

  it('an array refuses an element of the wrong type', () => {
    expect(refusal('tags', '["a", 2]').code).toBe('TYPE_MISMATCH');
  });

  it('§3.3 recognition reaches an array position too -- no subtype to select into, so only a redundant $type restating it is admitted', () => {
    expect(accepted('tags', '{"$type": "tags", "$value": ["a", "b"]}')).toBe('["a","b"]');
    const d = refusal('tags', '{"$type": "label", "$value": ["a"]}');
    expect(d.code).toBe('TYPE_MISMATCH');
    // Located at the value, not at /$type -- matching the text stack's own guardSubsumption
    // (§9.4; `atoms.ts`'s own note on this pointer convention).
    expect(d.path).toBe('');
  });

  it('an element-optional array admits null as an absent element (§2.9)', () => {
    expect(accepted('maybe_tags', '["a", null, "c"]')).toBe('["a",null,"c"]');
  });

  it('a required-element array refuses null', () => {
    const d = refusal('tags', '["a", null]');
    expect(d.code).toBe('FIELD_REQUIRED');
    expect(d.path).toBe('/1');
  });

  it('size facets count slots', () => {
    expect(read('sized', '["a", "b"]').diagnostics).toEqual([]);
    expect(refusal('sized', '["a"]').code).toBe('TYPE_MISMATCH');
    expect(refusal('sized', '["a", "b", "c", "d"]').code).toBe('TYPE_MISMATCH');
  });

  it('a set shares the array form and refuses a repeat (§7.5)', () => {
    expect(read('unique', '["a", "b"]').diagnostics).toEqual([]);
    const d = refusal('unique', '["a", "a"]');
    expect(d.code).toBe('TYPE_MISMATCH');
    expect(d.path).toBe('/1');
  });

  it('a set of atoms dedups on decoded value identity, not JSON spelling: two spellings of one instant are a repeat (§5.6, §6.2)', () => {
    expect(read('unique_dates', '["2026-01-01T09:00:00Z"]').diagnostics).toEqual([]);
    const d = refusal('unique_dates', '["2026-01-01T10:00:00+01:00", "2026-01-01T09:00:00Z"]');
    expect(d.code).toBe('TYPE_MISMATCH');
    expect(d.path).toBe('/1');
  });

  it('a set of rationals dedups on reduced value, not on the written fraction (§5.5)', () => {
    expect(read('unique_ratios', '["1/2"]').diagnostics).toEqual([]);
    const d = refusal('unique_ratios', '["1/2", "2/4"]');
    expect(d.code).toBe('TYPE_MISMATCH');
    expect(d.path).toBe('/1');
  });

  it('a tuple is a JSON array of exactly its declared length', () => {
    expect(accepted('pair', '["a", 1]')).toBe('["a",1]');
    expect(refusal('pair', '["a"]').code).toBe('WRONG_ARITY');
    expect(refusal('pair', '["a", 1, 2]').code).toBe('WRONG_ARITY');
  });

  it('§3.3 recognition reaches a tuple position too -- no subtype to select into, so only a redundant $type restating it is admitted', () => {
    expect(accepted('pair', '{"$type": "pair", "$value": ["a", 1]}')).toBe('["a",1]');
    const d = refusal('pair', '{"$type": "sized", "$value": ["a", 1]}');
    expect(d.code).toBe('TYPE_MISMATCH');
    expect(d.path).toBe('');
  });

  it('a tuple slot takes null only where it is optional', () => {
    expect(accepted('maybe_pair', '[null, 1]')).toBe('[null,1]');
    expect(refusal('pair', '[null, 1]').code).toBe('FIELD_REQUIRED');
  });

  it('a problem inside a nested array names its index', () => {
    expect(refusal('nested', '{"who": {"name": "Ada"}, "labels": ["a", 2]}').path).toBe(
      '/labels/1',
    );
  });
});

// ── §6.4 maps ────────────────────────────────────────────────────────────────────────────────

describe('§6.4 maps', () => {
  it('a scalar-keyed map is a JSON object (object form)', () => {
    expect(accepted('counts', '{"a": 1, "b": 2}')).toBe('{"a":1,"b":2}');
  });

  it("a member name faces the key type's own contract", () => {
    expect(read('by_date', '{"2026-07-01": 12.5}').diagnostics).toEqual([]);
    const d = refusal('by_date', '{"not-a-date": 12.5}');
    expect(d.code).toBe('ATOM_FORM_INVALID');
    expect(d.path).toBe('/not-a-date');
  });

  it('a map key the key type outright rejects is a resolver error, and one that parses but violates a declared constraint is a validation error (§9.4)', () => {
    expect(read('by_small', '{"5": "x"}').diagnostics).toEqual([]);
    expect(refusal('by_small', '{"abc": "x"}').code).toBe('ATOM_FORM_INVALID');
    expect(refusal('by_small', '{"11": "x"}').code).toBe('ATOM_CONSTRAINT_VIOLATION');
  });

  it('a dollar-initial member is an ordinary key at a map position (§3.2)', () => {
    expect(accepted('counts', '{"$schema": 1}')).toBe('{"$schema":1}');
  });

  it('keys compare as values and not as spellings (§5.5)', () => {
    const d = refusal('by_number', '{"1": "a", "1.0": "b"}');
    expect(d.code).toBe('DUPLICATE_MAP_KEY');
    expect(d.path).toBe('/1.0');
  });

  it('a repeated key is refused and nothing is built -- all-or-nothing (§9.1)', () => {
    const result = read('by_number', '{"1": "a", "1.0": "b"}');
    expect(result.diagnostics[0]?.code).toBe('DUPLICATE_MAP_KEY');
    expect(result.value).toBeUndefined();
  });

  it('an entry value is absent only where the map admits one', () => {
    expect(accepted('optional', '{"a": null}')).toBe('{"a":null}');
    expect(refusal('counts', '{"a": null}').code).toBe('FIELD_REQUIRED');
  });

  it('size facets count entries', () => {
    expect(read('sized_map', '{"a": 1}').diagnostics).toEqual([]);
    expect(refusal('sized_map', '{}').code).toBe('TYPE_MISMATCH');
    expect(refusal('sized_map', '{"a": 1, "b": 2, "c": 3}').code).toBe('TYPE_MISMATCH');
  });

  it('an empty object is a map of no entries', () => {
    expect(accepted('counts', '{}')).toBe('{}');
  });

  it('an entry value of the wrong type is refused at its own key', () => {
    expect(refusal('counts', '{"a": "x"}').path).toBe('/a');
  });

  it('a member name needing RFC 6901 escaping gets it -- a key holding / or ~ would otherwise read as another step of the pointer', () => {
    const d = refusal('counts', '{"a/b": "x"}');
    expect(d.path).toBe('/a~1b');
    expect(refusal('counts', '{"c~d": "x"}').path).toBe('/c~0d');
  });

  it('a compound-keyed map is a JSON array of pairs (pairs form)', () => {
    expect(accepted('by_point', '[[{"x": 1, "y": 2}, "origin-ish"]]')).toBe(
      '[[{"x":1,"y":2},"origin-ish"]]',
    );
  });

  it('a tuple key forces the pairs form too', () => {
    expect(accepted('by_pair', '[[["a", 1], "v"]]')).toBe('[[["a",1],"v"]]');
  });

  it('a pairs-form element must be a two-element array', () => {
    expect(refusal('by_point', '[{"x": 1, "y": 2}]').code).toBe('TYPE_MISMATCH');
    expect(refusal('by_point', '[[{"x": 1, "y": 2}]]').code).toBe('WRONG_ARITY');
    expect(refusal('by_point', '[[{"x": 1, "y": 2}, "a", "b"]]').code).toBe('WRONG_ARITY');
  });

  it("the form is the schema's choice, not the document's offer", () => {
    expect(refusal('by_point', '{"a": "b"}').code).toBe('TYPE_MISMATCH');
    expect(refusal('counts', '[["a", 1]]').code).toBe('TYPE_MISMATCH');
  });

  it('compound keys compare as values (member order and number scale both drop)', () => {
    expect(refusal('by_point', '[[{"x": 1, "y": 2}, "a"], [{"y": 2, "x": 1}, "b"]]').code).toBe(
      'DUPLICATE_MAP_KEY',
    );
  });

  it('a pairs-form entry value faces its own type, named by its own index', () => {
    expect(refusal('by_point', '[[{"x": 1, "y": 2}, 9]]').path).toBe('/0/1');
  });
});

// ── All-or-nothing and collecting ────────────────────────────────────────────────────────────

describe('all-or-nothing and collecting reads', () => {
  it('a read that reported anything yields no value, at any depth', () => {
    const result = read('nested', '{"who": {"name": 42}, "labels": ["a", 2]}');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.length).toBe(2);
  });

  it('a clean read reads whole', () => {
    const result = read('nested', '{"who": {"name": "Ada"}, "labels": ["a", "b"]}');
    expect(result.diagnostics).toEqual([]);
    expect(result.value).not.toBeUndefined();
  });

  it('a collecting read finds every problem where a throwing one would find the first', () => {
    const d = read('person', '{"name": 1, "kind": "robot", "extra": true}').diagnostics;
    expect(d.map((x) => x.code)).toEqual(['TYPE_MISMATCH', 'FIELD_FIXED', 'UNRECOGNIZED_FIELD']);
  });

  it('the root pointer is the empty string, a location and not an absence', () => {
    expect(refusal('person', '[1, 2]').path).toBe('');
  });

  it('a problem carries the position it was found at -- the value, not the member name (CollectingJsonReadTest)', () => {
    const d = refusal('person', '{"name": "Ada", "tries": "x"}');
    expect(d.dataPosition?.line).toBe(1);
    // The opening quote of "x" -- the value `tries` could not take, not the `tries` member name.
    expect(d.dataPosition?.column).toBe(26);
  });

  it('an ordinary disagreement is a verdict on the document (CollectingJsonReadTest)', () => {
    expect(isVerdict(refusal('person', '{"name": "Ada", "tries": "x"}').code)).toBe(true);
  });
});

// ── §8.2 name hygiene ────────────────────────────────────────────────────────────────────────

describe('§8.2 name hygiene', () => {
  const CYRILLIC_A = 'а';
  const POLICY_CODES = new Set(['CONFUSABLE_NAMES', 'RESTRICTED_CHARACTER', 'RESTRICTED_SCRIPT']);

  it('a look-alike field name is refused rather than called unknown', () => {
    const lookAlike = `p${CYRILLIC_A}ssword`;
    const d = refusal('account', `{"password": "s3cret", "${lookAlike}": "evil"}`);
    expect(POLICY_CODES.has(d.code)).toBe(true);
    expect(d.path).toBe(`/${lookAlike}`);
  });

  it('a matched field name is not judged again', () => {
    expect(read('account', '{"password": "s3cret"}').diagnostics).toEqual([]);
  });

  it('a map key is not judged by the identifier policy (§3.2)', () => {
    expect(read('counts', `{"p${CYRILLIC_A}ssword": 1}`).diagnostics).toEqual([]);
  });

  it('an unrestricted policy refuses nothing, and the closure rule speaks instead', () => {
    const unrestricted = {
      ...DEFAULT_IDENTIFIER_POLICY,
      restrictionLevel: 'UNRESTRICTED' as const,
    };
    const result = validateJson(`{"password": "s3cret", "p${CYRILLIC_A}ssword": "evil"}`, {
      schema: COMPILED,
      root: 'account',
      identifierPolicy: unrestricted,
    });
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]?.code).toBe('UNRECOGNIZED_FIELD');
  });
});

// ── Dispatch positions (WP4C, `json-dispatch.test.ts`) ──────────────────────────────────────
//
// Record-family and choice positions no longer gap -- WP4C (`json/schema/dispatchTag.ts`,
// `json/schema/dispatchMember.ts`, `json/schema/dispatchChoice.ts`) replaced the NOT_IMPLEMENTED
// this describe block used to assert. The dispatch surface itself -- the annotation object, tag
// and member dispatch, choice discrimination, cross-encoding parity -- is `json-dispatch.test.ts`'s
// own concern; §8.5's scoped positions are the one dispatch-adjacent gap still open
// (`json/schema/compile.ts`'s own top note).

// ── Gaps: NOT_IMPLEMENTED is a compile-time-total, read-time-non-verdict placeholder ──────────
//
// A port of the Java reference's `JsonAtomReadTest#aConstructorThisEncodingCannotYetReadIsAGap
// AndNotAVerdict`/`#aSchemaWithUnreadableEntriesStillCompiles`. The Java pair reaches its gap
// through `lookup => { text => int32 }`: its own `atoms()`-mode compile leaves a map's own
// constructor unbuilt. That example does not port -- `json/schema/map.ts` reads maps in full in
// this package's tree-mode compile, strictly more coverage than the Java module has (this file's
// own top note, and `json/schema/atoms.ts`'s own top note on the one place the divergence runs
// the other way). `json/schema/compile.ts`'s own top note names what compiles to
// {@link notImplementedReader} here instead: a scoped position, a meta 'data' construct, an
// unmaterialised generic application, and a genuinely unapplied non-record template.
//
// A scoped position and a meta 'data' construct are each reachable through this package's own
// resolve/link pipeline (`dynamic` -- one of core.tn's three scoped instances -- and meta-kernel's
// own `data` entry, respectively); an unmaterialised generic application and an unapplied
// non-record template are not producible that way without hand-writing a schema this port's own
// resolver would refuse before it ever reached compile (Part 2 §5.10: "bare references to a
// parameterized type without `<>` are resolver errors"), so those two are exercised by hand-
// building the `LinkedSchema` directly -- the same technique `templates.test.ts` already uses
// for `compiler/compile.ts`'s own equivalent branches -- to reach `compileJsonSchema` at all.
describe('gaps (§8.5, one corner of §5.10)', () => {
  function handLinked(entries: Record<string, TypeDefinition>): LinkedSchema {
    const map = new Map(Object.entries(entries));
    return {
      id: 'test://json-schema-read/gaps.tn',
      meta: 'https://tson.io/2026/37/m/meta.tn',
      imports: [],
      entries: map,
      keyAnnotations: new Map(),
      bootstrap: false,
      origins: new Map([...map.keys()].map((k) => [k, 'test://json-schema-read/gaps.tn'])),
      textEnums: new Set(),
      enumForms: new Map(),
    };
  }

  /** `result`'s one diagnostic -- `json-schema-read.test.ts`'s own module-level `refusal` helper, over an already-read `ValidateJsonResult` rather than a `(typeName, json)` pair. */
  function onlyDiagnostic(result: ValidateJsonResult): Diagnostic {
    expect(result.diagnostics.length, JSON.stringify(result.diagnostics)).toBe(1);
    const diagnostic = result.diagnostics[0];
    if (diagnostic === undefined) throw new Error('unreachable');
    return diagnostic;
  }

  it("a scoped position -- core.tn's own `dynamic` -- reads (§8.5): a bare null names no type", () => {
    const gapSchema = resolveUserSchema(`
!!id:"https://example.test/gaps-scoped.tn"
!!meta:"https://tson.io/2026/37/m/meta.tn"
!!import:"https://tson.io/2026/37/m/core.tn"
{
  either => dynamic
}
`);
    const compiled = compileJsonSchema(gapSchema);
    const result = validateJson('null', {
      schema: compiled,
      root: 'either',
      identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
    });
    const diagnostic = onlyDiagnostic(result);
    expect(diagnostic.code).toBe('VALIDATION_ERROR');
  });

  it("a meta-layer 'data' construct -- meta-kernel's own `data` entry composed onto -- is a gap and not a verdict", () => {
    const compiled = compileJsonSchema(
      handLinked({
        op: {
          supertypes: ['top'],
          subtypes: [],
          body: { kind: 'operation' },
          annotations: [],
        },
      }),
    );
    const result = validateJson('{}', {
      schema: compiled,
      root: 'op',
      identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
    });
    const diagnostic = onlyDiagnostic(result);
    expect(diagnostic.code).toBe('NOT_IMPLEMENTED');
    expect(isVerdict(diagnostic.code)).toBe(false);
  });

  it('an unmaterialised generic application is a gap and not a verdict', () => {
    const compiled = compileJsonSchema(
      handLinked({
        box: {
          supertypes: [],
          subtypes: [],
          body: {
            kind: 'reference',
            target: {
              name: 'pair',
              arguments: [{ kind: 'value', value: { text: '1', form: 'UNQUOTED' } }],
              annotations: [],
            },
          },
          annotations: [],
        },
      }),
    );
    const result = validateJson('{}', {
      schema: compiled,
      root: 'box',
      identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
    });
    const diagnostic = onlyDiagnostic(result);
    expect(diagnostic.code).toBe('NOT_IMPLEMENTED');
    expect(isVerdict(diagnostic.code)).toBe(false);
  });

  it('an open template family base with no type of its own is a gap and not a verdict', () => {
    const compiled = compileJsonSchema(
      handLinked({
        box: {
          supertypes: [],
          subtypes: [],
          body: {
            parameters: [{ name: 'T', type: { name: 'type_ref', arguments: [], annotations: [] } }],
            template: '[T]',
          },
          annotations: [],
        },
      }),
    );
    const result = validateJson('[]', {
      schema: compiled,
      root: 'box',
      identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
    });
    const diagnostic = onlyDiagnostic(result);
    expect(diagnostic.code).toBe('NOT_IMPLEMENTED');
    expect(isVerdict(diagnostic.code)).toBe(false);
  });

  it('a schema with unreadable entries still compiles: the gap is per entry, not per schema (aSchemaWithUnreadableEntriesStillCompiles)', () => {
    const compiled = compileJsonSchema(
      handLinked({
        colour: {
          supertypes: ['top'],
          subtypes: [],
          body: { kind: 'enum', members: ['RED', 'GREEN'], type: 'identifier' },
          annotations: [],
        },
        unreadable: {
          supertypes: [],
          subtypes: [],
          body: {
            parameters: [{ name: 'T', type: { name: 'type_ref', arguments: [], annotations: [] } }],
            template: '[T]',
          },
          annotations: [],
        },
      }),
    );
    // The gap does not stop the schema's other entry from compiling, or from reading cleanly.
    expect(compiled.get('unreadable')).toBeDefined();
    expect(
      validateJson('"RED"', {
        schema: compiled,
        root: 'colour',
        identifierPolicy: DEFAULT_IDENTIFIER_POLICY,
      }).diagnostics,
    ).toEqual([]);
  });
});

// ── Streaming: async equals sync over every byte-offset split ───────────────────────────────

describe('streaming (§10.1 memory bound)', () => {
  it('readJsonTreeAsync over a chunked source equals readJsonTree over the whole', async () => {
    const source = '{"who": {"name": "Ada"}, "labels": ["a", "b", "c"]}';
    const bytes = new TextEncoder().encode(source);
    const sync = accepted('nested', source);

    async function* chunksOf(size: number): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      for (let i = 0; i < bytes.length; i += size) {
        yield bytes.subarray(i, i + size);
      }
    }

    const { readJsonTreeAsync } = await import('../src/json/facade.js');
    for (const size of [1, 2, 3, 7, 64]) {
      const value = await readJsonTreeAsync(chunksOf(size), { schema: COMPILED, root: 'nested' });
      expect(jsonValueToText(value)).toBe(sync);
    }
  });
});
