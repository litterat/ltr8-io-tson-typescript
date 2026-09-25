/**
 * {@link Value}-typed wrapper over `value/equality.ts`'s own {@link deepEqual} -- what
 * `record.ts`'s FIXED-field check needs to compare a document-stated value against the schema's
 * own precomputed one (§5.2: "a contradicting value is a validation error"). Also the one place
 * set-membership (`array.ts`) and map-key duplication (`map.ts`) decide two values are "the
 * same" -- so `link/recordExtension.ts`/`compiler/subsumption.ts` reuse it a third time for
 * family pin distinctness, rather than each re-deriving it.
 *
 * **The comparison itself lives in `value/equality.ts`**, a directory outside the `src/json/**`
 * ESLint zone's reach (`eslint.config.js` forbids that zone from importing this module's own
 * directory, `reader/`, at all), so a JSON-side reader can reach the same value-identity function
 * this package's text reader uses rather than writing a second
 * (`design/json-schema-directed-reading.md`'s own `ValueIdentity` note: "the peer of
 * `tson-compiler`'s `ValueIdentity`, and one whose two copies must agree"). This file holds only
 * {@link valuesEqual}, the one specialisation that needs {@link Value} itself -- a type `value/`
 * must not import, per `tree/`'s own zone ("`tree/` may import only itself, `core/`,
 * `annotations/` and `value/`") -- and re-exports {@link deepEqual} unchanged for every other
 * caller.
 */
import { deepEqual } from '../../value/equality.js';
import type { Value } from '../../tree/nodes.js';

export {
  deepEqual,
  decimalIdentityKey,
  dateTimeInstantSeconds,
  timeOfDayWrapped,
  isTsonDecimal,
  isPlainDateTime,
  isPlainTime,
} from '../../value/equality.js';

/** {@link deepEqual} specialised to two {@link Value} tree nodes -- the shape `record.ts`'s FIXED check actually compares. */
export function valuesEqual(a: Value, b: Value): boolean {
  return deepEqual(a, b);
}
