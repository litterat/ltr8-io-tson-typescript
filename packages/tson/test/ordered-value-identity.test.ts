/**
 * `ordered` as part of value identity.
 */
import { describe, expect, it } from 'vitest';

import { jsonCodes, load, textCodes } from './schema-read-helpers.js';

describe.each([
  ['text', textCodes, (t: string, _j: string) => t],
  ['JSON', jsonCodes, (_t: string, j: string) => j],
] as const)('`ordered` is part of value identity (§5.3, §7.5), %s reader', (_name, run, pick) => {
  const linked = load(`tags => !array { element_type: text ordered: false }
otags => [text]
om => !map { key_type: text value_type: int32 ordered: true }
um => { text => int32 }
st => set<int32>
ss => !array { element_type: tags unique_items: true }
so => !array { element_type: otags unique_items: true }
smo => !array { element_type: om unique_items: true }
smu => !array { element_type: um unique_items: true }
sst => !array { element_type: st unique_items: true }
sets => set<otags>`);

  it('a unique array of unordered arrays refuses a reordering as a repeat', () => {
    expect(run(linked, 'ss', pick('[ ["a" "b"] ["b" "a"] ]', '[["a","b"],["b","a"]]'))).toEqual([
      'TYPE_MISMATCH',
    ]);
  });

  it('a unique array of ordered arrays admits a reordering', () => {
    expect(run(linked, 'so', pick('[ ["a" "b"] ["b" "a"] ]', '[["a","b"],["b","a"]]'))).toEqual([]);
    expect(run(linked, 'sets', pick('[ ["a" "b"] ["b" "a"] ]', '[["a","b"],["b","a"]]'))).toEqual(
      [],
    );
  });

  it('a set of sets refuses [[1 2] [2 1]]', () => {
    expect(run(linked, 'sst', pick('[ [1 2] [2 1] ]', '[[1,2],[2,1]]'))).toEqual(['TYPE_MISMATCH']);
  });

  it('an unordered map ignores entry order, an ordered map does not', () => {
    const t = '[ { a => 1 b => 2 } { b => 2 a => 1 } ]';
    const j = '[{"a":1,"b":2},{"b":2,"a":1}]';
    expect(run(linked, 'smu', pick(t, j))).toEqual(['TYPE_MISMATCH']);
    expect(run(linked, 'smo', pick(t, j))).toEqual([]);
  });
});
