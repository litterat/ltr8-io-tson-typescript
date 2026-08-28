/**
 * `source/reference.ts`'s own `permittedReference` -- the [TSON-DATA] §2.2.1 identity/policy
 * check both shipped sources run before touching the network or the filesystem.
 */
import { describe, expect, it } from 'vitest';

import { permittedReference } from '../src/source/reference.js';
import { TsonSchemaFetchError } from '../src/core/errors.js';

describe('permittedReference', () => {
  it('splits a legal reference into its canonical identity, host, and path', () => {
    const permitted = permittedReference(
      'https://example.com/a/b.tn?sha256=' + 'a'.repeat(64),
      false,
    );
    expect(permitted.canonical).toBe('example.com/a/b.tn');
    expect(permitted.host).toBe('example.com');
    expect(permitted.path).toBe('/a/b.tn');
  });

  it('is scheme-insensitive to identity: http and https name the same host/path', () => {
    const https = permittedReference('https://example.com/a.tn', false);
    const http = permittedReference('http://example.com/a.tn', false);
    expect(https.canonical).toBe(http.canonical);
    expect(https.host).toBe(http.host);
  });

  it('rejects userinfo, a port, and a fragment -- all TsonSchemaFetchError not-permitted', () => {
    for (const bad of [
      'https://user@example.com/a.tn',
      'https://example.com:8443/a.tn',
      'https://example.com/a.tn#frag',
    ]) {
      expect(() => permittedReference(bad, false)).toThrow(TsonSchemaFetchError);
      try {
        permittedReference(bad, false);
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(TsonSchemaFetchError);
        expect((error as TsonSchemaFetchError).reason).toBe('not-permitted');
      }
    }
  });

  it('rejects a non-absolute reference (no scheme/host)', () => {
    expect(() => permittedReference('a/b.tn', false)).toThrow(TsonSchemaFetchError);
  });

  it('requires a ?sha256= pin only when asked', () => {
    expect(() => permittedReference('https://example.com/a.tn', true)).toThrow(
      TsonSchemaFetchError,
    );
    expect(() => permittedReference('https://example.com/a.tn', false)).not.toThrow();
    const pinned = 'https://example.com/a.tn?sha256=' + 'a'.repeat(64);
    expect(() => permittedReference(pinned, true)).not.toThrow();
  });

  it('rejects a malformed ?sha256= pin even when not required', () => {
    expect(() => permittedReference('https://example.com/a.tn?sha256=nothex', false)).toThrow(
      TsonSchemaFetchError,
    );
  });
});
