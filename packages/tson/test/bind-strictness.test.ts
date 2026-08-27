import { describe, expect, it } from 'vitest';
import { field, lazy, record } from '../src/bind/combinators.js';
import { checkBinding, checkRecordBinding } from '../src/bind/strictness.js';
import { TsonBindMismatchError } from '../src/core/errors.js';
import type { RecordField } from '../src/schema/meta/bodies.js';
import type { TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';
import type { AtomBinding, Binding, RecordBinding } from '../src/bind/binding.js';

/**
 * `bind/strictness.ts` -- the schema-versus-binding cross-check for records ([TSON-SCHEMA] §5.2):
 * every non-FIXED field needs a binding slot, and every slot needs to fill a field, raised as
 * {@link TsonBindMismatchError} rather than deferred to first read. Tested against §5.2's own field
 * state table (lines 438-459 of the spec) for which states are exempt.
 */

function atomBinding<T>(wireType: string): Binding<T> {
  return { kind: 'atom', wireType } as unknown as AtomBinding<T>;
}
const INT: Binding<number> = atomBinding('int32');

function typeRef(name: string): TypeRef {
  return { name, arguments: [], annotations: [] };
}

function recordField(name: string, state: RecordField['state'] = 'REQUIRED'): RecordField {
  return { name, type: typeRef('int32'), state, annotations: [] };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function pointBinding(): RecordBinding<Point> {
  return record<Point>({
    fields: [field<Point, 'x'>(0, 'x', 'x', INT), field<Point, 'y'>(1, 'y', 'y', INT)],
    construct: ([x, y]) => ({ x: x as number, y: y as number }),
  });
}

describe('checkRecordBinding -- every non-FIXED field needs a slot (§5.2)', () => {
  it('passes when every REQUIRED field has a matching slot', () => {
    const fields = [recordField('x'), recordField('y')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).not.toThrow();
  });

  it('throws TsonBindMismatchError when a REQUIRED field has no slot', () => {
    const fields = [recordField('x'), recordField('y'), recordField('z')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).toThrow(TsonBindMismatchError);
  });

  it('throws when a REQUIRED_DEFAULT field has no slot -- its injected value still needs storage', () => {
    const fields = [recordField('x'), recordField('y'), recordField('z', 'REQUIRED_DEFAULT')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).toThrow(TsonBindMismatchError);
  });

  it('throws when an OPTIONAL field has no slot -- OPTIONAL is deliberately not exempt', () => {
    const fields = [recordField('x'), recordField('y'), recordField('label', 'OPTIONAL')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).toThrow(TsonBindMismatchError);
  });

  it('does not require a slot for a REQUIRED_FIXED field', () => {
    const fields = [recordField('x'), recordField('y'), recordField('pinned', 'REQUIRED_FIXED')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).not.toThrow();
  });

  it('does not require a slot for an OPTIONAL_FIXED field', () => {
    const fields = [recordField('x'), recordField('y'), recordField('pinned', 'OPTIONAL_FIXED')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).not.toThrow();
  });
});

describe('checkRecordBinding -- every slot needs to fill a field', () => {
  it('throws TsonBindMismatchError when a slot matches no field', () => {
    const fields = [recordField('x')];
    const binding = pointBinding();
    expect(() => {
      checkRecordBinding('point', fields, binding);
    }).toThrow(TsonBindMismatchError);
  });

  it("a slot bound at a FIXED field's wire name is not reported as unmatched", () => {
    interface Pinned {
      readonly x: number;
      readonly y: number;
    }
    const binding = record<Pinned>({
      fields: [field<Pinned, 'x'>(0, 'x', 'x', INT), field<Pinned, 'y'>(1, 'y', 'y', INT)],
      construct: ([x, y]) => ({ x: x as number, y: y as number }),
    });
    const fields = [recordField('x'), recordField('y', 'REQUIRED_FIXED')];
    expect(() => {
      checkRecordBinding('pinned', fields, binding);
    }).not.toThrow();
  });

  it('an unbound slot (an annotations carrier) is excluded from byWireName and never reported', () => {
    interface Carrier {
      readonly x: number;
      readonly meta: unknown;
    }
    const carrierSlot = { ...field<Carrier, 'meta'>(1, 'meta', 'meta', INT), unbound: true };
    const binding = record<Carrier>({
      fields: [field<Carrier, 'x'>(0, 'x', 'x', INT), carrierSlot],
      construct: ([x, meta]) => ({ x: x as number, meta }),
    });
    const fields = [recordField('x')];
    expect(() => {
      checkRecordBinding('carrier', fields, binding);
    }).not.toThrow();
  });
});

describe('checkBinding -- dispatches from a TypeDefinition without hand-narrowing its body', () => {
  function recordDefinition(fields: readonly RecordField[]): TypeDefinition {
    return {
      kind: 'PRODUCT',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'record', supertypes: [], fields, groups: [] },
      annotations: [],
    };
  }

  it('checks a record definition against a record binding', () => {
    const definition = recordDefinition([recordField('x'), recordField('y')]);
    const binding = pointBinding();
    expect(() => {
      checkBinding('point', definition, binding);
    }).not.toThrow();
  });

  it('reports the same mismatch checkRecordBinding would', () => {
    const definition = recordDefinition([recordField('x'), recordField('y'), recordField('z')]);
    const binding = pointBinding();
    expect(() => {
      checkBinding('point', definition, binding);
    }).toThrow(TsonBindMismatchError);
  });

  it('resolves a lazy binding before checking it', () => {
    const definition = recordDefinition([recordField('x'), recordField('y')]);
    const lazyBinding = lazy((): Binding<Point> => pointBinding());
    expect(() => {
      checkBinding('point', definition, lazyBinding);
    }).not.toThrow();
  });

  it('is a no-op for a non-record definition (e.g. an atom-kind type)', () => {
    const definition: TypeDefinition = {
      kind: 'ATOM',
      parameters: [],
      constructor: false,
      supertypes: [],
      subtypes: [],
      body: { kind: 'unit' },
      annotations: [],
    };
    expect(() => {
      checkBinding('void', definition, INT);
    }).not.toThrow();
  });

  it('throws when a record definition is paired with a non-record binding', () => {
    const definition = recordDefinition([recordField('x'), recordField('y')]);
    expect(() => {
      checkBinding('point', definition, INT);
    }).toThrow(TsonBindMismatchError);
  });

  it('reports every uncovered field and every unmatched slot together, in one message', () => {
    const fields = [recordField('x'), recordField('z')];
    const binding = pointBinding();
    try {
      checkRecordBinding('point', fields, binding);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsonBindMismatchError);
      const message = (error as Error).message;
      expect(message).toContain('z');
      expect(message).toContain('y');
    }
  });
});
