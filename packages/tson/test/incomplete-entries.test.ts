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
