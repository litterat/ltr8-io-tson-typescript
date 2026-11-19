import { describe, expect, it } from 'vitest';

import { TsonNameHygieneRefusedError } from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';

/** §5.10's declaration-time rules for a template: shadowing, literals on open types, and what a template absorbs. */

let counter = 0;

function load(declarations: string): unknown {
  counter += 1;
  const source =
    `!!id:"https://example.test/template-shape-${String(counter)}.tn"\n` +
    `!!import:"https://tson.io/2026/39/m/core.tn"\n!schema {\n${declarations}\n}\n`;
  return standardLibrary().resolveSchema(encodeUtf8(source));
}

function error(declarations: string): Error | undefined {
  try {
    load(declarations);
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe('§5.10 a parameter shadows no entry', () => {
  it('a parameter spelled like a schema type is refused at the declaration', () => {
    expect(error('T => { q: int32 }\n ts => <T> [T]')?.message).toContain(
      "parameter 'T' shadows the entry 'T'",
    );
  });

  it('a parameter spelled like a value entry is refused too', () => {
    expect(
      error(
        'point => { x: int32  y: int32 }\n origin => !point { x: 0  y: 0 }\n boxed => <origin> { v: origin }',
      )?.message,
    ).toContain("parameter 'origin' shadows the entry 'origin'");
  });

  it('a parameter spelled like an imported entry is refused', () => {
    expect(error('ts => <text> [text]')?.message).toContain("parameter 'text' shadows");
  });
});

describe('§5.10 a literal needs a closed type', () => {
  it('a literal argument whose type is still open is refused at a field’s type', () => {
    const refused = error('pin2 => <T, P> { a?: T = P }\n w => <X> { f: pin2<X, 3>  z: int32 }');
    expect(refused?.message).toContain("binds 'P' to the literal '3'");
    expect(refused?.message).toContain('still open here');
  });

  it('and at an operand', () => {
    expect(
      error('pin2 => <T, P> { a?: T = P }\n w => <X> pin2<X, 3> & { z: int32 }')?.message,
    ).toContain("binds 'P' to the literal '3'");
  });

  it('a closed application of the same template loads', () => {
    expect(
      error('pin2 => <T, P> { a?: T = P }\n w => pin2<int8, 3> & { z: int32 }'),
    ).toBeUndefined();
  });
});

describe('§5.10 what a template absorbs it does not classify', () => {
  it('an inherited literal spelled like a parameter stays a literal', () => {
    expect(
      error('base => { kind?: text = T }\n fam => <T> base & { v: T }\n use => fam<int32>'),
    ).toBeUndefined();
  });

  it('a record template is no constructor a declaration applies directly (§8.1)', () => {
    expect(
      error(
        'sneaky => !meta.record_template { fields: { v => !meta.record_template_field { type_param: T } } ' +
          'parameters: [{ name: T  type: meta.type_ref }] }',
      )?.message,
    ).toContain('resolver vocabulary');
  });
});

describe('§8.2 a template’s literal is judged as a name at the template', () => {
  it('a restricted character in a fixed value is refused whether or not anything applies it', () => {
    expect(
      error(
        'slug => !unicode.identifier_type { continue_add: "-" }\n acct => <T> { kind: slug = aĲb  v: T }',
      ),
    ).toBeInstanceOf(TsonNameHygieneRefusedError);
  });
});
