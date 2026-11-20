/**
 * [TSON-SCHEMA] §5.4's tags at a choice (change log §4.5 "Choices and tags", items 119, 125–129): a tag names a
 * variant, or a type IS-A exactly one variant, judged by the entry it reaches, and the value is read at that variant
 * as at a position typed by it (§7.2); a tag IS-A two variants and naming neither selects none. A choice listed as a
 * variant is disjoint, and the tag selecting it is spent naming it.
 */
import { describe, expect, it } from 'vitest';

import { choiceSelection } from '../src/link/choiceSelection.js';
import { load, loadError, textCodes, textMessages } from './schema-read-helpers.js';

const SUBTYPES = `
  shape  => abstract { name: text }
  circle => shape & { r: integer }
  round  => abstract shape & { smooth: boolean }
  disc   => round & { d: integer }
  base   => { id: text }
  sub    => base & { extra: integer }
  a      => { x: text }
  b      => { y: text }
  both   => a & b
  small  => !int32 ^ { max: 10 }
  item   => ( text | shape )
  based  => ( text | base )
  ranked => ( base | sub )
  either => ( a | b )
  narrow => ( int32 | text )
  holder => { i?: item  b?: based  r?: ranked  e?: either  n?: narrow }
`;

describe('choiceSelection (§5.4): which variant each tag selects', () => {
  const linked = load(SUBTYPES);
  const choice = (name: string) => {
    const body = linked.entries.get(name);
    if (body?.kind !== 'choice') throw new Error(`'${name}' is no choice`);
    return choiceSelection(body.variants, linked.entries);
  };

  it('a variant’s own name, then each type IS-A exactly one variant, at any depth', () => {
    const item = choice('item');
    expect(item.selects.get('shape')?.name).toBe('shape');
    expect(item.selects.get('circle')?.name).toBe('shape');
    expect(item.selects.get('disc')?.name).toBe('shape');
    expect(item.named.has('circle')).toBe(false);
  });

  it('a name meaning a variant selects it before any variant it only IS-A', () => {
    expect(choice('ranked').selects.get('sub')?.name).toBe('sub');
  });

  it('a type IS-A two variants and naming neither selects none', () => {
    const either = choice('either');
    expect(either.selects.has('both')).toBe(false);
    expect(either.selectsNone.get('both')).toEqual(['a', 'b']);
  });
});

describe('§5.4, §7.2 a tag at a choice, read', () => {
  const linked = load(SUBTYPES);

  it('a member of an abstract variant selects it and validates as the member', () => {
    expect(textCodes(linked, 'holder', '!holder { i: !circle { name: c  r: 1 } }')).toEqual([]);
    expect(
      textCodes(linked, 'holder', '!holder { i: !disc { name: d  smooth: true  d: 2 } }'),
    ).toEqual([]);
    // Read as a circle: `r` is required there.
    expect(textCodes(linked, 'holder', '!holder { i: !circle { name: c } }')).not.toEqual([]);
  });

  it('the abstract variant itself takes no value, as a position typed by it takes none (§5.2)', () => {
    expect(textCodes(linked, 'holder', '!holder { i: !shape { name: s } }')).not.toEqual([]);
  });

  it('a subtype of a concrete variant, and an atom refinement of an atom variant, select it', () => {
    expect(textCodes(linked, 'holder', '!holder { b: !sub { id: x  extra: 1 } }')).toEqual([]);
    expect(textCodes(linked, 'holder', '!holder { n: !small 5 }')).toEqual([]);
    expect(textCodes(linked, 'holder', '!holder { n: !small 50 }')).not.toEqual([]);
  });

  it('a tag IS-A two variants and naming neither is a validation error at the data; the choice loads', () => {
    const messages = textMessages(linked, 'holder', '!holder { e: !both { x: p  y: q } }');
    expect(messages).toEqual([
      expect.stringMatching(/subtype of more than one variant .* selects none/u),
    ]);
  });
});

describe('§5.4 a choice listed as a variant is disjoint (item 126)', () => {
  it('a variant that is a choice not disjoint is refused, by name or through an alias, naming the remedy', () => {
    const either = 'a => { x: text }\nb => { y: text }\neither => ( a | b )\n';
    expect(loadError(`${either}pick => ( text | either )`)).toMatch(
      /has a variant 'either' that is a choice not disjoint .* '\( text \| a \| b \)'/u,
    );
    expect(loadError(`${either}held => either\npick => ( text | held )`)).toMatch(
      /has a variant 'held' that is a choice not disjoint/u,
    );
  });

  it('a disjoint nested choice loads, and the tag naming it is spent: the value is read there untagged', () => {
    const linked = load(
      'narrow => ( int32 | text )\noutside => ( boolean | narrow )\nholder => { o: outside }',
    );
    expect(textCodes(linked, 'holder', '!holder { o: !narrow 5 }')).toEqual([]);
    expect(textCodes(linked, 'holder', '!holder { o: !narrow hello }')).toEqual([]);
    // `outside` is not disjoint (a choice has no one class), so its own value is tagged too.
    expect(textCodes(linked, 'holder', '!holder { o: !boolean true }')).toEqual([]);
  });
});
