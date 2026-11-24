import { describe, expect, it } from 'vitest';

import { mapSchemaSource } from '../src/config.js';
import type { Tson } from '../src/config.js';
import type { Diagnostic } from '../src/core/diagnostic.js';
import {
  TsonContentHashMismatchError,
  TsonLimitRefusedError,
  TsonSchemaValidationError,
} from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { standardLibrary } from '../src/stdlib/index.js';
import type { RecordNode, Value } from '../src/tree/nodes.js';

/**
 * The extern ([TSON-SCHEMA] §5.13, §7.9): one entry of another schema under a name of the declaring document, a hop
 * judged by its target's identity, sealed, loaded with the imports, and a value at its position read in the foreign
 * schema's scope.
 */

const CORE = '!!import:"https://tson.io/2026/40/m/core.tn"';

const ORDER_1 = `!!id:"https://example.test/order-1.tn"
${CORE}
!schema {
  order      => { id: text  payment: card }
  card       => { number: text }
  rush_order => order & { by: text }
  pet        => abstract { name: text }
  dog        => pet & { barks: boolean }
  count      => !integer ^ { min: 0 }
  box        => <T> { v: T }
  geo        => !schema { address => { street: text } }
  my_list    => meta.array
  o1         => !order { id: A  payment: { number: "1" } }
}`;

const ORDER_2 = `!!id:"https://example.test/order-2.tn"
${CORE}
!schema {
  order => { ref: text  lines: [line]  payment: card }
  line  => { sku: text  qty: int32 }
  card  => { pan: text }
}`;

const SHIPPING = `!!id:"https://example.test/shipping.tn"
${CORE}
!schema {
  order_v1 => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }
  order_v2 => !meta.extern { schema: "https://example.test/order-2.tn"  type: order }
  rush_v1  => !meta.extern { schema: "https://example.test/order-1.tn"  type: rush_order }
  pet_x    => !meta.extern { schema: "https://example.test/order-1.tn"  type: pet }
  dog_x    => !meta.extern { schema: "https://example.test/order-1.tn"  type: dog }
  count_x  => !meta.extern { schema: "https://example.test/order-1.tn"  type: count }
  envelope => { id: text  body: (order_v1 | order_v2) }
  first    => { o: order_v1 }
  animals  => { p: pet_x }
  tally    => { c: count_x }
}`;

function instance(documents: Record<string, string> = {}): Tson {
  const encoded: Record<string, Uint8Array> = {};
  for (const [id, text] of Object.entries(documents)) encoded[id] = encodeUtf8(text);
  return standardLibrary({ schemaSource: mapSchemaSource(encoded) });
}

const LIBRARY = {
  'https://example.test/order-1.tn': ORDER_1,
  'https://example.test/order-2.tn': ORDER_2,
};

/** A schema declaring `body`'s entries over core.tn, the two order schemas available to it. */
function declaring(body: string, id = 'https://example.test/subject.tn'): string {
  return `!!id:"${id}"\n${CORE}\n!schema {\n${body}\n}`;
}

async function loadError(text: string, documents = LIBRARY): Promise<unknown> {
  try {
    await instance(documents).loadSchema(text);
  } catch (error) {
    return error;
  }
  throw new Error('expected the schema to be refused, and it loaded');
}

async function validated(document: string): Promise<readonly Diagnostic[]> {
  const tson = instance({ ...LIBRARY, 'https://example.test/shipping.tn': SHIPPING });
  await tson.preload(['https://example.test/shipping.tn']);
  return tson.validateDocument(encodeUtf8(document)).diagnostics;
}

async function read(document: string): Promise<Value> {
  const tson = instance({ ...LIBRARY, 'https://example.test/shipping.tn': SHIPPING });
  await tson.preload(['https://example.test/shipping.tn']);
  return tson.readDocument(encodeUtf8(document));
}

const IMPORT_SHIPPING = '!!import:"https://example.test/shipping.tn"';

