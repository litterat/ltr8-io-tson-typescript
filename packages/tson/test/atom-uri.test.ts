import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createUriParser } from '../src/atom/network/uri.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { UriType } from '../src/schema/meta/atoms-text.js';

// §5.5's `!uri` atom, RFC 3986's URI-reference grammar -- hand-written here rather than delegated
// to a host parser, per uriGrammar.ts's own TSDoc (this port has no `java.net.URI` equivalent to
// lean on the way the reference implementation does).

function token(text: string): AtomToken {
  return { text, form: 'unquoted' };
}

const UNCONSTRAINED: UriType = {
  kind: 'uri_type',
  allowRelative: true,
  allowFragment: true,
  normalization: 'NONE',
  spec: 'rfc3986',
};

describe('§5.5 !uri -- accepted forms', () => {
  const parser = createUriParser('uri', UNCONSTRAINED);

  it('accepts an absolute URI with authority, path, query and fragment', () => {
    const text = 'https://example.com/a/b?x=1#frag';
    expect(parser.read(token(text))).toBe(text);
  });

  it('accepts a relative reference', () => {
    expect(parser.read(token('foo/bar?x=1'))).toBe('foo/bar?x=1');
  });

  it('accepts a urn scheme (no authority, path-rootless containing a colon)', () => {
    expect(parser.read(token('urn:isbn:0451450523'))).toBe('urn:isbn:0451450523');
  });

  it('accepts an IPv6 host in a URI authority', () => {
    expect(parser.read(token('http://[2001:db8::1]/'))).toBe('http://[2001:db8::1]/');
  });
});

describe('§5.5 !uri -- malformed shapes are parse errors', () => {
  it('an unescaped space is not valid anywhere in a URI', () => {
    const parser = createUriParser('uri', UNCONSTRAINED);
    expect(() => parser.read(token('http://example.com/a b'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !uri -- uri_type facets', () => {
  it('minLength rejects a shorter URI as a validation error', () => {
    const parser = createUriParser('uri', { ...UNCONSTRAINED, minLength: 20n });
    expect(parser.read(token('https://example.com/'))).toBe('https://example.com/');
    expect(() => parser.read(token('urn:x'))).toThrow(TsonAtomValidationError);
  });

  it('maxLength rejects a longer URI as a validation error', () => {
    const parser = createUriParser('uri', { ...UNCONSTRAINED, maxLength: 6n });
    expect(parser.read(token('urn:x'))).toBe('urn:x');
    expect(() => parser.read(token('https://example.com/'))).toThrow(TsonAtomValidationError);
  });

  it('length rejects anything else', () => {
    const parser = createUriParser('uri', { ...UNCONSTRAINED, length: 19n });
    expect(parser.read(token('https://example.com'))).toBe('https://example.com');
    expect(() => parser.read(token('https://example.com/a'))).toThrow(TsonAtomValidationError);
  });

  it('schemes rejects a scheme outside the set, matching with ASCII case folded (§5.5, §5.7)', () => {
    const parser = createUriParser('uri', { ...UNCONSTRAINED, schemes: ['HTTPS'] });
    expect(parser.read(token('https://example.com/'))).toBe('https://example.com/');
    expect(() => parser.read(token('http://example.com/'))).toThrow(TsonAtomValidationError);
  });

  it('schemes rejects a schemeless relative reference', () => {
    const parser = createUriParser('uri', { ...UNCONSTRAINED, schemes: ['https'] });
    expect(() => parser.read(token('foo/bar'))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.5 !uri -- write', () => {
  it('round trips through read, unchanged', () => {
    const parser = createUriParser('uri', UNCONSTRAINED);
    const text = 'https://example.com/a/b?x=1#frag';
    expect(parser.write(parser.read(token(text)))).toBe(text);
  });
});
