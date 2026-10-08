import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createUriParser } from '../src/atom/network/uri.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { IriType, UriType } from '../src/schema/meta/atoms-text.js';

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

const URI_ABSOLUTE: UriType = { ...UNCONSTRAINED, allowRelative: false };
const IRI_REFERENCE: IriType = { ...UNCONSTRAINED, kind: 'iri_type', spec: 'rfc3987' };
const IRI_ABSOLUTE: IriType = { ...IRI_REFERENCE, allowRelative: false };

describe("§5.5 !uri -- RFC 3986's grammar, not RFC 2396's", () => {
  const parser = createUriParser('uri', URI_ABSOLUTE);

  it.each([
    ['an empty host', 'file:///etc/hosts'],
    ['an empty authority and path', 'https://'],
    ['an empty path', 'mailto:'],
    ['an empty port', 'http://a:/'],
    ['an IPvFuture host', 'http://[v1.fe80::a+en1]/'],
  ])('accepts %s (%s)', (_name, text) => {
    expect(parser.read(token(text))).toBe(text);
  });

  it('refuses a port that is not digits', () => {
    expect(() => parser.read(token('http://a:b/'))).toThrow(TsonAtomParseError);
  });

  it('refuses a character beyond US-ASCII as a parse error that names !iri (§5.5)', () => {
    expect(() => parser.read(token('https://例え.jp/'))).toThrow(TsonAtomParseError);
    expect(() => parser.read(token('https://example.com/é'))).toThrow(/an IRI is written !iri/);
  });

  it('refuses a relative reference as a validation error, not a parse error (§5.5)', () => {
    expect(() => parser.read(token('foo/bar?x=1'))).toThrow(TsonAtomValidationError);
  });

  it('allow_fragment: false refuses a fragment, including an empty one', () => {
    const noFragment = createUriParser('uri', { ...UNCONSTRAINED, allowFragment: false });
    expect(noFragment.read(token('a:b'))).toBe('a:b');
    expect(() => noFragment.read(token('a:b#'))).toThrow(TsonAtomValidationError);
  });

  it('lengths count code points, never UTF-16 units (§5.5)', () => {
    const iri = createUriParser('iri', { ...IRI_REFERENCE, maxLength: 3n });
    expect(iri.read(token('😀😀😀'))).toBe('😀😀😀');
    expect(() => iri.read(token('😀😀😀😀'))).toThrow(TsonAtomValidationError);
  });
});

describe('§5.5 !iri -- RFC 3987', () => {
  const iri = createUriParser('iri', IRI_ABSOLUTE);
  const iriReference = createUriParser('iri_reference', IRI_REFERENCE);

  it('admits ucschar in the host, path and query', () => {
    expect(iri.read(token('https://例え.jp/パス?q=é'))).toBe('https://例え.jp/パス?q=é');
  });

  it('admits iprivate in the query and nowhere else', () => {
    expect(iri.read(token('https://example.com/a?k=\u{E000}'))).toBe(
      'https://example.com/a?k=\u{E000}',
    );
    expect(() => iri.read(token('https://example.com/\u{E000}'))).toThrow(TsonAtomParseError);
    expect(() => iri.read(token('https://example.com/a#\u{E000}'))).toThrow(TsonAtomParseError);
  });

  it('admits a supplementary-plane ucschar as one character', () => {
    expect(iri.read(token('https://example.com/\u{20000}'))).toContain('\u{20000}');
  });

  it('refuses a noncharacter, which RFC 3987 admits nowhere', () => {
    expect(() => iri.read(token('https://example.com/\u{FFFE}'))).toThrow(TsonAtomParseError);
  });

  it('refuses a relative reference as a validation error; the reference form admits it', () => {
    expect(() => iri.read(token('café/menü'))).toThrow(TsonAtomValidationError);
    expect(iriReference.read(token('café/menü'))).toBe('café/menü');
  });

  it('keeps an IP literal US-ASCII', () => {
    expect(() => iri.read(token('http://[é]/'))).toThrow(TsonAtomParseError);
  });
});
