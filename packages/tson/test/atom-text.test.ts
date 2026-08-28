import { describe, expect, it } from 'vitest';
import { createTextParser } from '../src/atom/text/text.js';
import { TsonAtomValidationError } from '../src/core/errors.js';
import type { TextType } from '../src/schema/meta/atoms-text.js';

/**
 * `atom/text/text.ts` -- ported from `atom/TextParser.java`, added for `reader/schemaless/
 * vocabulary.ts`'s own built-in `text` entry (see that module's own TSDoc on why this atom family
 * was never written by Wave 1's own atom sub-agents).
 */

const UNCONSTRAINED: TextType = { kind: 'text_type' };

describe('createTextParser -- text_type (§5.7)', () => {
  it('unconstrained: every token text is a valid value, verbatim', () => {
    const parser = createTextParser('text', UNCONSTRAINED);
    expect(parser.read({ text: 'hello', form: 'single-line' })).toBe('hello');
    expect(parser.read({ text: '123', form: 'unquoted' })).toBe('123');
    expect(parser.write('hello')).toBe('hello');
  });

  it('enforces an exact length', () => {
    const parser = createTextParser('text', { kind: 'text_type', length: 3 });
    expect(parser.read({ text: 'abc', form: 'single-line' })).toBe('abc');
    expect(() => parser.read({ text: 'abcd', form: 'single-line' })).toThrow(
      TsonAtomValidationError,
    );
  });

  it('enforces minLength/maxLength', () => {
    const parser = createTextParser('text', { kind: 'text_type', minLength: 2, maxLength: 4 });
    expect(parser.read({ text: 'ab', form: 'single-line' })).toBe('ab');
    expect(parser.read({ text: 'abcd', form: 'single-line' })).toBe('abcd');
    expect(() => parser.read({ text: 'a', form: 'single-line' })).toThrow(TsonAtomValidationError);
    expect(() => parser.read({ text: 'abcde', form: 'single-line' })).toThrow(
      TsonAtomValidationError,
    );
  });

  it('a validation failure carries an ordering-bound `expected` fragment, never the atom name', () => {
    const parser = createTextParser('text', { kind: 'text_type', maxLength: 1 });
    try {
      parser.read({ text: 'ab', form: 'single-line' });
      expect.fail('expected a TsonAtomValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(TsonAtomValidationError);
      expect((error as TsonAtomValidationError).expected).toBe('at most 1 characters');
    }
  });
});
