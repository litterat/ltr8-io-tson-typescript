/**
 * `createWaitOrder` ([TSON-SCHEMA] §3.4.1, §11.5): declarations made ready on first asking, a wait on an entry being
 * made ready refused as a cycle in wait order, the chain of waits bounded at its head, and `opens` answered without
 * making anything ready.
 */
import { describe, expect, it } from 'vitest';

import { createWaitOrder } from '../src/compiler/waitOrder.js';
import { desugar } from '../src/compiler/desugar.js';
import { parseSchemaDocument } from '../src/compiler/schemaParser.js';
import { TsonLimitRefusedError, TsonSchemaValidationError } from '../src/core/errors.js';
import { fromString, runSync } from '../src/io/bytes.js';
import type { Top } from '../src/schema/meta/typedef.js';

function declarationsOf(body: string) {
  const document = runSync(parseSchemaDocument(fromString(`!schema {\n${body}\n}\n`)));
  return desugar(document).body.declarations;
}

const RECORD: Top = {
  kind: 'record',
  fields: { entries: new Map() },
  groups: [],
  extension: 'OPEN',
} as unknown as Top;

describe('§3.4.1 the wait order', () => {
  it('makes a declaration ready once, the first time it is asked for, and holds it after', () => {
    const entries = new Map<string, Top>();
    const order = createWaitOrder(entries, declarationsOf('a => { x: text }'), 8);
    let made = 0;
    order.readyWith({
      resolve: () => {
        made += 1;
        return RECORD;
      },
      failed: (_name, _declaration, error) => {
        throw error;
      },
    });
    expect(order.definition('a')).toBe(RECORD);
    expect(order.definition('a')).toBe(RECORD);
    expect(made).toBe(1);
    expect(entries.get('a')).toBe(RECORD);
    expect(order.definition('nowhere')).toBeUndefined();
  });

  it('an entry reached again while it is being made ready waits on itself: a cycle named in wait order', () => {
    const order = createWaitOrder(new Map(), declarationsOf('a => b\nb => a'), 8);
    order.readyWith({
      resolve: (name) => order.definition(name === 'a' ? 'b' : 'a') ?? RECORD,
      failed: (_name, _declaration, error) => {
        throw error;
      },
    });
    expect(() => order.definition('a')).toThrow(TsonSchemaValidationError);
    expect(() => order.definition('a')).toThrow(/'a' waits on 'b' waits on 'a'/);
  });

  it('a chain of waits past max_wait_depth is refused (§11.5)', () => {
    const order = createWaitOrder(
      new Map(),
      declarationsOf('a => b\nb => c\nc => d\nd => { x: text }'),
      1,
    );
    const next: Record<string, string> = { a: 'b', b: 'c', c: 'd' };
    order.readyWith({
      resolve: (name) => {
        const on = next[name];
        return on === undefined ? RECORD : (order.definition(on) ?? RECORD);
      },
      failed: (_name, _declaration, error) => {
        throw error;
      },
    });
    expect(() => order.definition('a')).toThrow(TsonLimitRefusedError);
  });

  it('opens answers through alias targets as written, making nothing ready', () => {
    const order = createWaitOrder(
      new Map(),
      declarationsOf('box => <T> { v: T }\nbx => box\nr => { x: text }'),
      8,
    );
    order.readyWith({
      resolve: () => {
        throw new Error('nothing is made ready by opens');
      },
      failed: (_name, _declaration, error) => {
        throw error;
      },
    });
    expect(order.opens('bx')).toBe(true);
    expect(order.opens('r')).toBe(false);
  });
});