describe('an extern names one entry of another schema (§5.13)', () => {
  it('§5.13: two schemas that each declare `order` are named by one document through externs', async () => {
    const tson = instance(LIBRARY);
    const linked = await tson.loadSchema(SHIPPING);
    expect(linked.entries.get('order_v1')?.kind).toBe('extern');
    // None of the foreign schemas' names enter the namespace (§3.3).
    expect(linked.entries.has('order')).toBe(false);
    expect(linked.entries.has('card')).toBe(false);
  });

  it('§2.2.3, §3.5: importing both schemas that declare `order` is refused', async () => {
    const both = `!!id:"https://example.test/both.tn"
${CORE}
!!import:"https://example.test/order-1.tn"
!!import:"https://example.test/order-2.tn"
!schema { x => { o: order } }`;
    expect(await loadError(both)).toBeInstanceOf(TsonSchemaValidationError);
  });

  it.each([
    ['meta.record', 'https://tson.io/2026/40/m/meta.tn', 'a constructor'],
    ['enum', 'https://tson.io/2026/40/m/meta.tn', 'an incomplete entry'],
    ['box', 'https://example.test/order-1.tn', 'a parametric record'],
    ['geo', 'https://example.test/order-1.tn', 'a schema map'],
    ['my_list', 'https://example.test/order-1.tn', 'an alias of a constructor'],
    ['o1', 'https://example.test/order-1.tn', 'a value entry'],
    ['line', 'https://example.test/order-1.tn', 'a name the foreign closure lacks'],
  ])(
    '§5.13: an extern naming `%s` of %s, %s, is refused against the extern',
    async (type, schema) => {
      const error = await loadError(
        declaring(`x => !meta.extern { schema: "${schema}"  type: ${type} }\n use => { f: x }`),
      );
      expect(error).toBeInstanceOf(TsonSchemaValidationError);
      expect((error as Error).message).toContain(`'x' is an extern of '${type}'`);
    },
  );

  it('§5.13: an extern into a schema that imports nothing is admitted', async () => {
    const free = `!!id:"https://example.test/free.tn"
!schema { node => { next?: node } }`;
    const tson = instance({ 'https://example.test/free.tn': free });
    const linked = await tson.loadSchema(
      declaring('n => !meta.extern { schema: "https://example.test/free.tn"  type: node }'),
    );
    expect(linked.externs?.get('n')?.type).toBe('node');
  });
});

