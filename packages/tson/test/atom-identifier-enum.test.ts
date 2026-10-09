import { describe, expect, it } from 'vitest';
import { createEnumParser } from '../src/atom/enum.js';
import { createIdentifierParser } from '../src/atom/text/identifier.js';
import { createTextParser } from '../src/atom/text/text.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../src/core/errors.js';
import type { IdentifierType, TextType } from '../src/schema/meta/atoms-text.js';

// [TSON-SCHEMA] §5.5: a text family's value is its token's text put into its `normalization`
// form, and every facet judges the value. §7.4: an enum's members are labels of its type.

const token = (text: string) => ({ text, form: 'unquoted' as const });

const IDENTIFIER: IdentifierType = {
  kind: 'identifier_type',
  spec: 'https://www.unicode.org/reports/tr31/',
  normalization: 'NFC',
  start: 'XID',
  continue: 'XID',
  continueAdd: '-',
};

const HEADER_NAME: IdentifierType = {
  kind: 'identifier_type',
  spec: 'https://www.unicode.org/reports/tr31/',
  normalization: 'NFKC_CASEFOLD',
  start: 'NONE',
  continue: 'NONE',
  startAdd: 'abcdefghijklmnopqrstuvwxyz',
  continueAdd: 'abcdefghijklmnopqrstuvwxyz0123456789-',
};

function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return expect.unreachable('expected a refusal');
}

describe('createTextParser -- the value is the token in the type’s form (§5.5)', () => {
  const folded: TextType = {
    kind: 'text_type',
    normalization: 'NFKC_CASEFOLD',
    members: ['UTF-8', 'us-ascii'],
  };

  it('reads Us-Ascii as the member written us-ascii, and returns the value', () => {
    expect(createTextParser('charset', folded).read(token('Us-Ascii'))).toBe('us-ascii');
    expect(createTextParser('charset', folded).read(token('utf-8'))).toBe('utf-8');
  });

  it('names the token as written and then as read when the form changed it (§5.5)', () => {
    const error = failure(() => createTextParser('charset', folded).read(token('Latin-1')));
    expect(error).toBeInstanceOf(TsonAtomValidationError);
    expect(error.message).toContain("'Latin-1' (read as 'latin-1' under NFKC_CASEFOLD)");
  });

  it('counts lengths of the value by code point, not UTF-16 unit', () => {
    const parser = createTextParser('two', { kind: 'text_type', normalization: 'NFC', length: 2n });
    expect(parser.read(token('\u{1f600}\u{1f600}'))).toBe('\u{1f600}\u{1f600}');
    expect(failure(() => parser.read(token('\u{1f600}')))).toBeInstanceOf(TsonAtomValidationError);
  });

  it('matches a member in NFC whatever the form: no comparison goes below NFC (§5.5)', () => {
    const accent = createTextParser('accent', {
      kind: 'text_type',
      normalization: 'ASCII_CASEFOLD',
      members: ['é'],
    });
    expect(accent.read(token('é'))).toBe('é');
  });

  it('NONE returns the text as written', () => {
    expect(
      createTextParser('t', { kind: 'text_type', normalization: 'NONE' }).read(token('Á')),
    ).toBe('Á');
  });
});

describe('createIdentifierParser (§5.5, §7.7)', () => {
  it('admits the kernel identifier’s names and returns the value in NFC', () => {
    const parser = createIdentifierParser('identifier', IDENTIFIER);
    expect(parser.read(token('content-type'))).toBe('content-type');
    expect(parser.read(token('café'))).toBe('café');
  });

  it('refuses a token outside the grammar as a parse failure, before any facet is asked (§7.7)', () => {
    const parser = createIdentifierParser('route', {
      ...IDENTIFIER,
      pattern: '[a-z][a-z0-9_]*',
    });
    const error = failure(() => parser.read(token('2fast')));
    expect(error).toBeInstanceOf(TsonAtomParseError);
    expect((error as TsonAtomParseError).expected).toBe('an identifier');
  });

  it('judges the value, so a folding profile of lowercase letters admits Content-Type', () => {
    const parser = createIdentifierParser('header_name', HEADER_NAME);
    expect(parser.read(token('Content-Type'))).toBe('content-type');
    expect(parser.read(token('Ｃontent-Type'))).toBe('content-type');
  });

  it('a medial character cannot end a name (§5.5)', () => {
    const kebab = createIdentifierParser('kebab', { ...IDENTIFIER, continueAdd: '', medial: '-' });
    expect(kebab.read(token('content-type'))).toBe('content-type');
    expect(failure(() => kebab.read(token('content-')))).toBeInstanceOf(TsonAtomParseError);
  });

  it('applies text_type’s facets inside the profile: members in the profile’s form', () => {
    const parser = createIdentifierParser('direction', {
      ...IDENTIFIER,
      members: ['north', 'south'],
    });
    expect(parser.read(token('north'))).toBe('north');
    expect(failure(() => parser.read(token('east')))).toBeInstanceOf(TsonAtomValidationError);
  });

  it('under ASCII_CASEFOLD a full-width letter is not an ASCII letter, so the profile refuses it', () => {
    const field = createIdentifierParser('field_name', {
      ...HEADER_NAME,
      normalization: 'ASCII_CASEFOLD',
    });
    expect(field.read(token('Content-Type'))).toBe('content-type');
    expect(failure(() => field.read(token('Ｃontent-Type')))).toBeInstanceOf(TsonAtomParseError);
    expect(failure(() => field.read(token('Keep-Alive')))).toBeInstanceOf(TsonAtomParseError);
  });

  it('names the written spelling ahead of a violation when the form changed the text', () => {
    const error = failure(() =>
      createIdentifierParser('header_name', HEADER_NAME).read(token('9LIVES')),
    );
    expect(error.message).toContain("'9LIVES' (read as '9lives' under NFKC_CASEFOLD)");
  });
});

describe('createEnumParser -- matched in the label type’s form (§7.4)', () => {
  const body = { kind: 'enum', type: 'header_name', members: ['Accept', 'content-type'] } as const;

  it('matches a member however it is cased under a folding label type, and returns the value', () => {
    const parser = createEnumParser('safe_header', body, 'NFKC_CASEFOLD');
    expect(parser.read(token('Content-Type'))).toBe('content-type');
    expect(parser.read(token('ACCEPT'))).toBe('accept');
  });

  it('refuses a name it does not list, however it is cased', () => {
    const error = failure(() =>
      createEnumParser('safe_header', body, 'NFKC_CASEFOLD').read(token('X-Trace')),
    );
    expect(error).toBeInstanceOf(TsonAtomValidationError);
    expect(error.message).toContain("'X-Trace' (read as 'x-trace' under NFKC_CASEFOLD)");
  });

  it('matches exactly under NONE, and in NFC under every form (§5.5)', () => {
    const exact = createEnumParser('e', body);
    expect(failure(() => exact.read(token('accept')))).toBeInstanceOf(TsonAtomValidationError);
    const accented = createEnumParser('e', { ...body, members: ['café'] });
    expect(accented.read(token('café'))).toBe('café');
  });

  it('narrows the {true, false} member set to a host boolean and nothing else', () => {
    const boolean = createEnumParser('boolean', {
      kind: 'enum',
      type: 'identifier',
      members: ['true', 'false'],
    });
    expect(boolean.read(token('true'))).toBe(true);
    expect(boolean.read(token('false'))).toBe(false);
    const three = createEnumParser('e', {
      kind: 'enum',
      type: 'identifier',
      members: ['true', 'false', 'maybe'],
    });
    expect(three.read(token('true'))).toBe('true');
  });
});
