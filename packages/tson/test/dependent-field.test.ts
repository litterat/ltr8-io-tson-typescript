import { describe, expect, it } from 'vitest';

import { mapSchemaSource } from '../src/config.js';
import type { Tson } from '../src/config.js';
import type { Diagnostic } from '../src/core/diagnostic.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';

/**
 * A dependent field, `v?: kind!` ([TSON-SCHEMA] §5.2): the sibling's rules, checked at the declaration
 * against the flattened record, and the reading, a value read per instance against the type its sibling's
 * value names -- a pinned sibling's, a discriminator member's, or a free sibling's, which is then written
 * first.
 */

const ID = 'https://example.test/dependent.tn';
let counter = 0;

function schema(declarations: string, id = ID): string {
  return (
    `!!id:"${id}"\n!!import:"https://tson.io/2026/40/m/meta.tn"\n` +
    `!!import:"https://tson.io/2026/40/m/core.tn"\n!schema {\n${declarations}\n}\n`
  );
}

const CELLS = schema(`
  point     => { x: int32  y: int32 }
  cell      => { kind: meta.type_ref  v?: kind! }
  int_cell  => cell & { kind?: = int32 }
  defaulted => { kind?: meta.type_ref ~ int32  v?: kind! }
  box       => <T> { item: T }
  slot      => abstract { kind: meta.type_ref =?  v?: kind! }
  int_slot  => slot & { kind?: = int32 }
  text_slot => slot & { kind?: = text }
  rack      => { s: slot }
  grouped   => { ( kind: meta.type_ref | name: text )  v?: kind! }
  labelled  => { ( kind: meta.type_ref | name: text )  ( v: kind! | w: text )? }`);

function resolved(declarations: string): void {
  counter += 1;
  standardLibrary().resolveSchema(
    encodeUtf8(schema(declarations, `https://example.test/dependent-${String(counter)}.tn`)),
  );
}

