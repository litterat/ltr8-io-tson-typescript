/**
 * Two value-identity questions over what this package's schema-directed readers decode, matching
 * the Java reference's own `ValueIdentity` split:
 *
 * - {@link identityOfHost} — a **decoded host value** (what `atom/forType.ts`'s parsers produce:
 *   `bigint`, {@link TsonDecimal}, a plain `number`, a `string`, `Uint8Array`, a temporal record,
 *   …), for an atom set element, a sealed family's discriminator pin, or a record's FIXED check.
 *   **A thin re-export of `value/equality.ts`'s own {@link identityKey}** — the one definition of
 *   value-space identity both encodings' readers compare by (`value/equality.ts`'s own top note:
 *   "the peer of `tson-compiler`'s `ValueIdentity`, and one whose two copies must agree"). Pin
 *   comparison, set duplicates and map-key identity all go through this one function, on both the
 *   JSON side and the text side ({@link deepEqual} there, over the same equivalence classes).
 * - {@link identityOfNode} — a **decoded `JsonValue` tree** ([TSON-JSON] §6.4's pairs-form
 *   compound key, or a compound set element): a `JsonNumber` compares by value and not by lexeme
 *   (so `1`/`1.0` are one key), a `JsonString` compares under NFC, member order is dropped (§6.1.6
 *   gives it none), and the reduction recurses through arrays and objects since a compound key may
 *   itself hold one. This one genuinely has no counterpart in `value/equality.ts`: a `JsonValue`
 *   is this package's own tree shape, unreachable from `value/` (`tree/`'s own zone note in
 *   `eslint.config.js` — `value/` has no dependency on any encoding's own tree model, JSON's
 *   included), so its reduction stays here.
 */
import { decimalIdentityKey, identityKey } from '../../value/equality.js';
import { toNfc } from '../../unicode/nfc.js';
import { toBigDecimal, type JsonValue } from '../tree.js';

/** A value carrying its own identity beside it — a tree-mode atom reader's own node (`json/schema/atoms.ts`'s `treeAtomKeyedReader`), whose spelling and value space are two different things. */
export interface Identified {
  readonly node: JsonValue;
  readonly identity: string;
}

/** Whether `value` is a tree-mode atom's own {@link Identified} pair, rather than a plain `JsonValue` a compound reader produced directly. */
export function isIdentified(value: unknown): value is Identified {
  return (
    typeof value === 'object' &&
    value !== null &&
    'node' in value &&
    'identity' in value &&
    typeof (value as { identity: unknown }).identity === 'string'
  );
}

/** `value` reduced to a canonical value-space identity string — {@link identityKey}, or `value.identity` unchanged where `value` already carries one ({@link isIdentified}). */
export function identityOfHost(value: unknown): string {
  return isIdentified(value) ? value.identity : identityKey(value);
}

/** `node` reduced the way {@link identityOfHost} reduces a decoded host value, but over a `JsonValue` tree — [TSON-JSON] §6.4's compound-key reduction. */
export function identityOfNode(node: JsonValue): string {
  switch (node.kind) {
    case 'number':
      return `n:${decimalIdentityKey(toBigDecimal(node))}`;
    case 'string':
      return `s:${toNfc(node.value)}`;
    case 'boolean':
      return `b:${String(node.value)}`;
    case 'null':
      return 'null';
    case 'array':
      return `[${node.elements.map(identityOfNode).join(',')}]`;
    case 'object': {
      // §6.1.6: member order carries no meaning, so two objects differing only in order are one
      // key -- sorted by the NFC-reduced name so the reduction itself carries no order either.
      const entries = [...node.members.entries()]
        .map(([name, value]) => `${toNfc(name)}:${identityOfNode(value)}`)
        .sort();
      return `{${entries.join(',')}}`;
    }
  }
}
