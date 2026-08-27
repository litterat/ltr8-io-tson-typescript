import { describe, expect, it } from 'vitest';
import { resolveBaseType, type BaseToken } from '../src/base/baseTypeResolver.js';
import type { BasedIntegerForm, IntegerForm } from '../src/base/numberGrammar.js';

// Base type resolution (§4): the fixed order of §4.5 -- null, boolean, number, string.

function unquoted(text: string): BaseToken {
  return { text, form: 'unquoted' };
}

describe('null and boolean (§4.1, §4.2)', () => {
  it('resolves the unquoted keyword "null" to the null value', () => {
    expect(resolveBaseType(unquoted('null'))).toEqual({ kind: 'null' });
  });

  it('resolves "true" and "false" to boolean values', () => {
    expect(resolveBaseType(unquoted('true'))).toEqual({ kind: 'boolean', value: true });
    expect(resolveBaseType(unquoted('false'))).toEqual({ kind: 'boolean', value: false });
  });

  it('is case-sensitive, lowercase only -- no Yes/No/on/off/True/FALSE', () => {
    for (const text of ['Null', 'NULL', 'True', 'FALSE', 'yes', 'on']) {
      expect(resolveBaseType(unquoted(text))).toEqual({ kind: 'string', text });
    }
  });
});

describe('number delegation (§4.3)', () => {
  it('an unquoted number-shaped token resolves to a NumberValue wrapping the recognized form', () => {
    const value = resolveBaseType(unquoted('1042'));
    expect(value.kind).toBe('number');
    expect((value as { form: IntegerForm }).form.kind).toBe('integer');
  });

  it('a based integer resolves to a NumberValue too', () => {
    const value = resolveBaseType(unquoted('0b0110'));
    expect(value.kind).toBe('number');
    expect((value as { form: BasedIntegerForm }).form.radix).toBe('binary');
  });
});

describe('string fallback (§4.4)', () => {
  it('near-miss numeric forms fall through to string -- leading zeros and a second dot fail the grammar', () => {
    expect(resolveBaseType(unquoted('007'))).toEqual({ kind: 'string', text: '007' });
    expect(resolveBaseType(unquoted('1.2.3'))).toEqual({ kind: 'string', text: '1.2.3' });
  });

  it('plain words resolve to string, exact text preserved', () => {
    expect(resolveBaseType(unquoted('GOLD'))).toEqual({ kind: 'string', text: 'GOLD' });
    expect(resolveBaseType(unquoted('A-100'))).toEqual({ kind: 'string', text: 'A-100' });
  });

  it('the complex form resolves to string under base resolution (§4.3)', () => {
    expect(resolveBaseType(unquoted('3+4i'))).toEqual({ kind: 'string', text: '3+4i' });
  });
});

describe('quoted tokens always resolve to string, regardless of content (§4.4)', () => {
  it('a single-line quoted numeric/boolean/null-spelled token is still a string', () => {
    expect(resolveBaseType({ text: '42', form: 'single-line' })).toEqual({
      kind: 'string',
      text: '42',
    });
    expect(resolveBaseType({ text: 'true', form: 'single-line' })).toEqual({
      kind: 'string',
      text: 'true',
    });
    expect(resolveBaseType({ text: 'null', form: 'single-line' })).toEqual({
      kind: 'string',
      text: 'null',
    });
  });

  it('a multi-line quoted token is likewise always a string', () => {
    expect(resolveBaseType({ text: 'null', form: 'multi-line' })).toEqual({
      kind: 'string',
      text: 'null',
    });
  });

  it('quoted and unquoted identical text resolve differently -- form is consulted once (§2.4)', () => {
    expect(resolveBaseType(unquoted('42')).kind).toBe('number');
    expect(resolveBaseType({ text: '42', form: 'single-line' })).toEqual({
      kind: 'string',
      text: '42',
    });
  });
});
