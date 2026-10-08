/**
 * Revision 37 Stage 2 repairs: each case states the spec section that requires it and is held to
 * the same answer in the text reader and the JSON reader where both read the thing.
 */
import { describe, expect, it } from 'vitest';

import {
  jsonCodes,
  jsonMessages,
  load,
  loadError,
  textCodes,
  textMessages,
} from './stage2-repair-helpers.js';
import { nfkcCasefold } from '../src/unicode/normalization.js';

describe('NFKC_CASEFOLD never goes below the NFC floor (Unicode D147; change log §8.2 item 8)', () => {
  const COMPOSED = '\u00C1\u0345';
  const DECOMPOSED = 'A\u0345\u0301';

  it('folds NFC-equal spellings to one string', () => {
    expect(COMPOSED.normalize('NFC')).toBe(DECOMPOSED.normalize('NFC'));
    expect(nfkcCasefold(COMPOSED)).toBe(nfkcCasefold(DECOMPOSED));
  });

  it('makes NFC-equal map keys one key under an NFKC_CASEFOLD key type, in both readers', () => {
    const linked = load(`cf_key => !text_type { normalization: NFKC_CASEFOLD }
m => { cf_key => int32 }`);
    expect(textCodes(linked, 'm', `{ "${COMPOSED}" => 1  "${DECOMPOSED}" => 2 }`)).toContain(
      'DUPLICATE_MAP_KEY',
    );
    expect(jsonCodes(linked, 'm', `{"${COMPOSED}":1,"${DECOMPOSED}":2}`)).toContain(
      'DUPLICATE_MAP_KEY',
    );
  });
});

describe('an enum refinement loads through the public API (§7.4, §5.6)', () => {
  it('!enum refined by members narrows the member set', () => {
    expect(() => load(`e => !enum [a b c]\ne2 => !e ^ { members: [a b] }`)).not.toThrow();
  });

  it('!text_enum and !enum_type{type} refinements load', () => {
    expect(() => load(`e => !text_enum [a b c]\ne2 => !e ^ { members: [a b] }`)).not.toThrow();
    expect(() =>
      load(
        `k => !identifier_type { }\ne => !enum_type { type: k members: [a b c] }\ne2 => !e ^ { members: [a b] }`,
      ),
    ).not.toThrow();
  });
});

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

describe('a family whose base is a record-bodied template is judged (§5.2, §5.10)', () => {
  it('two declared members pinning one value are refused', () => {
    const message = loadError(
      `pet => <N, T> { type: text = N  pet: T }\ndog => pet<"dog", text>\ndog2 => pet<"dog", int32>`,
    );
    expect(message).toMatch(/dog.*dog2|dog2.*dog/);
    expect(message).toMatch(/same value/);
  });

  it('pins compare under the selector type: "dog" and "DOG" collide under ASCII_CASEFOLD', () => {
    const header = '';
    const message = loadError(
      `sel => !text_type { normalization: ASCII_CASEFOLD }\npet => <N, T> { type: sel = N  pet: T }\ndog => pet<"dog", text>\ndog2 => pet<"DOG", int32>`,
      header,
    );
    expect(message).toMatch(/same value/);
  });

  it('distinct pins load', () => {
    expect(() =>
      load(
        `pet => <N, T> { type: text = N  pet: T }\ndog => pet<"dog", text>\ncat => pet<"cat", int32>`,
      ),
    ).not.toThrow();
  });
});

describe('only a pin on an unmarked name is a selector (§5.10, §3.2 item 33)', () => {
  const discriminatorsOf = (linked: ReturnType<typeof load>): unknown =>
    (linked.entries.get('pet')?.body as { discriminators?: unknown }).discriminators;

  it('`type: text = N` is a selector', () => {
    expect(discriminatorsOf(load(`pet => <N, T> { type: text = N  pet: T }`))).toEqual(['type']);
  });

  it('`type?: text = N` is an injected pin and selects nothing', () => {
    const linked = load(
      `pet => <N, T> { type?: text = N  pet: T }\ndog => pet<"dog", text>\no => { p: dog }`,
    );
    expect(discriminatorsOf(linked)).toBeUndefined();
    expect(textCodes(linked, 'o', '{ p: { pet: x } }')).toEqual([]);
    expect(jsonCodes(linked, 'o', '{"p":{"pet":"x"}}')).toEqual([]);
  });
});

