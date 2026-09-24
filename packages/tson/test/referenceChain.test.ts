import { describe, expect, it } from 'vitest';

import { terminal, terminalDefinition } from '../src/compiler/referenceChain.js';
import { TsonLimitRefusedError } from '../src/core/errors.js';
import type { RecordBody } from '../src/schema/meta/bodies.js';
import type { Reference, TypeDefinition, TypeRef } from '../src/schema/meta/typedef.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

function ref(name: string, args: readonly TypeRef[] = []): TypeRef {
  return {
    name,
    arguments: args.map((r) => ({ kind: 'ref' as const, ref: r })),
    annotations: [],
  };
}

/** A plain, non-reference PRODUCT entry -- the terminal every alias chain below walks to. */
function recordEntry(): TypeDefinition {
  const body: RecordBody = {
    kind: 'record',
    supertypes: [],
    fields: [],
    groups: [],
    extension: 'OPEN',
    discriminators: [],
  };
  return { supertypes: [], subtypes: [], body, annotations: [] };
}

/** A REFERENCE entry -- an alias to `target`. */
function aliasOf(target: TypeRef): TypeDefinition {
  const body: Reference = { kind: 'reference', target };
  return { source: target, supertypes: [], subtypes: [], body, annotations: [] };
}

function lookup(
  namespace: ReadonlyMap<string, TypeDefinition>,
): (name: string) => TypeDefinition | undefined {
  return (name) => namespace.get(name);
}

// ── §8.3's walk ──────────────────────────────────────────────────────────────────────────────

describe('the reference-chain walk (§8.3)', () => {
  it('terminal() follows a multi-hop alias chain to the entry at its end (doc => documentation => text)', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['text', recordEntry()],
      ['documentation', aliasOf(ref('text'))],
      ['doc', aliasOf(ref('documentation'))],
    ]);
    expect(terminal('doc', lookup(namespace))).toBe('text');
    expect(terminalDefinition('doc', lookup(namespace))).toBe(namespace.get('text'));
  });

  it('returns the name itself, unchanged, when it does not start a chain', () => {
    const namespace = new Map<string, TypeDefinition>([['text', recordEntry()]]);
    expect(terminal('text', lookup(namespace))).toBe('text');
  });

  it('stops at a materialised instantiation rather than walking through it -- an application, not a further hop, once minted', () => {
    // string_triple => vector<text, 3>, over an already-minted instantiation entry.
    const namespace = new Map<string, TypeDefinition>([
      ['array_text_3', recordEntry()],
      ['string_triple', aliasOf(ref('array_text_3'))],
    ]);
    expect(terminal('string_triple', lookup(namespace))).toBe('array_text_3');
  });

  it('does not walk through an argument-bearing reference target -- an application, not a hop to another entry', () => {
    // partial => <B> box<B>: still open, so its target carries an argument.
    const namespace = new Map<string, TypeDefinition>([
      ['box', recordEntry()],
      ['partial', aliasOf(ref('box', [ref('B')]))],
    ]);
    // The walk stops *at* `partial` itself: its own target has an argument, so it is the
    // terminal, not `box`.
    expect(terminal('partial', lookup(namespace))).toBe('partial');
    expect(terminalDefinition('partial', lookup(namespace))).toBe(namespace.get('partial'));
  });

  it('stops a reference cycle at the name that closes it rather than looping forever, and terminalDefinition answers with undefined', () => {
    const namespace = new Map<string, TypeDefinition>([
      ['a', aliasOf(ref('b'))],
      ['b', aliasOf(ref('a'))],
    ]);
    expect(['a', 'b']).toContain(terminal('a', lookup(namespace)));
    expect(terminalDefinition('a', lookup(namespace))).toBeUndefined();
  });

  it('leaves an undeclared name exactly as written, and terminalDefinition answers with undefined', () => {
    const namespace = new Map<string, TypeDefinition>();
    expect(terminal('nowhere', lookup(namespace))).toBe('nowhere');
    expect(terminalDefinition('nowhere', lookup(namespace))).toBeUndefined();
  });

  it('walks past a name that resolves but is itself not yet declared further down the chain (a broken hop) and stops there', () => {
    const namespace = new Map<string, TypeDefinition>([['a', aliasOf(ref('nowhere'))]]);
    expect(terminal('a', lookup(namespace))).toBe('nowhere');
    expect(terminalDefinition('a', lookup(namespace))).toBeUndefined();
  });
});

// ── [TSON-SCHEMA] §11.5's "reference chain" limit ───────────────────────────────────────────────

/** A straight-line alias chain `a0 -> a1 -> ... -> aN -> text`, N hops long. */
function chainOf(hops: number): Map<string, TypeDefinition> {
  const namespace = new Map<string, TypeDefinition>([['text', recordEntry()]]);
  for (let i = hops - 1; i >= 0; i--) {
    namespace.set(`a${String(i)}`, aliasOf(ref(i === hops - 1 ? 'text' : `a${String(i + 1)}`)));
  }
  return namespace;
}

describe('§11.5\'s "reference chain" limit', () => {
  it('a chain exactly at the default (64 hops) resolves cleanly', () => {
    const namespace = chainOf(64);
    expect(terminal('a0', lookup(namespace))).toBe('text');
  });

  it('one hop past the default (65) is a limit refusal, not a resolver error', () => {
    const namespace = chainOf(65);
    const error = (() => {
      try {
        terminal('a0', lookup(namespace));
      } catch (e) {
        return e;
      }
      throw new Error('expected to throw');
    })();
    expect(error).toBeInstanceOf(TsonLimitRefusedError);
    expect((error as TsonLimitRefusedError).limit).toBe('reference-chain');
    expect((error as TsonLimitRefusedError).configuredThreshold).toBe(64);
  });

  it('an explicit `maxHops` overrides the default', () => {
    const namespace = chainOf(5);
    expect(terminal('a0', lookup(namespace), 5)).toBe('text');
    expect(() => terminal('a0', lookup(namespace), 4)).toThrow(TsonLimitRefusedError);
  });

  it('terminalDefinition raises the same refusal, not `undefined`', () => {
    const namespace = chainOf(3);
    expect(() => terminalDefinition('a0', lookup(namespace), 2)).toThrow(TsonLimitRefusedError);
  });
});
