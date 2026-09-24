import { describe, expect, it } from 'vitest';

import { compile, validate, type CompiledSchema } from '../src/compiler/compile.js';
import type { LinkedSchema } from '../src/link/link.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';

/**
 * `compiler/subsumption.ts` -- §7.2's rule that a value's own `!type-ref` must be admitted by the
 * position it stands in, enforced at every position the rule governs. Mirrors the reference
 * implementation's own `SubsumptionAtTypedPositionsTest`
 * (`tson-compiler/.../compiler/SubsumptionAtTypedPositionsTest.java`): the same schema shape, the
 * same scenarios, `validate`'s collected diagnostics standing in for its own `TsonReadException`
 * message assertions.
 */

const USER_SCHEMA = `
!!id:"test://subsumption.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  person    => { name: text }
  employee  => person & { badge: text }
  holder    => { t: text  r: person  a: [text]  m: {text => text} }
  base      => { name: text }
  h         => { f: base }
  other     => base
  h2        => { f: other }
  mail_addr => { address: text }
  phone_no  => { number: text }
  contact   => (mail_addr | phone_no)
  h3        => { f: contact }
}
`;

const linked: LinkedSchema = resolveUserSchema(USER_SCHEMA);
const compiled: CompiledSchema = compile(linked);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `holder`'s own `r`/`a`/`m` fields, valid and unremarkable -- every test below only varies `t`. */
const REST = `  r: { name: "n" }  a: [ "x" ]  m: { "k" => "v" }`;

function readHolder(document: string) {
  return validate(compiled, 'holder', bytes(document));
}

