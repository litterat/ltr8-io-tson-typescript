import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { LinkedSchema } from '../src/link/link.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { kindOfEntry } from './linked-entries.js';

/**
 * The rules of Revision 39's reference, value-entry and facet work, each at the section that states it: counts
 * (§5.5), a bound read against its family's instance (§5.6), the size pair every container shares (§5.3),
 * namespace types (§4.1), a default or pin at a reference (§5.2, §5.12), qualified names (§5.12), and a template
 * over a value's type (§5.10).
 */

const HEADER = `!!id:"https://example.test/wp2b.tn"
!!import:"https://tson.io/2026/40/m/meta.tn"
!!import:"https://tson.io/2026/40/m/core.tn"
!schema `;

function link(body: string): LinkedSchema {
  return standardLibrary().resolveSchema(HEADER + body);
}

function refusal(body: string): string {
  try {
    link(body);
  } catch (error) {
    if (error instanceof TsonSchemaValidationError) return error.message;
    throw error;
  }
  throw new Error('expected the schema to be refused');
}

describe('a count is a numeric.count: an integer from 0 to 2^63 - 1 (§5.5)', () => {
  it('admits the largest count', () => {
    expect(() =>
      link('{ longest => !unicode.text_type { max_length: 9223372036854775807 } }'),
    ).not.toThrow();
  });

  it.each([
    ['one past the signed 64-bit range', '9223372036854775808'],
    ['a negative count', '-1'],
  ])('refuses %s', (_label, count) => {
    expect(refusal(`{ longer => !unicode.text_type { max_length: ${count} } }`)).toContain(
      'is no count',
    );
  });

  it('a width is an integer and no count: it may be as wide as a schema states (§5.6, §9)', () => {
    expect(() =>
      link('{ wide => !integer ^ { size: { bits: 9223372036854775808  signed: false } } }'),
    ).not.toThrow();
  });
});

describe('a bound is read against its family’s instance (§5.6)', () => {
  it('`number` admits integer and float forms and no based integer', () => {
    expect(() => link('{ some => !number ^ { min: 16 } }')).not.toThrow();
    expect(() => link('{ some => !number ^ { min: 1.5e1 } }')).not.toThrow();
    expect(refusal('{ at_least_sixteen => !number ^ { min: 0x10 } }')).toContain(
      'at_least_sixteen',
    );
  });
});

describe('a container’s size pair is one rule over arrays, maps and namespace types (§5.3, §5.7)', () => {
  it.each([
    ['an array', '!meta.array { element_type: text  min_items: 3  max_items: 1 }'],
    ['a map', '!meta.map { key_type: text  value_type: text  min_items: 3  max_items: 1 }'],
    [
      'a namespace type',
      '!meta.namespace { key_type: meta.identifier  value_type: text  min_items: 3  max_items: 1 }',
    ],
  ])('%s whose min_items exceeds its max_items is refused', (_label, body) => {
    expect(refusal(`{ crossed => ${body} }`)).toContain('min_items 3 is above max_items 1');
  });

  it('a size specifier is refused the same way, and an equal pair is an exact size', () => {
    expect(refusal('{ crossed => [text; 5..3] }')).toContain('min_items');
    expect(() => link('{ exact => [text; 3..3] }')).not.toThrow();
  });
});

describe('a namespace type’s keys are names (§4.1, §7.4)', () => {
  it('a key type built with identifier_type is admitted', () => {
    expect(() =>
      link('{ words => !meta.namespace { key_type: meta.identifier  value_type: text } }'),
    ).not.toThrow();
  });

  it('an enum is no identifier family, so an enum-keyed map is no namespace', () => {
    expect(
      refusal(`{
        verb     => !enum [GET POST]
        verb_map => !meta.namespace { key_type: verb  value_type: text }
      }`),
    ).toContain('is no identifier family');
  });
});

