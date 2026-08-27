import { describe, expect, it } from 'vitest';

import { substitute, substituteApplication } from '../src/compiler/templateSubstitution.js';
import { TsonNotImplementedError } from '../src/core/errors.js';
import type { TypeArgument } from '../src/schema/meta/typedef.js';
import type { CoreValue } from '../src/ast/value.js';

function bindings(entries: Record<string, TypeArgument>): Map<string, TypeArgument> {
  return new Map(Object.entries(entries));
}

describe('substitute (§5.10)', () => {
  it('rewrites an unquoted token naming a parameter, at the top level', () => {
    const held: CoreValue = { kind: 'token', text: 'T', form: 'unquoted' };
    const result = substitute(
      held,
      'array',
      ['T'],
      bindings({ T: { kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } } }),
    );
    expect(result).toEqual({ kind: 'token', text: 'text', form: 'unquoted' });
  });

  it('leaves a quoted token alone, even if its text matches a parameter name', () => {
    const held: CoreValue = { kind: 'token', text: 'T', form: 'single-line' };
    const result = substitute(
      held,
      'array',
      ['T'],
      bindings({ T: { kind: 'value', value: { text: 'literal', form: 'UNQUOTED' } } }),
    );
    expect(result).toEqual(held);
  });

  it('a literal argument substitutes to its own token form, quoted or not', () => {
    const held: CoreValue = { kind: 'token', text: 'N', form: 'unquoted' };
    const result = substitute(
      held,
      'array',
      ['N'],
      bindings({ N: { kind: 'value', value: { text: '3', form: 'UNQUOTED' } } }),
    );
    expect(result).toEqual({ kind: 'token', text: '3', form: 'unquoted' });
  });

  it('descends into an array, rewriting each element', () => {
    const held: CoreValue = {
      kind: 'array',
      elements: [
        { value: { annotations: [], coreValue: { kind: 'token', text: 'T', form: 'unquoted' } } },
        {
          value: { annotations: [], coreValue: { kind: 'token', text: 'error', form: 'unquoted' } },
        },
      ],
    };
    const result = substitute(
      held,
      'choice',
      ['T'],
      bindings({ T: { kind: 'ref', ref: { name: 'uuid', arguments: [], annotations: [] } } }),
    );
    if (result.kind !== 'array') throw new Error('unreachable');
    expect(result.elements[0]?.value.coreValue).toEqual({
      kind: 'token',
      text: 'uuid',
      form: 'unquoted',
    });
    // `error` names no parameter, so it passes through unchanged.
    expect(result.elements[1]?.value.coreValue).toEqual({
      kind: 'token',
      text: 'error',
      form: 'unquoted',
    });
  });

  it("a parameter bound to a literal, standing in a type_ref's own `name` member, moves to `value` (§8.1)", () => {
    const held: CoreValue = {
      kind: 'record',
      fields: [
        {
          name: 'name',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: 'N', form: 'unquoted' } },
          },
        },
      ],
    };
    const result = substitute(
      held,
      'vector',
      ['N'],
      bindings({ N: { kind: 'value', value: { text: '1920', form: 'UNQUOTED' } } }),
    );
    if (result.kind !== 'record') throw new Error('unreachable');
    expect(result.fields).toEqual([
      {
        name: 'value',
        value: {
          value: { annotations: [], coreValue: { kind: 'token', text: '1920', form: 'unquoted' } },
        },
      },
    ]);
  });

  it('a parameter bound to a reference stays on `name`, spelled the way an application would be', () => {
    const held: CoreValue = {
      kind: 'record',
      fields: [
        {
          name: 'name',
          value: {
            value: { annotations: [], coreValue: { kind: 'token', text: 'T', form: 'unquoted' } },
          },
        },
      ],
    };
    const result = substitute(
      held,
      'array',
      ['T'],
      bindings({ T: { kind: 'ref', ref: { name: 'uuid', arguments: [], annotations: [] } } }),
    );
    if (result.kind !== 'record') throw new Error('unreachable');
    expect(result.fields[0]?.name).toBe('name');
    expect(result.fields[0]?.value.value.coreValue).toEqual({
      kind: 'token',
      text: 'uuid',
      form: 'unquoted',
    });
  });

  it('throws TsonNotImplementedError for a parameter this application does not supply (an enclosing template still open)', () => {
    const held: CoreValue = { kind: 'token', text: 'U', form: 'unquoted' };
    expect(() => substitute(held, 'array', ['U'], bindings({}))).toThrow(TsonNotImplementedError);
  });

  it('substituteApplication rewrites only the core value, keeping annotations and type-ref', () => {
    const application = {
      annotations: [{ name: 'doc' }],
      typeRef: 'array',
      coreValue: { kind: 'token' as const, text: 'T', form: 'unquoted' as const },
    };
    const result = substituteApplication(
      application,
      'array',
      ['T'],
      bindings({ T: { kind: 'ref', ref: { name: 'text', arguments: [], annotations: [] } } }),
    );
    expect(result.annotations).toBe(application.annotations);
    expect(result.typeRef).toBe('array');
    expect(result.coreValue).toEqual({ kind: 'token', text: 'text', form: 'unquoted' });
  });
});
