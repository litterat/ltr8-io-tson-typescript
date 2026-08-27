import { describe, expect, it } from 'vitest';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import { createEmailParser } from '../src/atom/network/email.js';
import type { AtomToken } from '../src/atom/contract.js';
import type { EmailType } from '../src/schema/meta/atoms-text.js';

// core.tn's `!email` atom, RFC 5322 restricted to the `dot-atom "@" dot-atom` core (§5.5). The
// deliberately-rejected-though-legal RFC 5322 forms are pinned here too, per email.ts's own TSDoc.

function token(text: string): AtomToken {
  return { text, form: 'single-line' };
}

const UNCONSTRAINED: EmailType = { kind: 'email_type', spec: 'rfc5322' };

describe('§5.5 !email -- accepts the dot-atom form', () => {
  const parser = createEmailParser('email', UNCONSTRAINED);

  it.each([
    'ada@example.com',
    'ada.lovelace@example.co.uk',
    'user+tag@example.com', // '+' is atext
    "a!#$%&'*/=?^_`{|}~-@example.com", // the rest of atext
    'x@y', // no dot required on either side
    'UPPER@EXAMPLE.COM',
  ])('accepts %s', (text) => {
    expect(parser.read(token(text))).toBe(text);
  });
});

describe('§5.5 !email -- rejects malformed addresses', () => {
  const parser = createEmailParser('email', UNCONSTRAINED);

  it.each([
    'ada', // no '@'
    'ada@', // no domain
    '@example.com', // no local part
    'ada@@example.com',
    '.ada@example.com', // leading dot
    'ada.@example.com', // trailing dot
    'ada..lovelace@example.com', // doubled dot
    'ada@example..com',
    'ada@.example.com',
    'ada lovelace@example.com', // space
    '',
  ])('rejects %s', (text) => {
    expect(() => parser.read(token(text))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !email -- rejects the RFC 5322 forms this subset deliberately leaves out', () => {
  const parser = createEmailParser('email', UNCONSTRAINED);

  it.each([
    '"ada lovelace"@example.com', // quoted-string local part
    'ada@[192.0.2.1]', // domain literal
    'ada(the countess)@example.com', // comment
  ])('rejects %s', (text) => {
    expect(() => parser.read(token(text))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !email -- the text_type length facets it composes', () => {
  it('applies maxLength as a validation error, distinct from a malformed-shape parse error', () => {
    const parser = createEmailParser('email', { ...UNCONSTRAINED, maxLength: 6 });
    expect(parser.read(token('a@b.co'))).toBe('a@b.co');
    expect(() => parser.read(token('ada@example.com'))).toThrow(TsonAtomValidationError);
    expect(() => parser.read(token('nope'))).toThrow(TsonAtomParseError);
  });
});

describe('§5.5 !email -- write', () => {
  it('is the identity -- an address IS-A piece of text', () => {
    const parser = createEmailParser('email', UNCONSTRAINED);
    expect(parser.write('ada@example.com')).toBe('ada@example.com');
  });
});