describe('§5.11 declaration rules hold for a group written as a `!record` literal', () => {
  const fields = (...names: string[]): string =>
    `fields: [ ${names.map((n) => `{ name: ${n} type: text optional: true }`).join(' ')} ]`;

  it('accepts the shapes the sugar accepts', () => {
    expect(() =>
      load(`r => !record { ${fields('a', 'b')} groups: [ { members: [[a] [b]] } ] }`),
    ).not.toThrow();
    expect(() =>
      load(
        `r => !record { ${fields('a', 'b')} groups: [ { members: [[a b]] optional_members: [a b] } ] }`,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'an optional_members entry that is no member',
      `${fields('a', 'b')} groups: [ { members: [[a] [b]] optional_members: [c] } ]`,
    ],
    [
      'a marked only member of an option',
      `${fields('a', 'b')} groups: [ { members: [[a] [b]] optional_members: [a] } ]`,
    ],
    [
      'a bare single option with an unmarked member',
      `${fields('a', 'b')} groups: [ { members: [[a b]] optional_members: [a] } ]`,
    ],
    [
      'an optional single option of one member',
      `${fields('a')} groups: [ { members: [[a]] optional: true } ]`,
    ],
    [
      'a member in two groups',
      `${fields('a', 'b', 'c')} groups: [ { members: [[a] [b]] } { members: [[a] [c]] } ]`,
    ],
    [
      'a member that is not optional',
      `fields: [ { name: a type: text } { name: b type: text optional: true } ] groups: [ { members: [[a] [b]] } ]`,
    ],
    ['a member naming no field', `${fields('a')} groups: [ { members: [[a] [z]] } ]`],
  ])('refuses %s', (_label, body) => {
    expect(loadError(`r => !record { ${body} }`)).toMatch(/field group is refused/);
  });
});

describe('a `scoped.schemas` key is a schema_identity (§7.8, change log §8.2 item 9)', () => {
  it('refuses a key that carries a fragment', () => {
    expect(
      loadError(`s => !scoped { scope: [EXTERN] schemas: { "https://a.test/x.tn#f" => _ } }`),
    ).toMatch(/fragment/);
  });

  it('admits an absolute or a relative identity', () => {
    expect(
      loadError(`s => !scoped { scope: [EXTERN] schemas: { "https://a.test/x.tn" => _ } }`),
    ).toBeUndefined();
    expect(
      loadError(`s => !scoped { scope: [EXTERN] schemas: { "lib/x.tn" => _ } }`),
    ).toBeUndefined();
  });
});

describe('enum members are judged under the label type’s profile (§7.4)', () => {
  it('a member the profile adds is exempt, as a value of the family at a position is', () => {
    expect(
      loadError(
        `k => !identifier_type { continue_add: "+" }\ne => !enum_type { type: k members: ["a+b"] }`,
      ),
    ).toBeUndefined();
  });

  it('a member the profile does not add is still refused', () => {
    expect(
      loadError(
        `k => !identifier_type { continue_add: "+" }\ne => !enum_type { type: k members: ["a$b"] }`,
      ),
    ).toBeDefined();
  });
});

describe('a narrowed member set keeps the inherited order (§7.5)', () => {
  const membersOf = (linked: ReturnType<typeof load>, name: string): unknown =>
    (linked.entries.get(name)?.body as { members?: unknown; schemes?: unknown }).members;

  it('an enum refined to a reordered subset resolves in the inherited order', () => {
    const linked = load(`e => !enum [a b c]\ne2 => !e ^ { members: [c a] }`);
    expect(membersOf(linked, 'e2')).toEqual(['a', 'c']);
  });

  it('schemes compare ASCII-folded and resolve in the inherited order', () => {
    const linked = load(
      `u => !uri_reference ^ { schemes: [https http ftp] }\nu2 => !u ^ { schemes: [FTP https] }`,
    );
    expect((linked.entries.get('u2')?.body as { schemes?: unknown }).schemes).toEqual([
      'https',
      'ftp',
    ]);
  });
});

describe('identifier diagnostics index code points, never UTF-16 units (§2.6, §7.7)', () => {
  const linked = load(`n => !identifier_type { }\nh => { n: n }`);

  it('names the code point index of a character after a supplementary one, in both readers', () => {
    const text = textMessages(linked, 'h', '{ n: "a\\u{1D400}!" }');
    const json = jsonMessages(linked, 'h', '{"n":"a\u{1D400}!"}');
    expect(text.join(' ')).toContain('at index 2');
    expect(json.join(' ')).toContain('at index 2');
  });

  it('counts a medial run in code points', () => {
    const profile = load(`m => !identifier_type { medial: "." }\nh => { n: m }`);
    const message = textMessages(profile, 'h', '{ n: "a\\u{1D400}..b" }').join(' ');
    expect(message).toContain('at index 3');
  });
});

describe('a template application is checked at the call site (§5.10)', () => {
  const v = `v => <N> !array { element_type: text  min_items: N }`;

  it('a declaration naming a constructor-template application is checked before materialising', () => {
    expect(loadError(`${v}\nx => v<"two">`)).toMatch(/binds 'N' to 'two'/);
    expect(loadError(`${v}\nx => { f: v<"two"> }`)).toMatch(/binds 'N' to 'two'/);
    expect(loadError(`${v}\nx => v<2>`)).toBeUndefined();
  });

  it('a literal type argument is refused at the writing declaration, not at a minted name', () => {
    const message = loadError(`boxed => <T> { a: T }\nx => boxed<3>`);
    expect(message).toMatch(/binds 'T' to the literal '3'/);
    expect(message).not.toMatch(/boxed_3/);
    expect(loadError(`boxed => <T> { a: T }\nx => { f: boxed<3> }`)).toMatch(/literal '3'/);
  });

  it('a parameter’s type names an earlier parameter only', () => {
    expect(loadError(`p => <T, V: T> { a: T  b?: T ~ V }`)).toBeUndefined();
    expect(loadError(`p => <V: T, T> { a: T  b?: T ~ V }`)).toMatch(/earlier parameter only/);
  });
});

describe('a thrown family error names its declaration (§5.2, §8.2)', () => {
  it('a member minted at a use site is reported against the declaration that wrote it', () => {
    const message = loadError(
      `pet => { pet_type: text =?  n: text }\ndog_of => <T> pet & { pet_type: = "dog"  breed: T }\no => { k: dog_of<text> }`,
    );
    expect(message).toMatch(/in the declaration of 'o'/);
  });
});

describe('messages', () => {
  it('a per-name refusal reads the same in the text and the JSON reader (§8.2)', () => {
    const linked = load(`n => !identifier_type { }\nh => { n: n }`);
    const text = textMessages(linked, 'h', '{ n: "a\\u{AD}b" }');
    const json = jsonMessages(linked, 'h', '{"n":"a­b"}');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toEqual(json);
  });

  it('a group is described with its + and ?', () => {
    expect(
      loadError(`b => { ( a: text | c: text )+ }\nd => b & { ( a: text | c: text ) }`),
    ).toMatch(/\(a \| c\)\+/);
  });

  it('a default on a restated group member reports the default rule', () => {
    const message = loadError(`b => { ( a: text | c: text ) }\nd => b & { a?: text ~ x }`);
    expect(message).toMatch(/takes a default/);
    expect(message).not.toMatch(/loosens/);
  });

  it('a moved fixed facet says it is fixed at construction, and reads grammatically', () => {
    const message = loadError(
      `k => !identifier_type { exclude: "x" }\nk2 => !k ^ { exclude: "y" }`,
    );
    expect(message).toMatch(/fixed at construction/);
    expect(message).not.toMatch(/\ba exclude\b/);
  });
});
