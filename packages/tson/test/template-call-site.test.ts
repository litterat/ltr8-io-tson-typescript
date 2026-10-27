import { describe, expect, it } from 'vitest';

import { standardLibrary } from '../src/stdlib/index.js';
import type { NamedField, RecordBody } from '../src/schema/meta/bodies.js';
import { namedField, namedFields } from '../src/schema/meta/bodies.js';
import type { LinkedSchema } from '../src/link/link.js';
import type { Top } from '../src/schema/meta/typedef.js';
import { applicationOf, isTemplateBody } from '../src/schema/meta/typedef.js';
import { subtypesIn, supertypesIn } from './model-fixtures.js';

const META = 'https://tson.io/2026/38/m/meta.tn';
const CORE = 'https://tson.io/2026/38/m/core.tn';

let counter = 0;

/** Resolves and links `declarations` against the bundled meta and core, as a fresh schema. */
function linked(declarations: string): LinkedSchema {
  counter += 1;
  const source =
    `!!id:"https://example.com/call-site-${String(counter)}.tn"\n` +
    `!!meta:"${META}"\n!!import:"${CORE}"\n{\n${declarations}\n}\n`;
  return standardLibrary().resolveSchema(new TextEncoder().encode(source));
}

function resolve(declarations: string): ReadonlyMap<string, Top> {
  return linked(declarations).entries;
}

function record(entries: ReadonlyMap<string, Top>, name: string): RecordBody {
  const body = entries.get(name);
  if (body === undefined || isTemplateBody(body) || body.kind !== 'record') {
    throw new Error(`'${name}' is not a closed record`);
  }
  return body;
}

function firstField(body: RecordBody): NamedField | undefined {
  return namedFields(body)[0];
}

describe('§5.10: an application is checked against the parameter list it binds', () => {
  it('a type argument that IS-A the bound is admitted, by name or by a supertype', () => {
    expect(() =>
      resolve('boxed => <T: text> { a: T }\nholder => { b: boxed<text> }'),
    ).not.toThrow();
    expect(() =>
      resolve('boxed => <T: integer> { a: T }\nholder => { b: boxed<int32> }'),
    ).not.toThrow();
  });

  it('a type argument outside the bound is refused where the application is written', () => {
    expect(() => resolve('boxed => <T: text> { a: T }\nholder => { b: boxed<int32> }')).toThrow(
      /binds 'T' to 'int32', which is not a type that IS-A text/,
    );
  });

  it('a value argument is read as the parameter type: a constructor template reads it in the structure namespace', () => {
    const vec = 'vec => <N> !array { element_type: text  min_items: N }\n';
    expect(() => resolve(`${vec}holder => { v: vec<2> }`)).not.toThrow();
    expect(() => resolve(`${vec}holder => { v: vec<"two"> }`)).toThrow(
      /binds 'N' to 'two', which is not a value of/,
    );
  });

  it('the bound holds where a declaration names the application', () => {
    expect(() =>
      resolve('boxed => <T: text> { a: T }\nheld => boxed<int32>\nother => { fine: text }'),
    ).toThrow(/IS-A text/);
  });
});

describe('§5.7 open modifiers: a parametric modifier takes the name mark its literal spelling takes (§3.2 item 33)', () => {
  it('`w?: T ~ N` closes to an optional default', () => {
    const entries = resolve('retry => <N> { attempts?: integer ~ N }\nused => retry<3>');
    const field = namedField(record(entries, 'used'), 'attempts');
    expect(field).toMatchObject({ optional: true, role: 'DEFAULT', value: { text: '3' } });
  });

  it('`w?: T = N` closes to an injected pin, and `w: T = N` to a marker; closing changes neither mark', () => {
    const entries = resolve(
      'inject => <N> { status?: integer = N }\nmarker => <N> { status: integer = N }\n' +
        'a => inject<201>\nb => marker<201>',
    );
    expect(firstField(record(entries, 'a'))).toMatchObject({ optional: true, role: 'FIXED' });
    expect(firstField(record(entries, 'b'))).toMatchObject({ optional: false, role: 'FIXED' });
  });

  it('`w: T ~ N` is refused for the reason `w: T ~ v` is', () => {
    expect(() => resolve('bad => <N> { attempts: integer ~ N }')).toThrow(
      /default to a key that is always written/,
    );
  });
});

describe('§5.10, §8.2: a family member is the application a declaration names', () => {
  const family = 'box => <T> { v: T }\n';

  it('a declared application carries the template in its supertypes; a use-site one is its expansion, a member of nothing', () => {
    const schema = linked(`${family}bt => box<int32>\nholder => { k: box<text> }`);
    const entries = schema.entries;
    expect(supertypesIn(entries.get('bt'))).toContain('box');
    // §8.2: the use site names a closed synthetic record keyed on its content, with no
    // instantiation entry and no `@application`.
    const kType = namedField(record(entries, 'holder'), 'k')?.type.name ?? '';
    expect(kType).toMatch(/^record_v_text_[0-9a-f]{8}$/);
    expect(applicationOf(schema.keyAnnotations.get(kType))).toBeUndefined();
    expect(supertypesIn(entries.get(kType))).toEqual([]);
    expect(subtypesIn(entries.get('box'))).toEqual(['bt']);
  });

  const pets =
    'pet => abstract { pet_type: text =?  name: text }\n' +
    'dog_of => <T> pet & { pet_type?: = "dog"  breed: T }\n';

  it('a use-site application that composes onto a record is refused, naming the fix (§5.2)', () => {
    expect(() => resolve(`${pets}kennel => { k: dog_of<text> }`)).toThrow(
      /a member is declared.*my_name => dog_of<text>/s,
    );
  });

  it('a member minted while closing a template is refused too (§8.2 item 2)', () => {
    expect(() =>
      resolve(`${pets}kennel_of => <T> { d: dog_of<T> }\nkt => kennel_of<text>`),
    ).toThrow(/a member is declared/);
  });

  it('the same application, declared, is a member and is admitted', () => {
    const entries = resolve(`${pets}dogs => dog_of<text>\nkennel => { k: dogs }`);
    expect(supertypesIn(entries.get('dogs'))).toContain('pet');
  });
});

