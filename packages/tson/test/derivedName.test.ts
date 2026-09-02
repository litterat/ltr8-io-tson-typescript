import { describe, expect, it } from 'vitest';

import {
  canonicalApplication,
  canonicalBinding,
  ofApplication,
  ofBinding,
} from '../src/compiler/derivedName.js';
import type { RecordField } from '../src/ast/value.js';
import type { TypeArgument } from '../src/schema/meta/typedef.js';

/** A bare unquoted-token field, the shape `desugar.ts` builds for a binding record. */
function tokenField(
  name: string,
  text: string,
  form: 'unquoted' | 'single-line' = 'unquoted',
): RecordField {
  return { name, value: { value: { annotations: [], coreValue: { kind: 'token', text, form } } } };
}

function ref(name: string): TypeArgument {
  return { kind: 'ref', ref: { name, arguments: [], annotations: [] } };
}

function literal(
  text: string,
  form: 'UNQUOTED' | 'SINGLE_LINE_QUOTED' = 'SINGLE_LINE_QUOTED',
): TypeArgument {
  return { kind: 'value', value: { text, form } };
}

/** A minted name's own grammar: ASCII, `identifier`-admitted parts joined by `_`. */
const MINTED_NAME_SHAPE = /^[A-Za-z0-9_-]+$/;

describe('ofBinding', () => {
  it('is deterministic for the same head and fields', () => {
    const fields = [tokenField('element_type', 'text')];
    expect(ofBinding('array', fields)).toBe(ofBinding('array', fields));
  });

  it('routes every field text through internalName.ts, so §7.7-inadmissible characters never reach the minted name', () => {
    // §8.2's freshness MUST: whatever an author writes into a value slot a lifted form absorbs,
    // the minted name is still a valid identifier -- see internalName.test.ts for `part`'s own
    // contract; this pins that `ofBinding` actually routes through it rather than splicing raw
    // text (an HTTP path is Java's own InternalName.java running example).
    const fields = [tokenField('name', '/orders/{id}', 'single-line')];
    const name = ofBinding('record', fields);
    expect(name).not.toContain('/');
    expect(name).not.toContain('{');
    expect(name).not.toContain('}');
    expect(name).toMatch(MINTED_NAME_SHAPE);
    // The readable characters that did survive sanitisation are still visible, unlike the
    // non-ASCII case below.
    expect(name).toContain('orders');
  });

  it('routes a non-ASCII field value to the hash alone, never splicing the original text', () => {
    const fields = [tokenField('name', 'путь', 'single-line')];
    const name = ofBinding('record', fields);
    expect(name).toMatch(MINTED_NAME_SHAPE);
    expect(name).not.toContain('путь');
  });

  it('a `.` in a numeric literal changes the readable spelling, not the two forms\' identity', () => {
    // §4.3's numeric equivalence is unaffected by sanitisation: `1.0`'s readable half loses the
    // `.` (not XID_Continue) but the canonical rendering -- and so the structural hash -- is the
    // one thing that decides identity, and it goes through NumericIdentity first either way.
    const fields = [tokenField('min_items', '1.0')];
    const name = ofBinding('array', fields);
    expect(name).toMatch(MINTED_NAME_SHAPE);
    expect(name).toContain('1_0');
  });

  it('two binding records that differ genuinely derive two different names', () => {
    expect(ofBinding('array', [tokenField('element_type', 'text')])).not.toBe(
      ofBinding('array', [tokenField('element_type', 'uuid')]),
    );
  });
});

describe('ofApplication', () => {
  it('is deterministic for the same head and arguments', () => {
    const args = [ref('text')];
    expect(ofApplication('box', args)).toBe(ofApplication('box', args));
  });

  it('routes a value argument through internalName.ts, so §7.7-inadmissible characters never reach the minted name', () => {
    const args = [literal('/orders/{id}')];
    const name = ofApplication('endpoint', args);
    expect(name).not.toContain('/');
    expect(name).not.toContain('{');
    expect(name).toMatch(MINTED_NAME_SHAPE);
    expect(name).toContain('orders');
  });

  it("a reference argument's name is sanitised too", () => {
    // A reference argument's readable segment is the referenced type's own name -- ordinarily
    // already an identifier, but nothing stops a consumer's own meta layer declaring one outside
    // ASCII (`ofBinding`'s own head-sanitisation note applies equally here).
    const args = [ref('путь')];
    const name = ofApplication('box', args);
    expect(name).toMatch(MINTED_NAME_SHAPE);
    expect(name).not.toContain('путь');
  });

  it('255 and 0xFF derive one application name (§4.3), through the same numeric identity as before', () => {
    expect(ofApplication('vector', [literal('255', 'UNQUOTED')])).toBe(
      ofApplication('vector', [literal('0xFF', 'UNQUOTED')]),
    );
  });

  it('1 and 1.0 stay two applications: the base type differs under §4 resolution', () => {
    expect(ofApplication('box', [literal('1', 'UNQUOTED')])).not.toBe(
      ofApplication('box', [literal('1.0', 'UNQUOTED')]),
    );
  });
});

describe('the two families are not one function', () => {
  it('a binding-record rendering of {v: text} differs from an application rendering of <text> under the same head', () => {
    // Mirrors the Java reference's own DerivedNameTest#theTwoChannelsAreNotOneFunction: the two
    // renderings are deliberately separate, reusing the same tag letters for different roles, so
    // this must not collide by construction.
    const bindingCanonical = canonicalBinding('box', [tokenField('v', 'text')]);
    const applicationCanonical = canonicalApplication('box', [ref('text')]);
    expect(bindingCanonical).not.toBe(applicationCanonical);
  });
});
