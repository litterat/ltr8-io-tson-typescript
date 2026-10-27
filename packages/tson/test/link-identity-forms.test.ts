import { describe, expect, it } from 'vitest';

import { TsonSchemaValidationError } from '../src/core/errors.js';
import {
  canonicalizeIdentity,
  identityAsciiHost,
  identityHostKey,
  identityToUri,
  readIdentity,
  sameIdentity,
  validateIdentity,
} from '../src/link/identity.js';

describe("an identity's host is a host value ([TSON-DATA] §2.2.1)", () => {
  it('reads a host name in either label form, in any ASCII case, to its U-labels', () => {
    const canonical = 'bücher.example/x.tn';
    expect(canonicalizeIdentity('https://xn--bcher-kva.example/x.tn')).toBe(canonical);
    expect(canonicalizeIdentity('https://XN--BCHER-KVA.Example/x.tn')).toBe(canonical);
    expect(canonicalizeIdentity('https://bücher.example/x.tn')).toBe(canonical);
    expect(canonicalizeIdentity('https://Example.COM/x.tn')).toBe('example.com/x.tn');
  });

  it("reads an IPv4 address and an IPv6 address, compressed or not, to the host's canonical text", () => {
    expect(canonicalizeIdentity('http://192.0.2.1/x.tn')).toBe('192.0.2.1/x.tn');
    expect(canonicalizeIdentity('https://[2001:db8:0:0:0:0:0:1]/x.tn')).toBe('[2001:db8::1]/x.tn');
    expect(canonicalizeIdentity('https://[2001:DB8::1]/x.tn')).toBe('[2001:db8::1]/x.tn');
    expect(sameIdentity('https://[::1]/x.tn', 'https://[0:0:0:0:0:0:0:1]/x.tn')).toBe(true);
  });

  it('refuses IPvFuture, a zone identifier and an unbracketed IPv6 address', () => {
    expect(() => canonicalizeIdentity('https://[v1.x]/x.tn')).toThrow(/IPvFuture/u);
    expect(() => canonicalizeIdentity('https://[fe80::1%25eth0]/x.tn')).toThrow(
      TsonSchemaValidationError,
    );
    expect(() => canonicalizeIdentity('https://2001:db8::1/x.tn')).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('refuses a host that is no host name, an IPv4 address or an IPv6 address', () => {
    expect(() => canonicalizeIdentity('https://_x.example/x.tn')).toThrow(/'_'/u);
    expect(() => canonicalizeIdentity('https://b%C3%BCcher.example/x.tn')).toThrow(
      /percent-encoded/u,
    );
    expect(() => canonicalizeIdentity('https://BÜCHER.example/x.tn')).toThrow(/uppercase/u);
    expect(() => canonicalizeIdentity('https://1.2.3/x.tn')).toThrow(TsonSchemaValidationError);
  });

  it('refuses a port and userinfo whatever the host', () => {
    expect(() => canonicalizeIdentity('https://[::1]:8443/x.tn')).toThrow(/port/u);
    expect(() => canonicalizeIdentity('https://example.com:8443/x.tn')).toThrow(/port/u);
    expect(() => canonicalizeIdentity('https://user@example.com/x.tn')).toThrow(/userinfo/u);
  });
});

describe("an identity's path is read back from its URI spelling (§2.2.1)", () => {
  it('decodes percent-encoded UTF-8 of an IRI character, hex case ignored, and the result is NFC', () => {
    expect(canonicalizeIdentity('https://example.com/sch%C3%A9mas/x.tn')).toBe(
      'example.com/schémas/x.tn',
    );
    expect(canonicalizeIdentity('https://example.com/sch%c3%a9mas/x.tn')).toBe(
      'example.com/schémas/x.tn',
    );
    expect(canonicalizeIdentity('https://example.com/%F0%9F%98%80.tn')).toBe(
      'example.com/\u{1f600}.tn',
    );
  });

  it('keeps a percent-encoded reserved character, in uppercase hex', () => {
    expect(canonicalizeIdentity('https://example.com/a%2fb.tn')).toBe('example.com/a%2Fb.tn');
    expect(canonicalizeIdentity('https://example.com/a%2Fb.tn')).toBe('example.com/a%2Fb.tn');
  });

  it('refuses what has no IRI form: a non-UTF-8 encoding, a bidi control, an unreserved character, a non-NFC path', () => {
    expect(() => canonicalizeIdentity('https://example.com/%FF.tn')).toThrow(/not the UTF-8/u);
    expect(() => canonicalizeIdentity('https://example.com/%E2%80%8F.tn')).toThrow(/U\+200F/u);
    expect(() => canonicalizeIdentity('https://example.com/%41.tn')).toThrow(/unreserved/u);
    expect(() => canonicalizeIdentity('https://example.com/schémas/x.tn')).toThrow(
      /Normalization Form C/u,
    );
    expect(() => canonicalizeIdentity('https://example.com/sche%CC%81mas.tn')).toThrow(
      /Normalization Form C/u,
    );
    expect(() => canonicalizeIdentity('https://example.com/%C2%80.tn')).toThrow(/IRI form/u);
  });

  it('refuses overlong and surrogate encodings', () => {
    expect(() => canonicalizeIdentity('https://example.com/%C0%AF.tn')).toThrow(/not the UTF-8/u);
    expect(() => canonicalizeIdentity('https://example.com/%ED%A0%80.tn')).toThrow(
      /not the UTF-8/u,
    );
  });
});

describe("a document's own !!id is written in canonical form (§2.2.1)", () => {
  it('accepts the canonical spelling: lowercase U-label host, IRI path, uppercase reserved hex', () => {
    for (const id of [
      'https://example.com/schemas/order.tn',
      'https://bücher.example/schémas/x.tn',
      'https://example.com/a%2Fb.tn',
      'https://[2001:db8::1]/x.tn',
      'https://192.0.2.1/x.tn',
    ]) {
      expect(() => {
        validateIdentity(id);
      }).not.toThrow();
    }
  });

  it('refuses another spelling of the same identity, naming the canonical one', () => {
    expect(() => {
      validateIdentity('https://Example.COM/x.tn');
    }).toThrow(/write 'https:\/\/example\.com\/x\.tn'/u);
    expect(() => {
      validateIdentity('https://xn--bcher-kva.example/x.tn');
    }).toThrow(/write 'https:\/\/bücher\.example\/x\.tn'/u);
    expect(() => {
      validateIdentity('https://example.com/a%2fb.tn');
    }).toThrow(/a%2Fb/u);
    expect(() => {
      validateIdentity('https://[2001:db8:0:0:0:0:0:1]/x.tn');
    }).toThrow(/\[2001:db8::1\]/u);
  });

  it('names the canonical spelling with the query kept', () => {
    expect(() => {
      validateIdentity('https://Example.com/x.tn?sha256=' + 'a'.repeat(64));
    }).toThrow(/example\.com\/x\.tn\?sha256=a+'/u);
  });
});

describe("a reference's URI spelling and a source's host keys", () => {
  it('writes the host by ToASCII and the path beyond ASCII as percent-encoded UTF-8, keeping scheme and query', () => {
    expect(identityToUri('https://bücher.example/schémas/x.tn?sha256=abc')).toBe(
      'https://xn--bcher-kva.example/sch%C3%A9mas/x.tn?sha256=abc',
    );
    expect(identityToUri('https://[2001:DB8:0:0:0:0:0:1]/x.tn')).toBe('https://[2001:db8::1]/x.tn');
    expect(identityToUri('file:///local/x.tn')).toBe('file:///local/x.tn');
  });

  it("exposes the identity's parts for a source to locate the document by", () => {
    const reading = readIdentity('https://xn--bcher-kva.example/sch%C3%A9mas/x.tn');
    expect(reading.host).toBe('bücher.example');
    expect(reading.asciiHost).toBe('xn--bcher-kva.example');
    expect(reading.path).toBe('/schémas/x.tn');
    expect(reading.uriPath).toBe('/sch%C3%A9mas/x.tn');
    expect(reading.scheme).toBe('https');
  });

  it("puts an allow-list entry into the form an identity's host takes, in either label form", () => {
    expect(identityHostKey('xn--bcher-kva.example')).toBe('bücher.example');
    expect(identityHostKey('Example.COM')).toBe('example.com');
    expect(identityHostKey('::1')).toBe('[::1]');
    expect(identityHostKey('[0:0:0:0:0:0:0:1]')).toBe('[::1]');
    expect(identityAsciiHost('bücher.example')).toBe('xn--bcher-kva.example');
    expect(() => identityHostKey('example.com:8443')).toThrow(TsonSchemaValidationError);
  });
});
