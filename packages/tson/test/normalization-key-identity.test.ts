/**
 * NFKC_CASEFOLD map-key identity.
 */
import { describe, expect, it } from 'vitest';

import { jsonCodes, load, textCodes } from './schema-read-helpers.js';
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
