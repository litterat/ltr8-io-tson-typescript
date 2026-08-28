import { describe, expect, it } from 'vitest';
import { canonicalizeIdentity } from '../src/link/identity.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';

/**
 * A backslash is not a path separator in RFC 3986, but it is one to the WHATWG URL parser for a
 * special scheme — and that parser then resolves the dot-segments the backslashes expose. A check
 * that splits on `/` alone sees `..\..\admin` as one harmless segment while `fetch` reads three
 * and climbs two directories out of a mapped base path.
 *
 * Found by Wave 6's adversarial pass, with a working read of an internal path through a host
 * mapped to a sub-path of an origin.
 */
describe('a schema reference may not smuggle a path separator past the identity check', () => {
  it.each([
    ['climbs out of a mapped base', 'https://schemas.example.com/..\\..\\admin\\keys'],
    ['climbs one level', 'https://schemas.example.com/..\\'],
    ['climbs from inside a segment', 'https://schemas.example.com/a\\..\\..\\etc\\passwd'],
    ['a lone backslash', 'https://schemas.example.com/a\\b.tn'],
  ])('rejects a raw backslash: %s', (_name, reference) => {
    expect(() => canonicalizeIdentity(reference)).toThrow(TsonSchemaValidationError);
  });

  it('still rejects the ordinary dot-segments it always did', () => {
    expect(() => canonicalizeIdentity('https://x.example/../a.tn')).toThrow(
      TsonSchemaValidationError,
    );
    expect(() => canonicalizeIdentity('https://x.example/./a.tn')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('accepts a percent-encoded backslash, which is what RFC 3986 requires', () => {
    // %5C is a legitimate character in a path; it is only the RAW form that misleads the parser.
    expect(() => canonicalizeIdentity('https://x.example/a%5Cb.tn')).not.toThrow();
  });

  it('accepts ordinary references unchanged', () => {
    expect(canonicalizeIdentity('https://tson.io/m/core.tn')).toBe('tson.io/m/core.tn');
  });
});
