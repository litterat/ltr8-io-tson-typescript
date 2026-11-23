/**
 * [TSON-SCHEMA] §5.5's incomplete entry, field by field (change log §4.5 "Open construction", items 106, 109): each
 * field written is read against its own declared type where it is written, completed or not, and every name it
 * holds is judged when the schema links -- a name at a type slot resolves, names no value and no incomplete entry,
 * and is a member of the slot's kind. An incomplete entry is no type, so a data tag naming it is refused.
 */
import { describe, expect, it } from 'vitest';

import { load, loadError, textCodes, textMessages } from './schema-read-helpers.js';

const META = '!!import:"https://tson.io/2026/40/m/meta.tn"';

describe('§5.5 a field of an incomplete entry is read against its declared type where it is written', () => {
  it('a value that is none of the field’s type is refused at the declaration', () => {
    expect(loadError('counted => !meta.array ^ { min_items: "ten" }', META)).toMatch(
      /'min_items' is no value of 'numeric.count', its type in 'meta.array'/,
    );
  });

  it('each field read is held beside the written record', () => {
    const linked = load('nonempty => !meta.array ^ { min_items: 1 }', META);
    const entry = linked.entries.get('nonempty');
    if (entry?.kind !== 'incomplete') throw new Error('expected an incomplete entry');
    expect([...entry.read.keys()]).toEqual(['min_items']);
    expect(entry.read.get('min_items')).toMatchObject({ form: 'token', token: { text: '1' } });
  });

  it('a further refinement adds the fields it reads to its base’s', () => {
    const linked = load(
      'counted => !meta.array ^ { min_items: 1 }\nbounded => !counted ^ { max_items: 5 }',
      META,
    );
    const entry = linked.entries.get('bounded');
    if (entry?.kind !== 'incomplete') throw new Error('expected an incomplete entry');
    expect([...entry.read.keys()]).toEqual(['min_items', 'max_items']);
  });
});

describe('§4.2, §5.5 the names an incomplete entry holds are judged when its schema links', () => {
  it.each([
    [
      'a name that reaches nothing',
      'keyed => !meta.map ^ { key_type: no_such_type }',
      /'keyed' at \/key_type names 'no_such_type'/,
    ],
    [
      'a name in a type written in place',
      'rows => !meta.map ^ { value_type: { of: !meta.array { element_type: no_such_type } } }',
      /'rows' at \/value_type\/of\/element_type names 'no_such_type'/,
    ],
    [
      'a name outside its slot’s kind',
      'names => !meta.enum_type ^ { name_type: text }',
      /which is no 'unicode.identifier_type'/,
    ],
    [
      'an incomplete entry at a type slot',
      'nonempty => !meta.array ^ { min_items: 1 }\nrows => !meta.map ^ { value_type: nonempty }',
      /'nonempty' is an incomplete entry, which is no type/,
    ],
  ])('%s is refused whether or not anything completes it', (_what, body, message) => {
    expect(loadError(body, META)).toMatch(message);
  });

  it('a name the slot admits loads', () => {
    expect(loadError('keyed => !meta.map ^ { key_type: text }', META)).toBeUndefined();
  });
});

describe('§5.5, §7.2 a data tag naming an incomplete entry', () => {
  it('is a validation error: nothing is read against what is no type', () => {
    const linked = load('nonempty => !meta.array ^ { min_items: 1 }\nholder => { t: text }', META);
    expect(textCodes(linked, 'nonempty', '!nonempty [a]')).toEqual(['TYPE_MISMATCH']);
    expect(textMessages(linked, 'nonempty', '!nonempty [a]')[0]).toMatch(
      /'nonempty' is an incomplete 'meta.array' with \[element_type\] absent, not a type/,
    );
  });
});

describe('§5.2 a fixed field in a construction left open, a refinement of one and a completion', () => {
  const CONTRADICTED = /is fixed on 'meta\.array' and cannot be given another value/;

  it('may write the pin’s own value, in any spelling', () => {
    const linked = load(
      [
        'indexed => !meta.array ^ { access_pattern: INDEX }',
        'quoted  => !meta.array ^ { access_pattern: "INDEX" }',
        'one     => meta.array & { min_items?: = 1 }',
        'hex     => !one ^ { min_items: 0x1 }',
      ].join('\n'),
      META,
    );
    for (const name of ['indexed', 'quoted', 'hex']) {
      const entry = linked.entries.get(name);
      if (entry?.kind !== 'incomplete') throw new Error(`expected '${name}' incomplete`);
      expect(entry.absent).toEqual(['element_type']);
    }
  });

  it('refuses another value where the construction is left open', () => {
    expect(loadError('named => !meta.array ^ { access_pattern: NAMED }', META)).toMatch(
      /'named': 'access_pattern' is fixed on 'meta\.array'/,
    );
    expect(
      loadError(
        'nonempty => !meta.array ^ { min_items: 1 }\nnamed => !nonempty ^ { access_pattern: NAMED }',
        META,
      ),
    ).toMatch(CONTRADICTED);
    expect(
      loadError('one => meta.array & { min_items?: = 1 }\ntwo => !one ^ { min_items: 2 }', META),
    ).toMatch(/'two': 'min_items' is fixed on 'one' and cannot be given another value/);
  });

  it('writes a pin once, and its completion is the plain construction', () => {
    expect(
      loadError(
        'indexed => !meta.array ^ { access_pattern: INDEX }\nagain => !indexed ^ { access_pattern: INDEX }',
        META,
      ),
    ).toMatch(/\[access_pattern\] (is|are) written by 'indexed' already/);
    expect(
      loadError(
        'indexed => !meta.array ^ { access_pattern: INDEX }\n' +
          'again => !indexed { access_pattern: INDEX  element_type: text }',
        META,
      ),
    ).toMatch(/\[access_pattern\] (is|are) written by 'indexed' already/);
    const linked = load(
      [
        'indexed => !meta.array ^ { access_pattern: INDEX }',
        'braced  => !indexed { element_type: text }',
        'applied => indexed<text>',
        'written => !meta.array { access_pattern: INDEX  element_type: text }',
        'bare    => !meta.array { element_type: text }',
      ].join('\n'),
      META,
    );
    for (const name of ['braced', 'applied', 'written']) {
      expect(linked.entries.get(name), name).toEqual(linked.entries.get('bare'));
    }
  });

  it('lets a completion write a pin its entry left unwritten, and no other value', () => {
    const linked = load(
      [
        'nonempty => !meta.array ^ { min_items: 1 }',
        'braced   => !nonempty { access_pattern: INDEX  element_type: text }',
        'refined  => !nonempty ^ { access_pattern: INDEX }',
        'applied  => refined<text>',
        'bare     => !meta.array { element_type: text  min_items: 1 }',
      ].join('\n'),
      META,
    );
    expect(linked.entries.get('braced')).toEqual(linked.entries.get('bare'));
    expect(linked.entries.get('applied')).toEqual(linked.entries.get('bare'));
    expect(
      loadError(
        'nonempty => !meta.array ^ { min_items: 1 }\n' +
          'named => !nonempty { access_pattern: NAMED  element_type: text }',
        META,
      ),
    ).toMatch(/'access_pattern' is fixed/);
  });

  it('counts no pin among the required fields a construction left open must leave absent', () => {
    expect(
      loadError('done => !meta.array ^ { access_pattern: INDEX  element_type: text }', META),
    ).toMatch(/nothing is left open/);
  });
});
