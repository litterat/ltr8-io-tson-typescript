import { describe, expect, it } from 'vitest';

import { standardLibrary } from '../src/stdlib/index.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { TypeDefinition } from '../src/schema/meta/typedef.js';

const META = 'https://tson.io/2026/37/m/meta.tn';
const CORE = 'https://tson.io/2026/37/m/core.tn';

let counter = 0;

/** Resolves and links `declarations` against the bundled meta and core, as a fresh schema. */
function resolve(declarations: string): ReadonlyMap<string, TypeDefinition> {
  counter += 1;
  const source =
    `!!id:"https://example.com/call-site-${String(counter)}.tn"\n` +
    `!!meta:"${META}"\n!!import:"${CORE}"\n{\n${declarations}\n}\n`;
  return standardLibrary().resolveSchema(new TextEncoder().encode(source)).entries;
}

function record(entries: ReadonlyMap<string, TypeDefinition>, name: string): RecordBody {
  const body = entries.get(name)?.body;
  if (body === undefined || !('fields' in body)) {
    throw new Error(`'${name}' is not a closed record`);
  }
  return body;
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
    const field = record(entries, 'used').fields.find((f) => f.name === 'attempts');
    expect(field).toMatchObject({ optional: true, role: 'DEFAULT', value: { text: '3' } });
  });

  it('`w?: T = N` closes to an injected pin, and `w: T = N` to a marker; closing changes neither mark', () => {
    const entries = resolve(
      'inject => <N> { status?: integer = N }\nmarker => <N> { status: integer = N }\n' +
        'a => inject<201>\nb => marker<201>',
    );
    expect(record(entries, 'a').fields[0]).toMatchObject({ optional: true, role: 'FIXED' });
    expect(record(entries, 'b').fields[0]).toMatchObject({ optional: false, role: 'FIXED' });
  });

  it('`w: T ~ N` is refused for the reason `w: T ~ v` is', () => {
    expect(() => resolve('bad => <N> { attempts: integer ~ N }')).toThrow(
      /default to a key that is always written/,
    );
  });
});

describe('§5.10, §8.2: a family member is the application a declaration names', () => {
  const family = 'box => <T> { v: T }\n';

  it('a declared application carries the template in its supertypes; a use-site one does not', () => {
    const entries = resolve(`${family}bt => box<int32>\nholder => { k: box<text> }`);
    expect(entries.get('bt')?.supertypes).toContain('box');
    const minted = [...entries].find(
      ([name, def]) =>
        name !== 'bt' && def.source?.name === 'box' && def.source.arguments.length > 0,
    );
    expect(minted?.[1].supertypes).not.toContain('box');
    expect(entries.get('box')?.subtypes).toEqual(['bt']);
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
    expect(entries.get('dogs')?.supertypes).toContain('pet');
  });
});