describe('a default or pin at a reference over a type names a value of it (§5.2, §5.12)', () => {
  const FIELDS = `
    order          => { id: text }
    rush_order     => order & { by: text }
    customer       => { name: text }
    orders         => !meta.namespace { key_type: meta.identifier  value_type: order }
    o1             => !order { id: A-1 }
    r1             => !rush_order { id: R-1  by: noon }
    c1             => !customer { name: Ada }
    book           => !orders { first => { id: B-1 } }`;

  it.each(['o1', 'r1', 'book.first'])('%s is admitted', (name) => {
    expect(() =>
      link(`{ ${FIELDS}\n pick => { which?: meta.ref<order> ~ ${name} } }`),
    ).not.toThrow();
    expect(() =>
      link(`{ ${FIELDS}\n pick => { which: meta.ref<order> = ${name} } }`),
    ).not.toThrow();
  });

  it.each([
    ['a type', 'order'],
    ['nothing', 'nope'],
    ['a value of another type', 'c1'],
    ['a key the namespace value does not hold', 'book.second'],
  ])('%s is refused against the entry declaring the field', (_label, name) => {
    const message = refusal(`{ ${FIELDS}\n pick => { which?: meta.ref<order> ~ ${name} } }`);
    expect(message).toContain("'pick'");
    expect(message).toContain('default');
  });

  it('a default at a reference over a constructor must name a member, judged by the same predicate', () => {
    expect(() =>
      link('{ ledger => { named?: meta.ref<meta.record> ~ meta.record } }'),
    ).not.toThrow();
    expect(refusal('{ ledger => { named?: meta.ref<meta.record> ~ text } }')).toContain("'ledger'");
  });
});

describe('a qualified name walks from the root (§5.12)', () => {
  it('enters a schema map by member name, and goes on into the record value it reaches', () => {
    const linked = link(`{
      geo => !schema {
        location => { at: text }
        home     => !geo.location { at: here }
      }
      locations => meta.ref<geo.location>
      texts     => meta.ref<text>
      spot_pick => { l: locations  t: texts }
      chosen    => !spot_pick { l: geo.home  t: geo.home.at }
    }`);
    expect(linked.entries.has('geo.home')).toBe(true);
    expect(kindOfEntry(linked, 'chosen')).toBe('value_entry');
  });

  it('a segment past a schema map that declares no such member is refused', () => {
    expect(
      refusal(`{
        geo => !schema { location => { at: text } }
        locations => meta.ref<geo.location>
        spot_pick => { l: locations }
        chosen    => !spot_pick { l: geo.nowhere }
      }`),
    ).toContain("declares no 'nowhere'");
  });

  it('a constructor named by its path is a member of a kind over the constructor (§4.1)', () => {
    expect(() =>
      link(`{
        request_slot => { request: meta.ref<meta.record> }
        slots        => !meta.namespace { key_type: meta.identifier  value_type: request_slot }
        all          => !slots { generic => { request: meta.record } }
      }`),
    ).not.toThrow();
  });
});

describe('a parameter list stands before a record body alone (§5.10)', () => {
  it('a parameter list before a value of a namespace type is refused: there are no parametric values', () => {
    expect(() =>
      link(`{
      order     => { id: text }
      interface => !meta.namespace { key_type: meta.identifier  value_type: meta.type_ref }
      orders    => <T> !interface { get => T }
    }`),
    ).toThrow();
  });
});

describe('a constructor pinning an optional facet states it where the instance omits it (§5.2, §5.7)', () => {
  it('an instance of a refinement of unicode.text_type with `max_length?: = 4` carries the four', () => {
    const linked = link(`{
      meta => !schema {
        code_type => unicode.text_type & { max_length?: = 4 }
      }
      code => !meta.code_type {}
    }`);
    expect(linked.entries.get('code')).toMatchObject({ kind: 'text_type', maxLength: 4n });
  });
});

describe('the kernel’s `disjoint` annotation asserts a choice is disjoint (§5.4)', () => {
  it('a choice whose variants are not disjoint contradicts the marker', () => {
    expect(
      refusal(`{
        circle => { radius: int32 }
        square => { side: int32 }
        @meta.disjoint
        shapes => ( circle | square )
      }`),
    ).toContain('disjoint');
  });

  it('a disjoint choice carries it without complaint', () => {
    expect(() =>
      link(`{
        @meta.disjoint
        scalar => ( text | boolean )
      }`),
    ).not.toThrow();
  });
});
