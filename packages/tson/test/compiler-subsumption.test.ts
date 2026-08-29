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
!!meta:"https://tson.io/2026/34/m/meta.tn"
!!import:"https://tson.io/2026/34/m/core.tn"
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
    // known subtype" wording -- the point is that an atom position now refuses at all.
    const uuidResult = readHolder(`{ t: !uuid "x" ${REST} }`);
    expect(uuidResult.diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
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
!!meta:"https://tson.io/2026/34/m/meta.tn"
!!import:"https://tson.io/2026/34/m/core.tn"
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

  it("admits an alias of the position's own type (§7.2 compares after flattening both)", () => {
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
