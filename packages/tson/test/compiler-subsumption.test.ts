import { describe, expect, it } from 'vitest';

import { compile, validate, type CompiledSchema } from '../src/compiler/compile.js';
import type { LinkedSchema } from '../src/link/link.js';
import { resolveUserSchema } from './compiler-schema-fixtures.js';
import { requireValue } from './reader-tree-helpers.js';

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
    // §7.2's own two-step rule (this port's `compiler/subsumption.ts` reads it that way; see its
    // top note on the deliberate divergence from the reference's unconditional `TYPE_MISMATCH`):
    // `!uuid` resolves (core's own declared type, imported) but is not admitted at a `text`
    // position, so it is `TYPE_MISMATCH`; `!nosuch` names nothing this schema's namespace
    // declares at all, so it is `UNKNOWN_TYPE_REF`.
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

    // A name that *does* resolve (`person`, declared elsewhere in this schema) but is not
    // admitted at an array/map position is `TYPE_MISMATCH` instead.
    const resolvedResult = readHolder(
      `{ t: "x"  r: { name: "n" }  a: !person [ "x" ]  m: { "k" => "v" } }`,
    );
    expect(resolvedResult.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(resolvedResult.diagnostics[0]?.message).toContain("'!person'");
  });

  it('refuses an unrelated type at a tuple position', () => {
    const tupleSchema = `
!!id:"test://subsumption-tuple.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  pair => [text, text]
  unrelated => [integer, integer]
  holder => { p: pair }
}
`;
    const tupleCompiled = compile(resolveUserSchema(tupleSchema));
    const result = validate(tupleCompiled, 'holder', bytes(`{ p: !nosuch [ "a" "b" ] }`));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(result.diagnostics[0]?.message).toContain("'!nosuch'");

    const resolvedResult = validate(
      tupleCompiled,
      'holder',
      bytes(`{ p: !unrelated [ "a" "b" ] }`),
    );
    expect(resolvedResult.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(resolvedResult.diagnostics[0]?.message).toContain("'!unrelated'");
  });

  it('refuses an unrelated type at a record position with no subtypes, naming the position itself', () => {
    const hSchema = resolveUserSchema(USER_SCHEMA);
    const hCompiled = compile(hSchema);
    const result = validate(hCompiled, 'h', bytes(`{ f: !nosuch { name: "x" } }`));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
    expect(result.diagnostics[0]?.message).toContain(
      "'!nosuch' does not resolve in the governing schema's namespace",
    );
    expect(result.diagnostics[0]?.message).toContain("expected 'base'");

    // `person` resolves (declared elsewhere in this schema) but is not admitted at `base`, which
    // has no subtypes -- `TYPE_MISMATCH`, naming the position itself.
    const resolvedResult = validate(hCompiled, 'h', bytes(`{ f: !person { name: "x" } }`));
    expect(resolvedResult.diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    expect(resolvedResult.diagnostics[0]?.message).toContain(
      "'!person' is not valid at a 'base' position",
    );
    expect(resolvedResult.diagnostics[0]?.message).toContain('no subtypes');
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

  holder => { p: pet  s?: shape?  f?: frame?  o?: orphan?  d?: dog? }
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

  it(
    '§5.2/§5.5 the FIXED check compares VALUES, never annotations -- an annotated pin ' +
      "('pet_type: @doc:\"x\" dog') still equals the schema's unannotated one ('= \"dog\"')",
    () => {
      const result = readFamilyHolder(
        `{ p: { pet_type: dog  name: "Rex"  breed: "corgi" }  ` +
          `d: { pet_type: @doc:"x" dog  name: "Fido"  breed: "lab" } }`,
      );
      expect(result.diagnostics).toEqual([]);
    },
  );

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
    const value = requireValue(result);
    const p = value.kind === 'record' ? value.fields.get('p') : undefined;
    return p?.kind === 'record' ? p.typeRef : undefined;
  }

  it("a self-annotated discriminator (`!text dog`, §7.2's 'S is T') still dispatches by value, not by falling through to the base", () => {
    expect(petTypeRef(`{ p: { pet_type: !text dog  name: "Rex"  breed: "corgi" } }`)).toBe('dog');
  });

  it('the positional form of a single-selector base (§5.6) is never admitted as the base directly: the positional fill never reaches the record-shape lookahead, so the selector is reported missing exactly as an omitted one would be', () => {
    // The positional form of a one-field record is a bare token, never a `{ ... }` shape, so this
    // dispatcher's own lookahead (which only looks inside a `record-start`) finds no discriminator
    // token here at all -- the identical case to `sel` simply being left out, refused on the same
    // terms (`FIELD_REQUIRED`, at the selector), never silently admitted as `orphan` itself even
    // though `orphan`'s own ordinary record reader would parse "whatever" as `sel`'s positional
    // fill cleanly.
    const result = readFamilyHolder(
      `{ p: { pet_type: dog  name: "Rex"  breed: "corgi" }  o: "whatever" }`,
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
    expect(result.diagnostics[0]?.path).toBe('/o/sel');
    expect(result.diagnostics[0]?.message).toContain("discriminator 'sel'");
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

// ── §5.10 "A record-bodied template is a family base": member dispatch reuses the record ────
// family's own reader (§5.2), over a template's *instantiations* rather than over a record's
// composers/refiners, matching the Java reference's `AbstractTemplateReader`'s own member
// -dispatch path.

const TEMPLATE_FAMILY_SCHEMA = `
!!id:"test://subsumption-template-family.tn"
!!meta:"https://tson.io/2026/36/m/meta.tn"
!!import:"https://tson.io/2026/36/m/core.tn"
{
  pet    => <N, T> { type: text = N  pet: T }
  dog    => pet<"dog", text> & { note: text }
  cat    => pet<"cat", text> & { note: text }

  holder => { p: pet }
}
`;

const templateFamilyCompiled = compile(resolveUserSchema(TEMPLATE_FAMILY_SCHEMA));

function readTemplateFamilyHolder(document: string) {
  return validate(templateFamilyCompiled, 'holder', bytes(document));
}

describe(
  '§5.10 a record-bodied template family base dispatches over its instantiations, never ' +
    'reading a held body of its own',
  () => {
    it('places a member with no tag at all, reading the selector the closing fixed on it (§5.7)', () => {
      const result = readTemplateFamilyHolder(`{ p: { type: dog  pet: "x"  note: "n" } }`);
      expect(result.diagnostics).toEqual([]);
    });

    it('a selector may arrive after the fields it selects ([TSON-DATA] §2.5)', () => {
      const result = readTemplateFamilyHolder(`{ p: { pet: "x"  note: "n"  type: dog } }`);
      expect(result.diagnostics).toEqual([]);
    });

    it('an agreeing tag is admitted and changes nothing', () => {
      const result = readTemplateFamilyHolder(`{ p: !dog { type: dog  pet: "x"  note: "n" } }`);
      expect(result.diagnostics).toEqual([]);
    });

    it('refuses a tag naming the template base itself, regardless of what the fields say', () => {
      const result = readTemplateFamilyHolder(`{ p: !pet { type: dog  pet: "x"  note: "n" } }`);
      expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
      expect(result.diagnostics[0]?.message).toContain("'!pet'");
    });

    it('refuses a tag contradicting the discriminator -- a tag may agree, never overrule', () => {
      const result = readTemplateFamilyHolder(`{ p: !cat { type: dog  pet: "x"  note: "n" } }`);
      expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
      expect(result.diagnostics[0]?.message).toContain('contradicts');
    });

    it('a discriminator value no instantiation pins is a validation error naming the alternatives', () => {
      const result = readTemplateFamilyHolder(`{ p: { type: bird  pet: "x" } }`);
      expect(result.diagnostics.map((d) => d.code)).toEqual(['VALIDATION_ERROR']);
      expect(result.diagnostics[0]?.message).toContain('dog');
      expect(result.diagnostics[0]?.message).toContain('cat');
    });

    it(
      'a missing selector is a required-field error even though the closed member’s own copy ' +
        'of the field is optional (§5.7’s fixation) -- dispatch is decided by what is written, ' +
        'never by what a member would inject (§7.2), and nothing else about the record is ' +
        'inspected once that refusal fires',
      () => {
        const result = readTemplateFamilyHolder(`{ p: { pet: "x"  note: "n" } }`);
        expect(result.diagnostics.map((d) => d.code)).toEqual(['FIELD_REQUIRED']);
        expect(result.diagnostics[0]?.path).toBe('/p/type');
        expect(result.diagnostics[0]?.message).toContain("discriminator 'type'");
      },
    );

    it('no instantiation entry is minted for a bare member reference -- dog and cat are named applications, in place (§8.2)', () => {
      const linked = resolveUserSchema(TEMPLATE_FAMILY_SCHEMA);
      expect([...linked.entries.keys()].some((k) => k.startsWith('pet_'))).toBe(false);
    });
  },
);
