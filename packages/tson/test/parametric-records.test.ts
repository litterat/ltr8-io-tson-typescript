/**
 * [TSON-SCHEMA] §5.10's declaration-time rules for a parametric record, through the public front door: a
 * parametric record's body is a record body, a parameter stands at a type slot alone and shadows no entry, a
 * bound is written and judged at the application, and no position names a parametric record bare.
 */
import { describe, expect, it } from 'vitest';

import { load, loadError } from './schema-read-helpers.js';
import { subtypesIn, supertypesIn } from './model-fixtures.js';

describe('§5.10 a parametric record’s body is a record body', () => {
  it('a parameter list before a construction of a constructor is refused: an argument is a type, never a slot value', () => {
    expect(loadError('rows => <T> !meta.array { element_type: T  min_items: 1 }')).toMatch(
      /a parametric record's body is a record body .* constructs 'meta\.array'/,
    );
  });

  it('a parameter list before a reference -- a parametric alias -- is refused', () => {
    expect(
      loadError('pair => <A, B> { first: A  second: B }\nuuid_pair => <B> pair<uuid, B>'),
    ).toMatch(/would be a parametric alias/);
  });

  it('a literal argument is no type, and is refused where it is written', () => {
    expect(loadError('box => <T> { v: T }\nholder => { b: box<2> }')).toMatch(/no type argument/);
  });
});

describe('§5.10 where a parameter stands', () => {
  it('at a field’s type and at any depth of a type written in place there', () => {
    expect(
      loadError('page => <T> { items: [T]  index: {text => T}  meta: { cursor: T } }'),
    ).toBeUndefined();
  });

  it('nowhere else: a field’s default or fixed value is a value, never a parameter', () => {
    expect(loadError('retry => <N> { attempts?: int32 ~ N }')).toMatch(
      /declares the type parameter 'N' and never references it/,
    );
  });

  it('a parameter is never an operand of &', () => {
    expect(loadError('x => <T> T & { a: int32 }')).toMatch(
      /a parameter is never an operand of '&'/,
    );
  });

  it('a parameter spelled like an entry of the namespace is refused at the declaration', () => {
    expect(loadError('T => { q: int32 }\nts => <T> { v: T }')).toMatch(
      /parameter 'T' shadows the entry 'T'/,
    );
    expect(loadError('ts => <text> { v: text }')).toMatch(/parameter 'text' shadows/);
  });

  it('a declared parameter the body never references is refused', () => {
    expect(loadError('box => <T> { v: text }')).toMatch(/never references it/);
  });
});

describe('§5.10 no position names a parametric record bare', () => {
  it('at a field', () => {
    expect(loadError('box => <T> { v: T }\nholder => { b: box }')).toMatch(
      /not a type until it is applied/,
    );
  });

  it('at an operand of &', () => {
    expect(loadError('box => <T> { v: T }\nx => box & { a: int32 }')).toMatch(
      /'box' is a parametric record and is applied to no arguments/,
    );
  });
});

describe('§5.10 a bound is written and judged at the application', () => {
  it('a type argument that IS-A the bound is admitted, by name or by a supertype', () => {
    expect(loadError('boxed => <T: text> { a: T }\nholder => { b: boxed<text> }')).toBeUndefined();
  });

  it('a bound is recorded on the parameter as written', () => {
    const linked = load('boxed => <T: text> { a: T }');
    expect((linked.entries.get('boxed') as { parameters?: unknown }).parameters).toEqual([
      { name: 'T', bound: { name: 'text', annotations: [] } },
    ]);
  });

  it('a type argument outside the bound is refused where the application is written', () => {
    expect(loadError('boxed => <T: text> { a: T }\nholder => { b: boxed<int32> }')).toMatch(/IS-A/);
  });

  it('a bound naming a constructor admits nothing and is refused at the declaration', () => {
    expect(loadError('boxed => <T: unicode.text_type> { a: T }')).toMatch(
      /'unicode\.text_type' is a constructor, not a type/,
    );
  });
});

describe('§5.10, §8.2 a family member is the application a declaration names', () => {
  const pets =
    'pet => abstract { pet_type: text =?  name: text }\n' +
    'dog_of => <T> pet & { pet_type: = "dog"  breed: T }\n';

  it('a declared application is a member of the family its written parent enters', () => {
    const linked = load(`${pets}dogs => dog_of<text>\nkennel => { k: dogs }`);
    expect(supertypesIn(linked.entries.get('dogs'))).toContain('pet');
    expect(subtypesIn(linked.entries.get('pet'))).toContain('dogs');
  });

  it('a use-site application composing onto a record is refused, naming the declaration that would admit it', () => {
    expect(loadError(`${pets}kennel => { k: dog_of<text> }`)).toMatch(/dog_of<text>/);
  });
});

describe('§5.10, §5.5 a parameter inside a completion written in place', () => {
  const META = '!!import:"https://tson.io/2026/40/m/meta.tn"';
  const NONEMPTY = 'nonempty => !meta.array ^ { min_items: 1 }\n';

  /** The type held at field `v` of the application `a`, which the declaration closes. */
  function fieldType(body: string): unknown {
    const entry = load(`${body}\na => arr<int32>`, META).entries.get('a');
    if (entry?.kind !== 'record') throw new Error('expected a record');
    return entry.fields.entries.get('v')?.type;
  }

  it.each([
    [
      'the kernel’s set_type',
      'arr => <T> !meta.record { fields: { v => { type: { of: !meta.set_type { element_type: T } } } } }',
      'arr => <T> { v: meta.set_type<T> }',
    ],
    [
      'a schema’s own incomplete entry, braced',
      `${NONEMPTY}arr => <T> !meta.record { fields: { v => { type: { of: !nonempty { element_type: T } } } } }`,
      `${NONEMPTY}arr => <T> { v: nonempty<T> }`,
    ],
    [
      'a schema’s own incomplete entry, positional',
      `${NONEMPTY}arr => <T> !meta.record { fields: { v => { type: { of: !nonempty T } } } }`,
      `${NONEMPTY}arr => <T> { v: nonempty<T> }`,
    ],
  ])('%s: the explicit spelling and the sugar close to one type', (_what, explicit, sugar) => {
    expect(fieldType(explicit)).toEqual(fieldType(sugar));
  });

  it('a parameter at a slot that holds no type is refused inside a completion as outside it', () => {
    expect(
      loadError(
        `${NONEMPTY}sized => <N> !meta.record { fields: { v => { type: { of: !nonempty { element_type: text  max_items: N } } } } }`,
        META,
      ),
    ).toMatch(/parameter 'N' stands at meta\.array\.max_items/);
  });

  it('a type written in place whose head names no constructor is refused for the head, whatever its slots hold', () => {
    const body = (argument: string): string =>
      `arr => <T> !meta.record { fields: { v => { type: { of: !missing_head { element_type: ${argument} } } } } }`;
    const withParameter = loadError(body('T'), META);
    expect(withParameter).toBeDefined();
    expect(withParameter).toBe(loadError(body('text'), META));
  });
});