describe('an extern is sealed (§5.13)', () => {
  const extern =
    'order_v1 => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }';
  const count =
    'count_x => !meta.extern { schema: "https://example.test/order-1.tn"  type: count }';
  it.each([
    ['composition', `${extern}\n y => order_v1 & { extra: text }`, "'&' and '-' compose"],
    ['subtraction', `${extern}\n y => order_v1 - { id }`, "'&' and '-' compose"],
    ['refinement', `${count}\n y => !count_x ^ { max: 3 }`, "'^' refines"],
    ['a construction head', `${extern}\n y => !order_v1 { id: x }`, 'constructs'],
    ['an application head', `${extern}\n y => { f: order_v1<text> }`, 'applies'],
    ['a default', `${count}\n y => { f?: count_x ~ 3 }`, 'its default 3'],
    ['a pin', `${count}\n c => count_x\n y => { f?: c = 3 }`, "an alias of 'count_x'"],
  ])('§5.13: %s through an extern is refused', async (_what, body, says) => {
    const error = await loadError(declaring(body));
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain(says);
    expect((error as Error).message).toContain('an extern is sealed');
  });

  it('§5.12, §5.13: no qualified name selects through an extern', async () => {
    const error = await loadError(
      declaring(
        `${extern}\n api => { r: meta.ref<meta.record> }\n v => !api { r: order_v1.payment }`,
      ),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain('no name walks through an extern');
  });

  it('§5.13: a head reaching `meta.extern` through an alias is no extern head', async () => {
    const error = await loadError(
      declaring(
        'ext => meta.extern\n o => !ext { schema: "https://example.test/order-1.tn"  type: order }',
      ),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain("an extern is written '!meta.extern'");
  });
});

describe('an extern is a hop, judged by identity (§5.13, §5.4, §4.2)', () => {
  it('§5.4, §5.13: two externs of one entry are one variant written twice', async () => {
    const error = await loadError(
      declaring(`a => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }
 b => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }
 either => (a | b)`),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain('one type written twice');
  });

  it('§5.4, §5.13: a choice of externs of two records is not disjoint; of a record and an atom it is', async () => {
    const tson = instance(LIBRARY);
    const linked = await tson.loadSchema(
      declaring(`a => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }
 b => !meta.extern { schema: "https://example.test/order-2.tn"  type: order }
 c => !meta.extern { schema: "https://example.test/order-1.tn"  type: count }
 records => (a | b)
 mixed   => (a | c)`),
    );
    const disjoint = (name: string): boolean | undefined => {
      const entry = linked.entries.get(name);
      return entry?.kind === 'choice' ? entry.disjoint : undefined;
    };
    expect(disjoint('records')).toBe(false);
    expect(disjoint('mixed')).toBe(true);
  });

  it('§4.2, §5.13: a reference over meta.record admits an extern of a record and refuses one of an atom', async () => {
    const tson = instance(LIBRARY);
    await tson.loadSchema(
      declaring(`o => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }
 holder => { r?: meta.ref<meta.record> ~ o }`),
    );
    const error = await loadError(
      declaring(`c => !meta.extern { schema: "https://example.test/order-1.tn"  type: count }
 holder => { r?: meta.ref<meta.record> ~ c }`),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain('is no member of it');
  });

  it('§4.2, §5.12, §5.13: a value naming an extern of a record at a reference over meta.record is a member', async () => {
    const tson = instance(LIBRARY);
    const linked = await tson.loadSchema(
      declaring(`o => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }
 api => { r: meta.ref<meta.record> }
 v => !api { r: o }`),
    );
    expect(linked.entries.get('v')?.kind).toBe('value_entry');
  });
});

describe('an extern is a dependency, read with the imports (§5.13, §3.4.1, §2.2.3)', () => {
  it('§10.2, §5.13: a pin on the extern that does not match its schema refuses the declarer', async () => {
    const error = await loadError(
      declaring(
        `o => !meta.extern { schema: "https://example.test/order-1.tn?sha256=${'0'.repeat(64)}"  type: order }`,
      ),
    );
    expect(error).toBeInstanceOf(TsonContentHashMismatchError);
  });

  it('§2.2.3: a schema importing its own identity is an import cycle, never a fetch', async () => {
    const self = `!!id:"https://example.test/self.tn"
${CORE}
!!import:"https://example.test/self.tn"
!schema { a => { x: text } }`;
    const error = await loadError(self, {} as typeof LIBRARY);
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain('import cycle');
    // The synchronous front door sees the same cycle in the document's own header.
    expect(() => instance().resolveSchema(self)).toThrow(/import cycle/);
  });

  it('§5.13: a schema naming its own identity by an extern is a reference cycle through an extern', async () => {
    const self = declaring(
      'a => { x: text }\n me => !meta.extern { schema: "https://example.test/self.tn"  type: a }',
      'https://example.test/self.tn',
    );
    const error = await loadError(self);
    expect((error as Error).message).toContain('reference cycle through an extern');
  });

  it('§3.4.1, §5.13: an import one way and an extern the other close one cycle', async () => {
    const back = `!!id:"https://example.test/back.tn"
${CORE}
!schema {
  b  => { a?: aa }
  aa => !meta.extern { schema: "https://example.test/front.tn"  type: a }
}`;
    const front = `!!id:"https://example.test/front.tn"
${CORE}
!!import:"https://example.test/back.tn"
!schema { a => { b: b } }`;
    const error = await loadError(front, {
      ...LIBRARY,
      'https://example.test/back.tn': back,
    } as typeof LIBRARY);
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain("-[extern 'aa']-> example.test/front.tn");
  });

  it("§5.13: a closure reached through an extern holding another revision's kernel is refused, unfetched", async () => {
    // Deliberately not this revision's kernel: the Revision 39 identity stands for any other revision's.
    const anotherRevisionsKernel = 'https://tson.io/2026/39/m/meta.tn';
    const error = await loadError(
      declaring(`k => !meta.extern { schema: "${anotherRevisionsKernel}"  type: text }`),
    );
    expect(error).toBeInstanceOf(TsonSchemaValidationError);
    expect((error as Error).message).toContain("holds the kernel 'tson.io/2026/39/m/meta.tn'");
  });

  it('§11.5: the import closure counts a schema reached by an extern', async () => {
    const encoded: Record<string, Uint8Array> = {};
    for (const [id, text] of Object.entries(LIBRARY)) encoded[id] = encodeUtf8(text);
    const tson = standardLibrary({
      schemaSource: mapSchemaSource(encoded),
      limits: { maxImportClosure: 6 },
    });
    // core.tn's closure is five schemas (the kernel, the three libraries, core.tn); the extern adds a sixth and
    // order-1.tn's own import of core.tn adds nothing.
    await tson.loadSchema(
      declaring('o => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }'),
    );
    const tighter = standardLibrary({
      schemaSource: mapSchemaSource(encoded),
      limits: { maxImportClosure: 5 },
    });
    await expect(
      tighter.loadSchema(
        declaring('o => !meta.extern { schema: "https://example.test/order-1.tn"  type: order }'),
      ),
    ).rejects.toBeInstanceOf(TsonLimitRefusedError);
  });
});

describe('a value at an extern position is read in the foreign schema (§7.9)', () => {
  it("§7.9: the scope example reads its body in the foreign schema, `!card` being order-2.tn's", async () => {
    const diagnostics = await validated(`${IMPORT_SHIPPING}
!envelope {
  id: e1
  body: !order_v2 { ref: A  lines: [{ sku: s  qty: 1 }]  payment: !card { pan: "4111" } }
}`);
    expect(diagnostics).toEqual([]);
  });

  it('§7.9: a name inside the value resolves in the foreign schema alone', async () => {
    // order-1.tn's card has `number`; order-2.tn's has `pan`.
    const diagnostics = await validated(`${IMPORT_SHIPPING}
!envelope { id: e1  body: !order_v2 { ref: A  lines: []  payment: { number: "4111" } } }`);
    expect(diagnostics.map((d) => d.path)).toContain('/body/payment/number');
  });

  it('§7.9: a diagnostic inside the value names the foreign schema and the extern', async () => {
    const [first] = await validated(`${IMPORT_SHIPPING}
!tally { c: -1 }`);
    expect(first?.code).toBe('ATOM_CONSTRAINT_VIOLATION');
    expect(first?.schemaId).toBe('example.test/order-1.tn');
    expect(first?.message).toContain("through the extern 'count_x' of example.test/shipping.tn");
  });

  it('§5.4, §7.9: an untagged value at a choice of externs of two records needs the tag', async () => {
    const diagnostics = await validated(`${IMPORT_SHIPPING}
!envelope { id: e1  body: { id: A  payment: { number: "1" } } }`);
    expect(diagnostics.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
  });

  it("§7.9: the foreign schema's own name is unresolved at the boundary", async () => {
    const diagnostics = await validated(`${IMPORT_SHIPPING}
!first { o: !order { id: A  payment: { number: "1" } } }`);
    expect(diagnostics.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });

  it("§7.9: an extern of a subtype is admitted at its supertype's extern", async () => {
    const diagnostics = await validated(`${IMPORT_SHIPPING}
!first { o: !rush_v1 { id: A  payment: { number: "1" }  by: noon } }`);
    expect(diagnostics).toEqual([]);
  });

  it('§7.2, §7.9: an untagged value at an extern of an abstract record naming no selectors is refused', async () => {
    const refused = await validated(`${IMPORT_SHIPPING}
!animals { p: { name: rex } }`);
    expect(refused.map((d) => d.code)).toEqual(['TYPE_MISMATCH']);
    const admitted = await validated(`${IMPORT_SHIPPING}
!animals { p: !dog_x { name: rex  barks: true } }`);
    expect(admitted).toEqual([]);
  });

  it("§6, §7.9: the annotations in front of a foreign value are the enclosing scope's", async () => {
    const refused = await validated(`${IMPORT_SHIPPING}
!first { o: @card { id: A  payment: { number: "1" } } }`);
    expect(refused.map((d) => d.code)).toEqual(['UNKNOWN_TYPE_REF']);
  });

  it("§7.9: a tree value at the boundary carries the outer scope's name for it", async () => {
    const root = (await read(`${IMPORT_SHIPPING}
!first { o: { id: A  payment: !card { number: "1" } } }`)) as RecordNode;
    const o = root.fields.get('o') as RecordNode;
    expect(o.typeRef).toBe('order_v1');
    // The names inside stay the foreign schema's.
    expect((o.fields.get('payment') as RecordNode).typeRef).toBe('card');
  });
});