describe('§8.2: an application nothing declares is its expansion (change log #18)', () => {
  it('a non-record template’s use-site application names the synthetic its sugar spelling names', () => {
    const schema = linked(
      'rows => <T> !array { element_type: T  min_items: 1 }\npost => { a: rows<text>  b: [text; 1..] }',
    );
    const post = record(schema.entries, 'post');
    const a = namedField(post, 'a')?.type.name;
    expect(a).toBe(namedField(post, 'b')?.type.name);
    expect(a).toMatch(/^array_text_1_[0-9a-f]{8}$/);
    expect([...schema.entries.keys()].some((name) => name.startsWith('rows_'))).toBe(false);
    expect(applicationOf(schema.keyAnnotations.get(a ?? ''))).toBeUndefined();
  });

  it('an expansion naming its own application keeps an instantiation entry recording it', () => {
    const schema = linked('nested => <T> ( T | [nested<T>] )\nu => { v: nested<text> }');
    const v = namedField(record(schema.entries, 'u'), 'v')?.type.name ?? '';
    expect(applicationOf(schema.keyAnnotations.get(v))).toMatchObject({ name: 'nested' });
  });

  it('a minted record composing an application only a use site mints loads (the one verdict change)', () => {
    const schema = linked(
      'box => <T> { v: T }\nvip => <T> box<T> & { level: int32 }\nh => { u: vip<text>  w: box<text> }',
    );
    const h = record(schema.entries, 'h');
    const u = schema.entries.get(namedField(h, 'u')?.type.name ?? '');
    expect(supertypesIn(u)).toEqual([]);
  });
});

describe('§5.8: a chain is complete through applied parents, whatever the declaration order', () => {
  const declarations = [
    'result => <T> { payload: T }',
    'ok => <T> result<T> & { note: text }',
    'okt => ok<text>',
    'rt => result<text>',
    'great => okt & { extra: int32 }',
  ];

  it('an entry composing a declared application IS-A the entry declared for its applied parent', () => {
    const entries = resolve(declarations.join('\n'));
    expect(supertypesIn(entries.get('okt'))).toEqual(['ok', 'result', 'rt']);
    expect(supertypesIn(entries.get('great'))).toEqual(['ok', 'okt', 'result', 'rt']);
    expect(subtypesIn(entries.get('rt'))).toEqual(['great', 'okt']);
  });

  it('declared in reverse, the chains are the same', () => {
    const entries = resolve([...declarations].reverse().join('\n'));
    expect(supertypesIn(entries.get('great'))).toEqual(['ok', 'okt', 'result', 'rt']);
  });

  it('a closed type keeps no parents once the fold has run; a template keeps them as written', () => {
    const entries = resolve(declarations.join('\n'));
    const parentsOf = (name: string): unknown =>
      (entries.get(name) as { chain?: { parents?: unknown } }).chain?.parents;
    expect(parentsOf('okt')).toEqual([]);
    expect(parentsOf('ok')).toMatchObject([{ name: 'result' }]);
  });
});

describe('§5.10: where a record template’s parameter stands (change log #16, #17)', () => {
  function loadError(declarations: string): string | undefined {
    try {
      linked(declarations);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it('a parameter is never an operand of & or ^, a parameter shadowing an entry of its name', () => {
    expect(loadError('x => <T> T & { a: int32 }')).toMatch(/is a parameter of this declaration/);
    expect(loadError('x => <T> T ^ { a: int32 }')).toMatch(/never an operand of '\^'/);
    expect(loadError('pt => { a: int32 }\nx => <pt> pt & { b: int32 }')).toMatch(
      /is a parameter of this declaration/,
    );
  });

  it('an operand applied to a parameter is admitted', () => {
    expect(loadError('box => <T> { v: T }\nx => <T> box<T> & { a: int32 }')).toBeUndefined();
  });

  it('a record template named bare at an operand is refused', () => {
    expect(loadError('box => <T> { v: T }\nx => box & { a: int32 }')).toMatch(
      /is a template and is applied to no arguments/,
    );
    expect(loadError('box => <T> { v: T }\nx => box ^ { v: int32 }')).toMatch(
      /is a template and is applied to no arguments/,
    );
  });

  it('a parameter standing in any slot but a field’s type, value or an argument names the slot', () => {
    expect(
      loadError('x => <T> !record { fields: { a => { type: int32 } }  extension: T }'),
    ).toMatch(/parameter 'T' stands at record\.extension/);
    expect(loadError('x => <T> !record { fields: { a => { type: int32  optional: T } } }')).toMatch(
      /parameter 'T' stands at record_field\.optional/,
    );
    expect(loadError('x => <T> { a?: int32 ~ T }')).toBeUndefined();
    expect(loadError('box => <T> { v: T }\nx => <T> { a: box<T> }')).toBeUndefined();
  });
});
