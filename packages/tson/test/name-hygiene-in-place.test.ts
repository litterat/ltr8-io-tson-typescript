/**
 * [TSON-SCHEMA] §11.4's field-names scope over a record written in place (§4.2): its field names are judged under its
 * own `name_type`'s profile (§5.2, §7.4), as a declared record's are -- whether it is written in place or is the
 * record an application of a parametric record closes to there (§5.10).
 */
import { describe, expect, it } from 'vitest';

import { load, loadError } from './schema-read-helpers.js';

const JSON_NAME = 'json_name => !unicode.identifier_type { start_add: "@" }';

describe('§11.4 a record written in place is judged under its own name type', () => {
  it('a parametric record naming json_name, applied in place, admits an @ field it declares', () => {
    const body =
      `${JSON_NAME}\n` +
      'node => <T> !meta.record { name_type: json_name  fields: { "@id" => { type: text }  v => { type: T } } }\n' +
      'holder => { n: node<int32> }';
    expect(loadError(body)).toBeUndefined();
    const holder = load(body).entries.get('holder');
    expect(holder?.kind).toBe('record');
  });

  it('the declared record and its application in place agree', () => {
    expect(
      loadError(
        `${JSON_NAME}\n` +
          'node => <T> !meta.record { name_type: json_name  fields: { "@id" => { type: text }  v => { type: T } } }\n' +
          'node_int => node<int32>',
      ),
    ).toBeUndefined();
  });

  it('a record in place stating no name type still has the default profile, which refuses @', () => {
    expect(loadError('holder => { n: { "@id": text } }')).toMatch(/@id/);
  });

  it('a hygiene rule still refuses in place: confusable field names of one record written in place', () => {
    // Latin a and Cyrillic а in one field-names scope are confusable under any identifier profile (§8.2).
    const cyrillic = String.fromCodePoint(0x0430);
    expect(loadError(`holder => { n: { a: text  ${cyrillic}: text } }`)).toMatch(
      /'holder' has a record written in place whose field names are refused/,
    );
  });
});
