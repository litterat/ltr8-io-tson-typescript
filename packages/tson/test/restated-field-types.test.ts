import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { fieldTypeName, recordEntry } from './linked-entries.js';

/**
 * [TSON-SCHEMA] §5.7's rule for a restated field's type, and §5.8's application of it to a composition's
 * tightening entries: the restated type is the inherited one or a type IS-A it (§7.2), or `void` at a voidable
 * position. Judged at link, where every name both types hold resolves.
 */

function link(body: string): LinkedSchema {
  return standardLibrary().resolveSchema(
    '!!id:"https://example.test/restated.tn"\n' +
      '!!import:"https://tson.io/2026/40/m/meta.tn"\n' +
      '!!import:"https://tson.io/2026/40/m/core.tn"\n' +
      `!schema ${body}`,
  );
}

function refused(body: string): string {
  try {
    link(body);
  } catch (error) {
    if (error instanceof TsonSchemaValidationError) return error.message;
    throw error;
  }
  throw new Error('expected the schema to be refused');
}

describe('a restated field narrows by IS-A (§5.7, §5.8, §7.2)', () => {
  it('§5.8: a composition restating a field as an unrelated type is refused', () => {
    expect(refused('{ a => { x: text }  b => a & { x: int32 } }')).toContain(
      "'b': not a valid restatement of 'a''s fields (§5.8): field 'x' is typed 'int32', which is not 'text' or IS-A it",
    );
  });

  it('§5.8, §7.2: a composition restating a field as its supertype is refused', () => {
    expect(
      refused(`{
        person   => { name: text }
        employee => person & { badge: text }
        team     => { lead: employee }
        loose    => team & { lead: person }
      }`),
    ).toContain("field 'lead' is typed 'person', which is not 'employee' or IS-A it");
  });

  it("§5.8: a composition's tightening entry follows the same rule", () => {
    expect(refused('{ a => { x: text }  b => a & { x: int32  y: text } }')).toContain(
      "'b': not a valid restatement of 'a''s fields (§5.8): field 'x' is typed 'int32'",
    );
  });

  it('§7.2: narrowing to a subtype is admitted', () => {
    const linked = link(`{
      person    => { name: text }
      employee  => person & { badge: text }
      team      => { lead: person  size: integer }
      staffed   => team & { lead: employee }
      counted   => team & { size: count  label: text }
      count     => !integer ^ { min: 0 }
    }`);
    expect(fieldTypeName(recordEntry(linked, 'staffed'), 'lead')).toBe('employee');
    expect(fieldTypeName(recordEntry(linked, 'counted'), 'size')).toBe('count');
  });

  it('§5.7, §8.3: the same type, an alias of it, and void at a voidable position are admitted', () => {
    expect(() =>
      link(`{
        label     => text
        a         => { x: text  y?: text?  z: [int32] }
        same      => a & { x: text  z: [int32] }
        renamed   => a & { x: label }
        forbidden => a & { y?: void? }
      }`),
    ).not.toThrow();
  });

  it('§5.7: no structural IS-A holds between two containers -- a container of a subtype is no narrowing', () => {
    expect(refused('{ a => { x: [int32] }  b => a & { x: [int8] } }')).toContain(
      "field 'x' is typed",
    );
  });

  it('§7.2: a variant of a choice is a member of it, not IS-A it', () => {
    expect(
      refused(`{
        either => (int32 | text)
        a      => { x: either }
        b      => a & { x: int32 }
      }`),
    ).toContain("field 'x' is typed 'int32', which is not 'either' or IS-A it");
  });

  it('§5.8: a composition over a declared application is judged against the fields it closed with', () => {
    expect(
      refused(`{
        box  => <T> { v: T }
        held => box<text>
        b    => held & { v: int32 }
      }`),
    ).toContain(
      "'b': not a valid restatement of 'held''s fields (§5.8): field 'v' is typed 'int32'",
    );
  });
});
