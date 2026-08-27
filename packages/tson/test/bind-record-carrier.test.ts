import { describe, expect, it } from 'vitest';
import { field, record } from '../src/bind/combinators.js';
import type { Annotations } from '../src/annotations/index.js';

interface Host {
  readonly x: number;
  readonly meta: Annotations;
}

describe('record() excludes the annotations carrier from byWireName', () => {
  // RecordBinding.byWireName's contract says the carrier is never matched by name. Excluding it
  // only via the `unbound` flag makes that depend on the author setting the flag; the reference
  // implementation excludes by identity, and so does this.

  const intBinding = { kind: 'atom', typeRef: 'int32' } as never;
  const annBinding = { kind: 'atom', typeRef: 'annotations' } as never;

  it('leaves a carrier out even when it is not marked unbound', () => {
    const x = field<Host, 'x'>(0, 'x', 'x', intBinding);
    const carrier = field<Host, 'meta'>(1, 'meta', 'meta', annBinding);
    const binding = record<Host>({
      fields: [x, carrier],
      annotationsCarrier: carrier,
      construct: (slots) => ({ x: slots[0] as number, meta: slots[1] as Annotations }),
    });

    expect([...binding.byWireName.keys()]).toEqual(['x']);
    expect(binding.byWireName.has('meta')).toBe(false);
    // It still occupies a construction slot: a real argument has to be filled.
    expect(binding.fields).toHaveLength(2);
    expect(binding.annotationsCarrier).toBe(carrier);
  });

  it('still keeps ordinary fields matchable by wire name', () => {
    const x = field<Host, 'x'>(0, 'renamed', 'x', intBinding);
    const binding = record<Host>({
      fields: [x],
      construct: (slots) => ({ x: slots[0] as number, meta: [] as unknown as Annotations }),
    });
    expect([...binding.byWireName.keys()]).toEqual(['renamed']);
  });
});
