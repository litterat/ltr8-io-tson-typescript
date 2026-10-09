import { describe, expect, it } from 'vitest';

import { canonicalizeIdentity, sameIdentity, validateIdentity } from '../src/link/identity.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';

describe('canonicalizeIdentity (§2.2.1)', () => {
  it('strips the scheme and its :// delimiter, keeping lowercase host plus path', () => {
    expect(canonicalizeIdentity('https://tson.io/2026/37/m/core.tn')).toBe(
      'tson.io/2026/37/m/core.tn',
    );
  });

  it('strips the query (a `?sha256=` pin is verification metadata, not identity)', () => {
    expect(canonicalizeIdentity('https://tson.io/2026/37/m/core.tn?sha256=abc123')).toBe(
      'tson.io/2026/37/m/core.tn',
    );
  });

  it('treats http:// and https:// as naming the same document', () => {
    expect(sameIdentity('http://tson.io/x.tn', 'https://tson.io/x.tn')).toBe(true);
  });

  it('treats a pinned and an unpinned reference to one identity as the same identity', () => {
    expect(sameIdentity('https://tson.io/x.tn?sha256=deadbeef', 'https://tson.io/x.tn')).toBe(true);
  });

  it('rejects a URI with no scheme', () => {
    expect(() => canonicalizeIdentity('tson.io/x.tn')).toThrow(TsonSchemaValidationError);
  });

  it('reads a hostless identity as its absolute path: /x.tn, file:/x.tn and file:///x.tn are one identity (§2.2.1)', () => {
    expect(canonicalizeIdentity('/local/orders.tn')).toBe('/local/orders.tn');
    expect(canonicalizeIdentity('file:/local/orders.tn')).toBe('/local/orders.tn');
    expect(canonicalizeIdentity('file:///local/orders.tn')).toBe('/local/orders.tn');
    expect(sameIdentity('/local/orders.tn', 'file:///local/orders.tn')).toBe(true);
    expect(sameIdentity('file:/local/orders.tn', 'file:///local/orders.tn')).toBe(true);
  });

  it('strips a hash query from a hostless identity too', () => {
    expect(canonicalizeIdentity('file:/local/orders.tn?sha256=abc')).toBe('/local/orders.tn');
  });

  it('refuses a relative path with no host, which a host-and-path identity could also spell (§2.2.1)', () => {
    // `tson.io/2026/37/m/core.tn` is exactly what `https://tson.io/2026/37/m/core.tn` reduces to.
    expect(() => canonicalizeIdentity('tson.io/2026/37/m/core.tn')).toThrow(
      TsonSchemaValidationError,
    );
    expect(() => canonicalizeIdentity('mini.tn')).toThrow(TsonSchemaValidationError);
    expect(() => canonicalizeIdentity('file:mini.tn')).toThrow(TsonSchemaValidationError);
  });

  it('a hostless identity is held to the same path rules: no dot-segments, no fragment, no encoded unreserved', () => {
    expect(() => canonicalizeIdentity('/a/../b.tn')).toThrow(TsonSchemaValidationError);
    expect(() => canonicalizeIdentity('file:/a.tn#x')).toThrow(TsonSchemaValidationError);
    expect(() => canonicalizeIdentity('/a%2Db.tn')).toThrow(TsonSchemaValidationError);
  });

  it('admits a host and a path beyond US-ASCII as written, and a percent-encoded spelling is another identity (RFC 3987)', () => {
    expect(canonicalizeIdentity('https://bücher.example/schémas/ordres.tn')).toBe(
      'bücher.example/schémas/ordres.tn',
    );
    expect(canonicalizeIdentity('/schémas/ordres.tn')).toBe('/schémas/ordres.tn');
    expect(sameIdentity('/sch%C3%A9mas/x.tn', '/schémas/x.tn')).toBe(false);
  });

  it('refuses userinfo, a port and a fragment on a hostless authority as on any other', () => {
    expect(() => canonicalizeIdentity('file://user@/x.tn')).toThrow(TsonSchemaValidationError);
    expect(() => canonicalizeIdentity('file://:80/x.tn')).toThrow(TsonSchemaValidationError);
  });

  it('refuses text outside the IRI-reference grammar rather than splitting it', () => {
    expect(() => canonicalizeIdentity('https://tson.io/a b.tn')).toThrow(/IRI-reference/u);
    expect(() => canonicalizeIdentity('not a uri at all')).toThrow(TsonSchemaValidationError);
  });

  it('rejects userinfo in an identifying URI', () => {
    expect(() => canonicalizeIdentity('https://user@tson.io/x.tn')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('rejects a port, default or otherwise', () => {
    expect(() => canonicalizeIdentity('https://tson.io:443/x.tn')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('rejects a fragment', () => {
    expect(() => canonicalizeIdentity('https://tson.io/x.tn#section')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('rejects a non-lowercase host', () => {
    expect(() => canonicalizeIdentity('https://Tson.io/x.tn')).toThrow(TsonSchemaValidationError);
  });

  it('rejects a dot-segment in the path', () => {
    expect(() => canonicalizeIdentity('https://tson.io/a/../b.tn')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('rejects a percent-encoded unreserved character', () => {
    // %2D decodes to '-', which is itself unreserved and so must never be percent-encoded.
    expect(() => canonicalizeIdentity('https://tson.io/a%2Db.tn')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('accepts a percent-encoded reserved character untouched', () => {
    expect(canonicalizeIdentity('https://tson.io/a%2Fb.tn')).toBe('tson.io/a%2Fb.tn');
  });

  it('a query carrying only recognised hash parameters is stripped whole, not partially', () => {
    expect(canonicalizeIdentity('https://tson.io/x.tn?sha256=abc&sha256=def')).toBe('tson.io/x.tn');
  });

  it('validateIdentity is a pass-through check with no return value', () => {
    expect(() => {
      validateIdentity('https://tson.io/x.tn');
    }).not.toThrow();
    expect(() => {
      validateIdentity('not a uri at all');
    }).toThrow(TsonSchemaValidationError);
  });

  it('sameIdentity is false for two genuinely different hosts', () => {
    expect(sameIdentity('https://tson.io/x.tn', 'https://example.com/x.tn')).toBe(false);
  });
});