describe('subsumption -- §7.2 at every position it governs', () => {
  it('refuses an unrelated type at an atom position', () => {
    // `text` does carry a subtype here (core's own `non_empty_text`), so this takes the "not a
    // known subtype" wording -- the point is that an atom position now refuses at all. `uuid` is a
    // real, declared type that just is not admissible here, so this is `TYPE_MISMATCH` (the
    // value's own type is known and wrong) rather than `UNKNOWN_TYPE_REF` (a name denoting
    // nothing at all), §7.2.
    const uuidResult = readHolder(`{ t: !uuid "x" ${REST} }`);
    expect(uuidResult.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(uuidResult.diagnostics[0]?.message).toContain(
      "'!uuid' is not a known subtype of 'text'",
    );

    const nosuchResult = readHolder(`{ t: !nosuch "x" ${REST} }`);
    expect(nosuchResult.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(nosuchResult.diagnostics[0]?.message).toContain("'!nosuch'");
  });

  it('refuses an unrelated type at array and map positions', () => {
    const arrayResult = readHolder(
      `{ t: "x"  r: { name: "n" }  a: !nosuch [ "x" ]  m: { "k" => "v" } }`,
    );
    expect(arrayResult.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(arrayResult.diagnostics[0]?.message).toContain("'!nosuch'");

    const mapResult = readHolder(
      `{ t: "x"  r: { name: "n" }  a: [ "x" ]  m: !nosuch { "k" => "v" } }`,
    );
    expect(mapResult.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(mapResult.diagnostics[0]?.message).toContain("'!nosuch'");
  });

  it('refuses an unrelated type at a tuple position', () => {
    const tupleSchema = `
!!id:"test://subsumption-tuple.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  pair => [text, text]
  holder => { p: pair }
}
`;
    const tupleCompiled = compile(resolveUserSchema(tupleSchema));
    const result = validate(tupleCompiled, 'holder', bytes(`{ p: !nosuch [ "a" "b" ] }`));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(result.diagnostics[0]?.message).toContain("'!nosuch'");
  });

  it('refuses an unrelated type at a record position with no subtypes, naming the position itself', () => {
    const hSchema = resolveUserSchema(USER_SCHEMA);
    const hCompiled = compile(hSchema);
    const result = validate(hCompiled, 'h', bytes(`{ f: !nosuch { name: "x" } }`));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(result.diagnostics[0]?.message).toContain("'!nosuch' is not valid at a 'base' position");
    expect(result.diagnostics[0]?.message).toContain('no subtypes');
  });

  it('admits and validates a declared subtype as itself', () => {
    const result = readHolder(
      `{ t: "x"  r: !employee { name: "n"  badge: "b" }  a: [ "x" ]  m: { "k" => "v" } }`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("still validates an unannotated value against the position's own type, not the subtype", () => {
    // `badge` belongs to `employee`, not `person` -- rejected as an unrecognised field on `person`.
    const result = readHolder(
      `{ t: "x"  r: { name: "n"  badge: "b" }  a: [ "x" ]  m: { "k" => "v" } }`,
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.message.includes('badge'))).toBe(true);
  });

  it("always admits the position's own type, named explicitly (§7.2's 'S is T')", () => {
    const result = readHolder(
      `{ t: !text "x"  r: !person { name: "n" }  a: [ "x" ]  m: { "k" => "v" } }`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("admits an alias of the position's own type (§7.2 compares after following both to a terminal)", () => {
    const aliasSchema = resolveUserSchema(USER_SCHEMA);
    const aliasCompiled = compile(aliasSchema);
    const viaAlias = validate(aliasCompiled, 'h2', bytes(`{ f: !other { name: "x" } }`));
    expect(viaAlias.diagnostics).toEqual([]);
    const viaTarget = validate(aliasCompiled, 'h2', bytes(`{ f: !base { name: "x" } }`));
    expect(viaTarget.diagnostics).toEqual([]);
  });

  it('leaves a choice dispatching on its own variants, unaffected by subsumption', () => {
    const choiceSchema = resolveUserSchema(USER_SCHEMA);
    const choiceCompiled = compile(choiceSchema);
    const result = validate(choiceCompiled, 'h3', bytes(`{ f: !mail_addr { address: "a" } }`));
    expect(result.diagnostics).toEqual([]);
  });
});

// ── §5.2's three readings of an ABSTRACT position (§7.2) ────────────────────────────────────────

const FAMILY_SCHEMA = `
!!id:"test://subsumption-family.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  pet => abstract {
    pet_type: text =?
    name: text
  }
  dog => pet & { pet_type?: = "dog"  breed: text }
  cat => pet & { pet_type?: = "cat"  indoor: boolean }

  shape  => abstract { area: int32 }
  square => shape & { side: int32 }

  frame => abstract { opcode: int32 =?  payload: text }
  ping  => frame & { opcode?: = 0xFF  seq: int32 }

  orphan => abstract { sel: text =? }

  holder => { p: pet  s?: shape?  f?: frame?  o?: orphan? }
}
`;

const familyCompiled = compile(resolveUserSchema(FAMILY_SCHEMA));

function readFamilyHolder(document: string) {
  return validate(familyCompiled, 'holder', bytes(document));
}

describe('§5.2 ABSTRACT with no `discriminators`: the tag is the only selector', () => {
  it('requires the tag -- an untagged value at an abstract position is a validation error', () => {
    const result = readFamilyHolder(
      `{ p: !dog { pet_type: dog  name: "Rex"  breed: "corgi" }  s: { area: 4  side: 2 } }`,
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    expect(result.diagnostics[0]?.message).toContain('abstract');
  });

  it('refuses a tag naming the base itself -- no value satisfies it', () => {
    const result = readFamilyHolder(
      `{ p: !dog { pet_type: dog  name: "Rex"  breed: "corgi" }  s: !shape { area: 4  side: 2 } }`,
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    expect(result.diagnostics[0]?.message).toContain("'!shape'");
  });

  it('dispatches a tag naming a real subtype to that subtype', () => {
    const result = readFamilyHolder(
      `{ p: !dog { pet_type: dog  name: "Rex"  breed: "corgi" }  s: !square { area: 4  side: 2 } }`,
    );
    expect(result.diagnostics).toEqual([]);
  });
});

describe('§5.2 ABSTRACT with `discriminators`: the value is placed by reading the marked fields', () => {
  it('places a member with no tag at all, reading the fields it already carries', () => {
    const result = readFamilyHolder(`{ p: { pet_type: dog  name: "Rex"  breed: "corgi" } }`);
    expect(result.diagnostics).toEqual([]);
  });

  it('a selector may arrive after the fields it selects ([TSON-DATA] §2.5)', () => {
    const result = readFamilyHolder(`{ p: { breed: "corgi"  name: "Rex"  pet_type: dog } }`);
    expect(result.diagnostics).toEqual([]);
  });

  it('a pin is matched as a value, not as a token -- `= 0xFF` and a written `255` collide (§4.3)', () => {
    const result = readFamilyHolder(
      `{ p: { pet_type: dog  name: "Rex"  breed: "corgi" }  f: { opcode: 255  payload: "hi"  seq: 1 } }`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('an agreeing tag is admitted and changes nothing', () => {
    const result = readFamilyHolder(`{ p: !dog { pet_type: dog  name: "Rex"  breed: "corgi" } }`);
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a tag naming the sealed base itself, regardless of what the fields say', () => {
    const result = readFamilyHolder(`{ p: !pet { pet_type: dog  name: "Rex"  breed: "corgi" } }`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    expect(result.diagnostics[0]?.message).toContain("'!pet'");
  });

  it('refuses a tag contradicting the discriminator -- a tag may agree, never overrule', () => {
    const result = readFamilyHolder(`{ p: !cat { pet_type: dog  name: "Rex"  breed: "corgi" } }`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    expect(result.diagnostics[0]?.message).toContain('contradicts');
  });

  it('a discriminator value no member pins is a validation error naming the alternatives', () => {
    const result = readFamilyHolder(`{ p: { pet_type: dgo  name: "Rex" } }`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    expect(result.diagnostics[0]?.message).toContain('dog');
    expect(result.diagnostics[0]?.message).toContain('cat');
  });

  it('a value with no discriminator at all falls back to the ordinary missing-field diagnostic, located at the selector -- never a fallback to the tag (§5.2)', () => {
    const result = readFamilyHolder(`{ p: { name: "Rex" } }`);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
    expect(result.diagnostics[0]?.path).toBe('/p/pet_type');
  });

  function petTypeRef(document: string): string | undefined {
    const result = readFamilyHolder(document);
    expect(result.diagnostics).toEqual([]);
    const p = result.value.kind === 'record' ? result.value.fields.get('p') : undefined;
    return p?.kind === 'record' ? p.typeRef : undefined;
  }

  it("a self-annotated discriminator (`!text dog`, §7.2's 'S is T') still dispatches by value, not by falling through to the base", () => {
    expect(petTypeRef(`{ p: { pet_type: !text dog  name: "Rex"  breed: "corgi" } }`)).toBe('dog');
  });

  it('the positional form of a single-selector base (§5.6) is never admitted as the base directly, even though the ordinary reader parses it cleanly: with no member in this closure it names the missing import, never "one of ()"', () => {
    // `o`'s own ordinary record reader parses "whatever" as `orphan`'s positional fill for `sel`
    // with zero diagnostics of its own (`sel` is a plain, unconstrained `text`) -- this is exactly
    // the clean-parse-that-must-still-be-refused case, since `orphan` is ABSTRACT.
    const result = readFamilyHolder(
      `{ p: { pet_type: dog  name: "Rex"  breed: "corgi" }  o: "whatever" }`,
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    const message = result.diagnostics[0]?.message ?? '';
    expect(message).not.toContain('one of ()');
    expect(message).toContain("expected a member of 'orphan'");
  });

  it('a readable discriminator that no member (in an empty family) pins also names the missing import, never "one of ()"', () => {
    // Braced, not positional: `sel` is read plainly this time, so this exercises the *other*
    // "no member matches" branch -- the one reached once a discriminator tuple decodes cleanly
    // but the candidate list is still empty.
    const result = readFamilyHolder(
      `{ p: { pet_type: dog  name: "Rex"  breed: "corgi" }  o: { sel: "whatever" } }`,
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
    const message = result.diagnostics[0]?.message ?? '';
    expect(message).not.toContain('one of ()');
    expect(message).toMatch(/no schema in this closure declares a member of 'orphan'/u);
  });
});
