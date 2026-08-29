import { describe, expect, it } from 'vitest';
import { firstConfusableCollision, skeleton } from '../../src/unicode/skeleton.js';

// UTS #39 §4's skeleton() and [TSON-DATA] §8.2 mechanism 1: two names are confusable exactly
// when their skeletons are equal, and the mechanism refuses a colliding *pair* within one named
// scope, never a lone name. Pairs below are built from code points rather than typed literals —
// the whole point of a confusable is that the two spellings are indistinguishable in an editor,
// so a literal would be unreviewable and one careless normalisation away from testing nothing.

function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

function confusable(a: string, b: string): void {
  expect(skeleton(a), `expected confusable: ${a} / ${b}`).toBe(skeleton(b));
}

function distinct(a: string, b: string): void {
  expect(skeleton(a), `expected distinct: ${a} / ${b}`).not.toBe(skeleton(b));
}

describe('skeleton (UTS #39 §4)', () => {
  it('makes the Cyrillic homograph from §9.4 confusable with its Latin spelling', () => {
    confusable('admin', cp(0x0430) + 'dmin'); // Cyrillic а (U+0430)
    confusable('data', 'd' + cp(0x0430) + 'ta');
  });

  it('catches a whole-script confusable a restriction level cannot see', () => {
    confusable('aec', cp(0x0430, 0x0435, 0x0441));
  });

  it('catches the classic pairs §8.2 names: l/I, O/0, rn/m, Greek upsilon/u', () => {
    confusable('user', cp(0x03c5) + 'ser');
    confusable('l', 'I');
    confusable('O', '0');
    confusable('rn', 'm');
  });

  it('catches the pure-ASCII false positive §8.2 names: comer/corner, through m -> rn', () => {
    confusable('comer', 'corner');
  });

  it('is unaffected by which normalisation form the input arrived in', () => {
    confusable('caf' + cp(0x00e9), 'cafe' + cp(0x0301)); // precomposed é vs e + combining acute
  });

  it('leaves ordinary names declared together distinct', () => {
    const names = [
      'order',
      'order_id',
      'customer',
      'customer_id',
      'total',
      'subtotal',
      'created_at',
      'updated_at',
      'name',
      'email',
      'address',
      'addresses',
      'price',
      'prices',
      'item',
      'items',
      'status',
      'state',
      'type',
      'kind',
      'id_' + cp(0x043f, 0x043e, 0x043b), // id_пол (Cyrillic)
      'url_' + cp(0x0430, 0x0434, 0x0440), // url_адр (Cyrillic)
    ];
    for (const [i, a] of names.entries()) {
      for (const b of names.slice(i + 1)) {
        distinct(a, b);
      }
    }
  });
});

describe('firstConfusableCollision (§8.2 mechanism 1, over a scope)', () => {
  it('finds the colliding pair, first occurrence named first', () => {
    const cyrA = cp(0x0430);
    const collision = firstConfusableCollision(['admin', cyrA + 'dmin']);
    expect(collision).toEqual({ first: 'admin', second: cyrA + 'dmin' });
  });

  it('never fires on a lone name', () => {
    // §8.2's precision: a relation over a set fires only on a pair, so a schema that declares
    // this name alongside unrelated ones is unaffected.
    const name = 'id_' + cp(0x043f) + '_url_' + cp(0x0430);
    expect(firstConfusableCollision([name])).toBeUndefined();
  });

  it('reports neither an outright duplicate nor a repeat of the same string', () => {
    // Two different defects: an identical name appearing twice is the duplicate-name rule's job,
    // not this one's (ConfusableNames.firstCollision in the reference draws the same line).
    expect(firstConfusableCollision(['admin', 'admin', 'admin'])).toBeUndefined();
  });

  it('leaves an ordinary declared set alone', () => {
    const names = ['order', 'total', 'created_at', 'customer', 'name', 'email_address', 'status'];
    expect(firstConfusableCollision(names)).toBeUndefined();
  });

  it('is silent about scope membership itself — the caller decides what one scope is', () => {
    // firstConfusableCollision only ever sees the names it is handed; a choice's variants are
    // references into the declared-name scope, not a scope of their own — that distinction is
    // the caller's to make (see [TSON-SCHEMA] §11.4), not this module's.
    const cyrA = cp(0x0430);
    const declaredNames = ['admin', cyrA + 'dmin', 'either'];
    const collision = firstConfusableCollision(declaredNames);
    expect(collision).toEqual({ first: 'admin', second: cyrA + 'dmin' });
  });
});
