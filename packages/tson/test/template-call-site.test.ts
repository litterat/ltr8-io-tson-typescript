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

  it('a declared application carries the template in its supertypes; a use-site one does not', () => {
    const schema = linked(`${family}bt => box<int32>\nholder => { k: box<text> }`);
    const entries = schema.entries;
    expect(supertypesIn(entries.get('bt'))).toContain('box');
    const minted = [...entries].find(([name]) => {
      const application = applicationOf(schema.keyAnnotations.get(name));
      return name !== 'bt' && application?.name === 'box' && application.arguments.length > 0;
    });
    expect(minted).toBeDefined();
    expect(supertypesIn(minted?.[1])).not.toContain('box');
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
