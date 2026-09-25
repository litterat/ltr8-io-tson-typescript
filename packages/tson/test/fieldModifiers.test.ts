import { describe, expect, it } from 'vitest';

import { resolveFieldMarks } from '../src/compiler/fieldModifiers.js';
import { TsonSchemaValidationError } from '../src/core/errors.js';
import type { FieldModifier } from '../src/ast/schema/fields.js';

const literal = (kind: 'default' | 'fixed', text: string): FieldModifier => ({
  kind,
  token: { kind: 'token', text, form: 'unquoted' },
});
const selector = (): FieldModifier => ({ kind: 'selector' });

describe("resolveFieldMarks (§5.2's field-marks table)", () => {
  it('no modifier: optional/voidable as written, role FREE, no value', () => {
    expect(resolveFieldMarks('f', false, false, undefined, [])).toEqual({
      optional: false,
      voidable: false,
      role: 'FREE',
      selector: false,
    });
    expect(resolveFieldMarks('f', true, true, undefined, [])).toEqual({
      optional: true,
      voidable: true,
      role: 'FREE',
      selector: false,
    });
  });

  it('`~ value` on a marked name: role DEFAULT, carrying the value', () => {
    expect(resolveFieldMarks('f', true, false, literal('default', '8080'), [])).toEqual({
      optional: true,
      voidable: false,
      role: 'DEFAULT',
      value: { kind: 'token', text: '8080', form: 'unquoted' },
      selector: false,
    });
  });

  it('`= value` on an unmarked name: role FIXED, a marker the document states itself', () => {
    expect(resolveFieldMarks('f', false, false, literal('fixed', 'x'), []).role).toBe('FIXED');
  });

  it('`= value` on a marked, non-voidable field: role FIXED, injected on omission', () => {
    expect(resolveFieldMarks('f', true, false, literal('fixed', 'x'), []).role).toBe('FIXED');
  });

  it('a pin on a voidable type is rejected (§5.2)', () => {
    expect(() => resolveFieldMarks('f', true, true, literal('fixed', 'x'), [])).toThrow(
      TsonSchemaValidationError,
    );
    expect(() => resolveFieldMarks('f', false, true, literal('fixed', 'x'), [])).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('a default on an unmarked name is rejected (§5.2)', () => {
    expect(() => resolveFieldMarks('f', false, false, literal('default', 'x'), [])).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('the selector `=?` on an unmarked, non-voidable name: FREE, no value, `selector: true`', () => {
    expect(resolveFieldMarks('f', false, false, selector(), [])).toEqual({
      optional: false,
      voidable: false,
      role: 'FREE',
      selector: true,
    });
  });

  it('the selector `=?` on a marked name is rejected (§5.2)', () => {
    expect(() => resolveFieldMarks('f', true, false, selector(), [])).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('the selector `=?` on a voidable type is rejected (§5.2)', () => {
    expect(() => resolveFieldMarks('f', false, true, selector(), [])).toThrow(
      TsonSchemaValidationError,
    );
  });

  it('a token naming a declared parameter is parametric even on an unmarked name (§5.7 open modifiers)', () => {
    expect(resolveFieldMarks('f', false, false, literal('fixed', 'T'), ['T']).role).toBe('FIXED');
    expect(resolveFieldMarks('f', false, false, literal('default', 'T'), ['T']).role).toBe(
      'DEFAULT',
    );
  });

  it('a token merely spelled like a parameter, outside a template, is an ordinary literal, and still needs the name marked for a default', () => {
    expect(resolveFieldMarks('f', true, false, literal('fixed', 'T'), []).role).toBe('FIXED');
    expect(() => resolveFieldMarks('f', false, false, literal('default', 'T'), [])).toThrow(
      TsonSchemaValidationError,
    );
  });
});
