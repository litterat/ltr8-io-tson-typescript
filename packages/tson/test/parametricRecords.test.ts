/**
 * Parametric records and their applications ([TSON-SCHEMA] §5.10, §5.10.1, §8.2), references and qualified names
 * (§5.12), stated against the spec through the front door: a schema text resolved and linked by a standard library.
 */
import { describe, expect, it } from 'vitest';

import { standardLibrary } from '../src/stdlib/index.js';
import type { LinkedSchema } from '../src/link/link.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { Top, TypeExpr } from '../src/schema/meta/typedef.js';
import { applicationOf, applyText, supertypesOf } from '../src/schema/meta/typedef.js';

const HEADER =
  '!!import:"https://tson.io/2026/40/m/meta.tn"\n!!import:"https://tson.io/2026/40/m/core.tn"\n';

let counter = 0;

/** `declarations` as a schema document under a fresh identity, resolved and linked. */
function resolve(declarations: string): { linked: LinkedSchema; id: string } {
  counter += 1;
  const id = `https://example.com/parametric-${String(counter)}.tn`;
  const tson = standardLibrary();
  const linked = tson.resolveSchema(`!!id:"${id}"\n${HEADER}!schema {\n${declarations}\n}`);
  return { linked, id };
}

/** The message `declarations` fails to load with. */
function refusal(declarations: string): string {
  try {
    resolve(declarations);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the schema to fail to load, but it resolved cleanly');
}

function entry(linked: LinkedSchema, name: string): Top {
  const found = linked.entries.get(name);
  if (found === undefined) throw new Error(`no entry '${name}'`);
  return found;
}

function record(linked: LinkedSchema, name: string): RecordBody {
  const found = entry(linked, name);
  if (found.kind !== 'record') throw new Error(`'${name}' is no record`);
  return found;
}

function fieldType(linked: LinkedSchema, name: string, field: string): TypeExpr {
  const found = record(linked, name).fields.entries.get(field);
  if (found === undefined) throw new Error(`'${name}' has no field '${field}'`);
  return found.type;
}

describe('§8.2 a declared application is the substituted record under its name', () => {
  it('closes text_pair => pair<text, text> to a record without parameters, @meta.application on its key', () => {
    const { linked } = resolve(
      'pair => <A, B> { first: A  second: B }\ntext_pair => pair<text, text>',
    );
    const body = record(linked, 'text_pair');
    expect(body.parameters).toBeUndefined();
    expect(fieldType(linked, 'text_pair', 'first')).toMatchObject({ name: 'text' });
    expect(fieldType(linked, 'text_pair', 'second')).toMatchObject({ name: 'text' });
    const application = applicationOf(linked.keyAnnotations.get('text_pair'));
    expect(application === undefined ? undefined : applyText(application)).toBe('pair<text text>');
  });

  it('states @meta.application with each argument past its alias hops (§8.2 canonical applications)', () => {
    const { linked } = resolve('box => <T> { v: T }\nuser_id => uuid\nids => box<user_id>');
    const application = applicationOf(linked.keyAnnotations.get('ids'));
    expect(application === undefined ? undefined : applyText(application)).toBe('box<uuid>');
  });

  it('keeps an abstract parametric record abstract in every application (§5.10)', () => {
    const { linked } = resolve(
      'outcome => abstract <T> { value?: T }\ntext_outcome => outcome<text>',
    );
    expect(record(linked, 'text_outcome').extension).toBe('ABSTRACT');
  });

  it('refuses an argument that does not IS-A its parameter bound (§5.10 "A bound is written")', () => {
    expect(refusal('labelled => <T: text> { label: T }\nbad => labelled<int32>')).toContain(
      "declares 'T: text'",
    );
  });
});

describe('§5.10 an application at a type slot closes in place', () => {
  it('holds the substituted record with no name and no chain, never looked up', () => {
    const { linked } = resolve('box => <T> { v: T }\nholder => { b: box<int32> }');
    const type = fieldType(linked, 'holder', 'b');
    expect(type.kind).toBe('inline');
    if (type.kind !== 'inline') return;
    expect(type.head).toBe('meta.record');
    expect(type.of.kind).toBe('record');
    expect(type.of.chain).toBeUndefined();
    if (type.of.kind === 'record') {
      expect(type.of.fields.entries.get('v')?.type).toMatchObject({ name: 'int32' });
    }
  });

  it('keeps an application over a parameter as meta.apply until the holder is applied', () => {
    const { linked } = resolve(
      'box => <T> { v: T }\npage => <T> { cursor: box<T> }\norder_page => page<text>',
    );
    const open = fieldType(linked, 'page', 'cursor');
    expect(open.kind === 'inline' ? open.of.kind : undefined).toBe('apply');
    const closed = fieldType(linked, 'order_page', 'cursor');
    expect(closed.kind === 'inline' ? closed.of.kind : undefined).toBe('record');
  });

  it('refuses a sugar form passed as an argument (§5.3: an argument is a name or a parameter)', () => {
    expect(refusal('box => <T> { v: T }\nholder => { b: box<[text]> }')).toContain(
      'is a name or a parameter',
    );
  });
});

describe('§5.10.1 self-referential types', () => {
  it('ties a recursive application to the declaration closing it', () => {
    const { linked } = resolve('node => <T> { value: T  next?: node<T> }\nnode_text => node<text>');
    expect(fieldType(linked, 'node_text', 'next')).toMatchObject({ name: 'node_text' });
  });

  it('refuses a recursive application no declaration closes, naming the declaration to write', () => {
    expect(
      refusal('node => <T> { value: T  next?: node<T> }\nholder => { f: node<text> }'),
    ).toContain("declare it ('node_text => node<text>')");
  });

  it('refuses at its declaration a parametric record that could never be closed', () => {
    expect(
      refusal('node => <T> { value: T  next?: node<T> }\nwrap => <T> { label: text  n: node<T> }'),
    ).toContain("'wrap' could never be closed");
  });

  it('refuses a recursive application that does not pass each parameter through unchanged', () => {
    expect(refusal('swap => <A, B> { a: A  next?: swap<B, A> }')).toContain('does not pass');
  });
});

describe('§5.8 an application at a composition operand is absorbed', () => {
  it("is IS-A its head's written parents, never its head, and mints no entry", () => {
    const { linked } = resolve(
      'pet => abstract { kind: text =?  name: text }\n' +
        'pet_of => <T> pet & { pet: T }\n' +
        'dog => pet_of<text> & { kind?: = "dog" }',
    );
    expect(supertypesOf(entry(linked, 'dog'))).toEqual(['pet']);
    expect(fieldType(linked, 'dog', 'pet')).toMatchObject({ name: 'text' });
    expect([...linked.entries.keys()].filter((name) => name.startsWith('pet_of_'))).toEqual([]);
  });

  it('is IS-A the declaration naming the applied parent (§5.8, §8.2: an applied parent is looked up)', () => {
    const { linked } = resolve(
      'box => <T> { v: T }\ntext_box => box<text>\nlabelled => box<text> & { label: text }',
    );
    expect(supertypesOf(entry(linked, 'labelled'))).toContain('text_box');
  });

  it('refuses a restatement of an absorbed field that does not narrow it (§5.8)', () => {
    expect(refusal('box => <T> { v: T }\nbad => box<text> & { v: int32 }')).toContain(
      'not a valid restatement',
    );
  });
});

describe('§5.10 the explicit spelling <T> !meta.record { … }', () => {
  it('builds the parametric record the braces build', () => {
    const { linked } = resolve(
      'box => <T> !meta.record { fields: { v => !meta.record_field { type: T } } }\nbt => box<int32>',
    );
    expect(record(linked, 'box').parameters?.map((parameter) => parameter.name)).toEqual(['T']);
    expect(fieldType(linked, 'bt', 'v')).toMatchObject({ name: 'int32' });
  });

  it('refuses a parameter at a slot that names no type, naming the slot', () => {
    expect(
      refusal(
        'box => <T> !meta.record { fields: { v => !meta.record_field { type: text  value: T } } }',
      ),
    ).toContain('meta.record_field.value');
  });
});

describe('§5.12 qualified names', () => {
  it("refuses a record's name_type admitting '.' (§5.2)", () => {
    expect(
      refusal(
        'dotted => !unicode.identifier_type { continue_add: "." }\nrow => !meta.record { name_type: dotted  fields: { a => { type: text } } }',
      ),
    ).toContain("admits '.'");
  });

  it("refuses a namespace's key_type admitting '.' (§4.2)", () => {
    expect(
      refusal(
        'dotted => !unicode.identifier_type { continue_add: "." }\nindex => !meta.namespace { key_type: dotted  value_type: text }',
      ),
    ).toContain("admits '.'");
  });
});
