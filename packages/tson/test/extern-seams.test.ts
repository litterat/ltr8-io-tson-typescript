/**
 * The judgements of a schema holding externs that ask IS-A or disjointness of what a name reaches ([TSON-SCHEMA]
 * §5.13, §8.3): an extern is another name for the entry it lands on, so each is asked of that entry, by identity --
 * a restated field's type (§5.8), a reference's narrowed `of` (§5.7), an argument against its parameter's bound and a
 * bound passed on (§5.10), and a variant that is a choice (§5.4), one rule whether the choice is reached through an
 * extern or not.
 */
import { describe, expect, it } from 'vitest';

import { mapSchemaSource } from '../src/config.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import { checkExternVariants } from '../src/link/externChecks.js';
import { externHopsOf } from '../src/link/externHops.js';
import { standardLibrary } from '../src/stdlib/index.js';

const CORE = '!!import:"https://tson.io/2026/40/m/core.tn"';
const ORDERS = 'https://example.test/seam-orders.tn';

const LIBRARY: Record<string, string> = {
  [ORDERS]: `!!id:"${ORDERS}"
${CORE}
!schema {
  order  => { id: text }
  rush   => order & { by: text }
  card   => { number: text }
  either => ( card | order )
  loose  => ( int32 | int64 )
}`,
};

const EXTERNS = `order_x => !meta.extern { schema: "${ORDERS}"  type: order }
rush_x  => !meta.extern { schema: "${ORDERS}"  type: rush }
card_x  => !meta.extern { schema: "${ORDERS}"  type: card }
loose_x => !meta.extern { schema: "${ORDERS}"  type: loose }`;

let counter = 0;

/** A schema importing core.tn and the orders schema, declaring the externs above and `body`. */
function subject(body: string): string {
  counter += 1;
  return `!!id:"https://example.test/seam-${String(counter)}.tn"
${CORE}
!!import:"${ORDERS}"
!schema {
${EXTERNS}
${body}
}`;
}

async function load(body: string) {
  const encoded: Record<string, Uint8Array> = {};
  for (const [id, text] of Object.entries(LIBRARY)) encoded[id] = encodeUtf8(text);
  return standardLibrary({ schemaSource: mapSchemaSource(encoded) }).loadSchema(subject(body));
}

async function loadError(body: string): Promise<string | undefined> {
  try {
    await load(body);
    return undefined;
  } catch (error) {
    if (!(error instanceof TsonSchemaValidationError)) throw error;
    return error.message;
  }
}

describe('§5.8 a restated field’s type is judged at the entry it reaches, by identity', () => {
  it('a field typed by an extern, restated by the imported name of the same entry, narrows', async () => {
    expect(await loadError('base => { o: order_x }\nsame => base & { o: order }')).toBeUndefined();
  });

  it('restated by a type IS-A the entry the extern lands on, it narrows', async () => {
    expect(await loadError('base => { o: order_x }\nsub => base & { o: rush }')).toBeUndefined();
    expect(await loadError('base => { o: order }\nsub => base & { o: rush_x }')).toBeUndefined();
  });

  it('restated by an extern of an unrelated entry, it is refused', async () => {
    expect(await loadError('base => { o: order_x }\nwrong => base & { o: card_x }')).toMatch(
      /not a valid restatement of 'base''s fields \(§5\.8\): field 'o' is typed 'card_x'/,
    );
  });
});

describe('§5.10 an argument and a bound are judged at the entry they reach, by identity', () => {
  it('an extern of the bound’s own entry, or of an entry IS-A it, is admitted', async () => {
    expect(
      await loadError('box => <T: order> { v: T }\nb1 => box<order_x>\nb2 => box<rush_x>'),
    ).toBeUndefined();
    expect(
      await loadError('box => <T: order_x> { v: T }\nb1 => box<order>\nb2 => box<rush>'),
    ).toBeUndefined();
  });

  it('an extern of an unrelated entry is refused', async () => {
    expect(await loadError('box => <T: order> { v: T }\nb => box<card_x>')).toMatch(
      /binds 'T' to 'card_x', which is not a type that IS-A order/,
    );
  });

  it('a bound passed on is judged through the extern', async () => {
    expect(
      await loadError('box => <T: order> { v: T }\nrebox => <T: order_x> { b: box<T> }'),
    ).toBeUndefined();
    expect(
      await loadError('box => <T: order> { v: T }\nrebox => <T: card_x> { b: box<T> }'),
    ).toMatch(/card_x is not a type that IS-A order/);
  });
});

describe('§5.4 a variant that is a choice is disjoint: one rule, through an extern or not', () => {
  it('a variant landing through an extern on a choice not disjoint is refused, an extern per variant advised', async () => {
    expect(await loadError('h => { c: ( text | loose_x ) }')).toMatch(
      /has a variant 'loose_x' that is a choice not disjoint .* name each of its variants by an extern of its own/,
    );
  });

  it('a choice holding both kinds of nested choice is refused once, naming both', async () => {
    const message = await loadError(
      'mine => ( int32 | int64 )\nh => { c: ( text | mine | loose_x ) }',
    );
    expect(message).toMatch(/has variants \[mine, loose_x\] that are choices not disjoint/);
    expect(message).toMatch(
      /list its variants in its place, '\( text \| int32 \| int64 \| loose_x \)', naming each variant of \[loose_x\] by an extern of its own/,
    );
  });

  it('the extern rule over choices judges distinctness alone', async () => {
    const encoded: Record<string, Uint8Array> = {};
    for (const [id, text] of Object.entries(LIBRARY)) encoded[id] = encodeUtf8(text);
    const tson = standardLibrary({ schemaSource: mapSchemaSource(encoded) });
    const linked = await tson.loadSchema(subject('h => { c: order_x }'));
    const nested = new Map(linked.entries);
    nested.set('k', {
      kind: 'choice',
      variants: [
        { name: 'text', annotations: [] },
        { name: 'loose_x', annotations: [] },
      ],
    });
    expect(() => {
      checkExternVariants(nested, new Set(['k']), externHopsOf(linked), {
        schemaId: linked.id,
        facts: linked.facts,
      });
    }).not.toThrow();
  });
});

describe('§5.7 a reference’s narrowed `of` is judged at the entry it reaches, by identity', () => {
  it('a refinement naming the imported entry an extern of `of` lands on narrows', async () => {
    expect(
      await loadError('r => !meta.ref { of: order_x }\nr2 => !r ^ { of: rush }'),
    ).toBeUndefined();
  });

  it('a refinement naming an unrelated entry is refused', async () => {
    expect(await loadError('r => !meta.ref { of: order_x }\nr2 => !r ^ { of: card }')).toMatch(
      /not a valid refinement of '!r' \(§5\.7\)/,
    );
  });
});