/** The message `declarations` is refused with, or `undefined` where it loads. */
function refusal(declarations: string): string | undefined {
  try {
    resolved(declarations);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function instance(): Promise<Tson> {
  const tson = standardLibrary({ schemaSource: mapSchemaSource({ [ID]: encodeUtf8(CELLS) }) });
  await tson.preload([ID]);
  return tson;
}

async function validated(document: string): Promise<readonly Diagnostic[]> {
  const tson = await instance();
  return tson.validateDocument(encodeUtf8(`!!import:"${ID}"\n${document}`)).diagnostics;
}

async function only(document: string): Promise<Diagnostic> {
  const found = await validated(document);
  expect(found, document).toHaveLength(1);
  const [first] = found;
  if (first === undefined) throw new Error('unreachable');
  return first;
}

describe('§5.2 the sibling’s rules', () => {
  it('a dependent field over each readable sibling resolves', () => {
    for (const declarations of [
      'cell => { kind: meta.type_ref  v?: kind!  w: kind! }',
      'cell => { kind?: meta.type_ref ~ int32  v?: kind! }',
      'cell => { kind: meta.type_ref  v?: kind! }\n pinned => cell & { kind?: = int32 }',
      'cell => { kind: meta.type_ref  v?: kind! }\n strict => cell & { v: kind! }',
      'records => meta.ref<meta.record>\n shape => { kind: records  v?: kind! }',
      'base => { kind: meta.type_ref }\n cell => base & { v?: kind! }',
      'cell => !meta.record { fields: { kind => meta.type_ref  v => !meta.record_field { type: { of: !meta.dependent { on: kind } } } } }',
      'cell => abstract { kind: meta.type_ref =?  v?: kind! }\n int_cell => cell & { kind?: = int32 }',
    ]) {
      expect(refusal(declarations), declarations).toBeUndefined();
    }
  });

  it('a dependent field in a parametric record resolves where the record is applied (§5.10)', () => {
    const declarations = 'pair => <T> { kind: meta.type_ref  v?: kind!  w: T }\n p => pair<text>';
    expect(refusal(declarations), declarations).toBeUndefined();
  });

  it('the sibling is declared before its dependent field', () => {
    expect(refusal('cell => { v?: kind!  kind: meta.type_ref }')).toContain('is declared after it');
    expect(refusal('kind => { a: text }\n cell => { v?: kind! }')).toContain("has no field 'kind'");
  });

  it('the sibling is typed by a reference to types', () => {
    expect(refusal('cell => { n: int32  v?: n! }')).toContain("which is typed 'int32'");
    expect(
      refusal(
        'method => { verb: text }\n calls => meta.ref<method>\n cell => { m: calls  v?: m! }',
      ),
    ).toContain("which is typed 'calls'");
  });

  it('the sibling is there to read whenever its dependent field is', () => {
    expect(refusal('cell => { kind?: meta.type_ref  v?: kind! }')).toContain(
      'optional with no default',
    );
    expect(refusal('cell => { kind: meta.type_ref?  v?: kind! }')).toContain('which is voidable');
  });

  it('a sibling may be a field group member beside an optional dependent field', () => {
    for (const declarations of [
      'cell => { ( kind: meta.type_ref | name: text )  v?: kind! }',
      'cell => { ( kind: meta.type_ref | name: text )?  v?: kind! }',
      'cell => { ( kind: meta.type_ref | name: text )  ( v: kind! | w: text )? }',
      'cell => { ( kind: meta.type_ref | name: text )  ( v: kind! | w: text ) }',
    ]) {
      expect(refusal(declarations), declarations).toBeUndefined();
    }
  });

  it('a field group member is no sibling of a required dependent field', () => {
    expect(refusal('cell => { ( kind: meta.type_ref | name: text )  v: kind! }')).toContain(
      "a member of a field group, and 'v' is required",
    );
    expect(
      refusal(
        'cell => { ( kind: meta.type_ref | name: text )  v?: kind! }\n must => cell & { v: kind! }',
      ),
    ).toContain("a member of a field group, and 'v' is required");
  });

  it('a sibling’s pin or default names no parametric record', () => {
    expect(
      refusal('box => <T> { item: T }\n cell => { kind?: meta.type_ref = box  v?: kind! }'),
    ).toContain("'box' is a parametric record");
    expect(
      refusal('box => <T> { item: T }\n cell => { kind?: meta.type_ref ~ box  v?: kind! }'),
    ).toContain("'box' is a parametric record");
  });

  it('a dependent field is never voidable and carries no value', () => {
    expect(refusal('cell => { kind: meta.type_ref  v?: kind! ~ 5 }')).toContain(
      'carries a default',
    );
    expect(refusal('cell => { kind: meta.type_ref  v?: kind! = 5 }')).toContain('carries a pin');
    expect(
      refusal(
        'cell => !meta.record { fields: { kind => meta.type_ref  v => !meta.record_field { ' +
          'type: { of: !meta.dependent { on: kind } }  optional: true  voidable: true } } }',
      ),
    ).toContain('is voidable');
  });

  it('a dependent field is restated only as itself', () => {
    expect(
      refusal(
        'cell => { kind: meta.type_ref  v?: kind! }\n int_cell => cell & { kind?: = int32  v?: int32 }',
      ),
    ).toContain('a dependent field is restated only as itself');
  });
});

describe('§5.2 reading, tree mode', () => {
  it('each instance is read against the type its sibling names', async () => {
    expect(await validated('!cell { kind: int32  v: 5 }')).toEqual([]);
    expect(await validated('!cell { kind: point  v: { x: 1  y: 2 } }')).toEqual([]);
    expect((await only('!cell { kind: point  v: 5 }')).path).toBe('/v');
    const tson = await instance();
    const read = tson.readDocument(encodeUtf8(`!!import:"${ID}"\n!cell { kind: text  v: hello }`));
    expect(read.kind).toBe('record');
    if (read.kind === 'record')
      expect(read.fields.get('v')).toMatchObject({ kind: 'atom', value: 'hello' });
  });

  it('a defaulted or pinned sibling types an omitted one', async () => {
    expect(await validated('!defaulted { v: 7 }')).toEqual([]);
    expect((await only('!defaulted { v: hello }')).path).toBe('/v');
    expect(await validated('!int_cell { v: 7 }')).toEqual([]);
    expect((await only('!int_cell { v: hello }')).path).toBe('/v');
  });

  it('only a free sibling orders the fields: a pinned one or a discriminator may follow', async () => {
    const early = await only('!cell { v: 5  kind: int32 }');
    expect(early.path).toBe('/v');
    expect(early.message).toContain("written before 'kind'");
    expect((await only('!defaulted { v: 5  kind: int32 }')).path).toBe('/v');
    expect(await validated('!int_cell { v: 7  kind: int32 }')).toEqual([]);
    expect(await validated('!rack { s: { v: 5  kind: int32 } }')).toEqual([]);
    expect((await only('!rack { s: { v: hello  kind: int32 } }')).path).toBe('/s/v');
  });

  it('a dependent field written without its group member sibling is refused at the field', async () => {
    const absent = await only('!grouped { name: x  v: 5 }');
    expect(absent.code).toBe('VALIDATION_ERROR');
    expect(absent.path).toBe('/v');
    expect(absent.message).toContain("is written without 'kind'");
    expect(absent.message).not.toContain('before');
    const member = await only('!labelled { name: x  v: 5 }');
    expect(member.path).toBe('/v');
    expect(member.message).toContain("is written without 'kind'");
    const required = await only('!cell { v: 5 }');
    expect(required.code).toBe('FIELD_REQUIRED');
    expect(required.path).toBe('/kind');
  });

  it('a group member sibling reads as any free sibling does', async () => {
    expect(await validated('!grouped { kind: int32  v: 5 }')).toEqual([]);
    expect(await validated('!grouped { name: x }')).toEqual([]);
    expect(await validated('!labelled { kind: text  v: hello }')).toEqual([]);
    expect(await validated('!labelled { name: x  w: y }')).toEqual([]);
    expect((await only('!grouped { kind: int32  v: hello }')).path).toBe('/v');
    const early = await only('!grouped { v: 5  kind: int32 }');
    expect(early.path).toBe('/v');
    expect(early.message).toContain("written before 'kind'");
  });

  it('a value entry writing a dependent field without its sibling does not load', () => {
    expect(
      refusal(
        'cell => { ( kind: meta.type_ref | name: text )  v?: kind! }\n a => !cell { name: x  v: 5 }',
      ),
    ).toContain("is written without 'kind'");
  });

  it('a sibling naming no readable type is refused at the sibling', async () => {
    expect((await only('!cell { kind: box  v: { item: 5 } }')).path).toBe('/kind');
    // `kind!` is schema grammar, and no value spells it ([TSON-DATA] §7.2.5).
    expect((await validated('!cell { kind: kind!  v: 5 }')).map((d) => d.path)).toContain('/kind');
    // A parametric record is no member of `meta.type_ref`: no reference names one bare (§4.2, §5.10).
    expect((await only('!cell { kind: box }')).path).toBe('/kind');
  });
});

describe('§5.2 the kernel’s own dependent fields', () => {
  const META = '!!import:"https://tson.io/2026/40/m/meta.tn"\n';

  it('record_field.value is read against its type', () => {
    const tson = standardLibrary();
    const check = (body: string): readonly Diagnostic[] =>
      tson.validateDocument(encodeUtf8(META + body)).diagnostics;
    expect(
      check('!meta.record_field { type: integer  optional: true  role: DEFAULT  value: 5 }'),
    ).toEqual([]);
    expect(
      check('!meta.record_field { type: boolean  optional: true  role: DEFAULT  value: 5 }').map(
        (d) => d.path,
      ),
    ).toEqual(['/value']);
    expect(
      refusal(
        'config => !meta.record { fields: { port => !meta.record_field { type: int32  ' +
          'optional: true  role: DEFAULT  value: "nope" } } }',
      ),
    ).toContain('is not a value of');
  });
});

describe('§5.10 a parametric record’s literal needs a closed type', () => {
  it('a literal on a closed field type is judged where the record is applied', () => {
    expect(refusal('box => <T> { n?: int32 ~ 5  w: T }\n b => box<text>')).toBeUndefined();
    expect(refusal('box => <T> { n?: int32 ~ nope  w: T }\n b => box<text>')).toContain(
      'is not a value of',
    );
  });

  it('is refused at the declaration on a field typed by a parameter, whole or as an argument', () => {
    expect(refusal('box => <T> { v?: T ~ 5 }')).toContain(
      "typed by the parameter 'T' and carries the literal value '5'",
    );
    expect(refusal('box => <T> { v: T }\n boxy => <T> { w?: box<T> = x }')).toContain(
      "typed by the parameter 'T' and carries the literal value 'x'",
    );
  });
});
