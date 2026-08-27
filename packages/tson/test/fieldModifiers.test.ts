import { describe, expect, it } from 'vitest';

import { resolveFieldModifiers } from '../src/compiler/fieldModifiers.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { FieldModifier } from '../src/ast/schema/fields.js';

const literal = (text: string): FieldModifier['value'] => ({
  kind: 'literal',
  token: { kind: 'token', text, form: 'unquoted' },
});
const absent = (): FieldModifier['value'] => ({ kind: 'absent' });

describe("resolveFieldModifiers (§5.2's field-state table)", () => {
  it('no modifier: REQUIRED (required) / OPTIONAL (optional), no value', () => {
    expect(resolveFieldModifiers('f', false, undefined, [])).toEqual({ state: 'REQUIRED' });
    expect(resolveFieldModifiers('f', true, undefined, [])).toEqual({ state: 'OPTIONAL' });
  });

  it('`~ value` on a required field: REQUIRED_DEFAULT, carrying the value', () => {
    expect(
      resolveFieldModifiers('f', false, { kind: 'default', value: literal('8080') }, []),
    ).toEqual({
      state: 'REQUIRED_DEFAULT',
      value: { kind: 'token', text: '8080', form: 'unquoted' },
    });
  });

  it('`= value` on a required field: REQUIRED_FIXED', () => {
    expect(
      resolveFieldModifiers('f', false, { kind: 'fixed', value: literal('x') }, []).state,
    ).toBe('REQUIRED_FIXED');
  });

  it('`= value` on an optional field: OPTIONAL_FIXED', () => {
    expect(resolveFieldModifiers('f', true, { kind: 'fixed', value: literal('x') }, []).state).toBe(
      'OPTIONAL_FIXED',
    );
  });

  it('`= _` on an optional field: OPTIONAL_FIXED with no value', () => {
    expect(resolveFieldModifiers('f', true, { kind: 'fixed', value: absent() }, [])).toEqual({
      state: 'OPTIONAL_FIXED',
    });
  });

  it('`= _` on a required field is rejected', () => {
    expect(() => resolveFieldModifiers('f', false, { kind: 'fixed', value: absent() }, [])).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('`~ _` is rejected on any field', () => {
    expect(() =>
      resolveFieldModifiers('f', false, { kind: 'default', value: absent() }, []),
    ).toThrow(TsonSchemaValidationError);
    expect(() =>
      resolveFieldModifiers('f', true, { kind: 'default', value: absent() }, []),
    ).toThrow(TsonSchemaValidationError);
  });

  it('a default on an optional field is rejected (contradicts optional)', () => {
    expect(() =>
      resolveFieldModifiers('f', true, { kind: 'default', value: literal('x') }, []),
    ).toThrow(TsonSchemaValidationError);
  });

  it('a token naming a declared parameter is parametric: `= P` stays REQUIRED, `~ P` is REQUIRED_DEFAULT (§5.7 open modifiers)', () => {
    expect(
      resolveFieldModifiers('f', false, { kind: 'fixed', value: literal('T') }, ['T']).state,
    ).toBe('REQUIRED');
    expect(
      resolveFieldModifiers('f', false, { kind: 'default', value: literal('T') }, ['T']).state,
    ).toBe('REQUIRED_DEFAULT');
  });

  it('a token merely spelled like a parameter, outside a template, is an ordinary literal', () => {
    expect(
      resolveFieldModifiers('f', false, { kind: 'fixed', value: literal('T') }, []).state,
    ).toBe('REQUIRED_FIXED');
  });
});
