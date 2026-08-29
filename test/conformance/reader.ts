/**
 * Conformance-harness bridge from the real {@link readTree} (`facade/tree.ts`, schemaless) to the
 * suite's own `reader-sidecar.tn` shapes. Unlike `lexer.ts`/`parser.ts`/`resolver.ts`/
 * `vocabulary.ts`, this module does not *map* the real output into an `Expected*` shape for the
 * caller to `toEqual` against — a reader-layer `number` atom is compared **by decoded value, not
 * spelling** (§4.3 leaves the host numeric type an implementation concern), which a structural
 * equality check cannot express. Instead this module carries its own recursive comparison,
 * {@link assertReaderValueMatches}, mirroring `ConformanceSuiteTest.assertReaderValueMatches`/
 * `assertAtomMatches` in the reference implementation.
 *
 * See the test-suite README's "The reader layer" section: §1.2 leaves a set of rules to no tier
 * below this one (§2.5's unique field names, §2.6's key identity, §2.8's empty brace, §2.9's
 * absent-key restriction), so a schemaless `readTree` is the first thing that can give a Class 1
 * document its verdict, and this is the harness's bridge to it.
 */

import { readTree } from '../../packages/tson/src/facade/tree.js';
import { compareDecimal } from '../../packages/tson/src/atom/numeric/decimalMath.js';
import { TsonInternalError } from '../../packages/tson/src/core/errors.js';
import type { AtomValue, Value } from '../../packages/tson/src/tree/nodes.js';
import type { TsonDecimal } from '../../packages/tson/src/value/types.js';
import type { ExpectedReaderAtom, ExpectedReaderValue } from './sidecar.js';

/**
 * Reads `subject`'s raw bytes through the real schemaless tree reader (§2, §4). Throws
 * {@link TsonReadError} exactly as {@link readTree} does, uncaught, for a reader-layer `error`
 * vector — see RUNNER.md rule 3a: the caller (`runner.test.ts`) parses the subject cleanly with
 * the real Tier 3 parser first, so a throw reaching here is the reader's own verdict, not a
 * mis-attributed parse failure.
 */
export function readSchemaless(subject: Uint8Array): Value {
  return readTree(subject);
}

/** `value` is one of the shapes {@link toDecimal} accepts: `bigint` or an already-exact `TsonDecimal`. */
function isTsonDecimalShaped(value: unknown): value is TsonDecimal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'unscaled' in value &&
    'exponent' in value &&
    typeof (value as { unscaled: unknown }).unscaled === 'bigint'
  );
}

/** A readable rendering of an {@link AtomValue} for a mismatch message — never relied on for comparison. */
function describeAtomValue(value: AtomValue): string {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (isTsonDecimalShaped(value)) return `${value.unscaled.toString()}e${String(value.exponent)}`;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, (_key: string, v: unknown) =>
    typeof v === 'bigint' ? `${v.toString()}n` : v,
  );
}

/**
 * `actual`'s exact decimal value, for comparison against a sidecar's own decimal-string `number`.
 * A schemaless read narrows an untyped number token to `bigint` (integer/based-integer) or
 * {@link TsonDecimal} (float) — never plain `number` (that host type is reserved for the two
 * special forms `.nan`/`.inf`, which no reader-layer vector's `reader_atom` can name at all, the
 * schema's own doc says why: "§4's null has no member... a vector turning on it would be testing
 * the model", the same reasoning applying to a value with no exact decimal reading).
 */
function toDecimal(actual: AtomValue, path: string): TsonDecimal {
  if (typeof actual === 'bigint') return { unscaled: actual, exponent: 0 };
  if (isTsonDecimalShaped(actual)) return actual;
  throw new TsonInternalError(
    `${path}: reader-layer 'number' atom expected an exact decimal value, got host value ` +
      describeAtomValue(actual),
  );
}

/**
 * Parses a sidecar's own decimal-string `number` text (always a plain, already-decoded decimal —
 * no based-integer or special-value spelling ever reaches a `reader_atom`, `reader-sidecar.tn`'s
 * own doc) into a {@link TsonDecimal}, by direct digit arithmetic rather than routing through the
 * real `!number` atom parser: that parser's own job is validating a *token*'s grammar, and a
 * sidecar's `text` is already a validated, host-representation-neutral decimal string, not a
 * token this harness needs re-validated.
 */
function parseExpectedDecimal(text: string, path: string): TsonDecimal {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new TsonInternalError(`${path}: '${text}' is not a plain decimal string`);
  }
  const [, signText, integerDigits, fractionDigits] = match;
  const digits = `${integerDigits ?? ''}${fractionDigits ?? ''}`;
  const unscaled = BigInt(`${signText === '-' ? '-' : ''}${digits}`);
  return { unscaled, exponent: -(fractionDigits?.length ?? 0) };
}

function assertAtomMatches(expected: ExpectedReaderAtom, actual: AtomValue, path: string): void {
  switch (expected.kind) {
    case 'boolean':
      if (typeof actual !== 'boolean' || actual !== expected.value) {
        throw new Error(
          `${path}: expected boolean ${String(expected.value)}, got ${describeAtomValue(actual)}`,
        );
      }
      return;
    case 'string':
      if (typeof actual !== 'string' || actual !== expected.text) {
        throw new Error(
          `${path}: expected string ${JSON.stringify(expected.text)}, got ${describeAtomValue(actual)}`,
        );
      }
      return;
    case 'number': {
      const actualDecimal = toDecimal(actual, path);
      const expectedDecimal = parseExpectedDecimal(expected.text, path);
      if (compareDecimal(actualDecimal, expectedDecimal) !== 0) {
        throw new Error(
          `${path}: expected number ${expected.text} (by decoded value), got host value ${describeAtomValue(actual)}`,
        );
      }
      return;
    }
  }
}

/** Pairs `as[i]` with `bs[i]` for every index, asserting the two arrays already have equal length. */
function zipEqualLength<A, B>(as: readonly A[], bs: readonly B[]): readonly (readonly [A, B])[] {
  return as.map((a, i) => [a, bs[i]] as readonly [A, B]);
}

/**
 * Recursively compares `actual` (the real {@link readTree} output) against `expected` (a
 * `reader-sidecar.tn` `reader_value`), by *value* at every leaf rather than by structural
 * equality — see this module's own top note for why. Throws a descriptive `Error` at the first
 * mismatch, `path` naming where in the tree it was found.
 */
export function assertReaderValueMatches(
  expected: ExpectedReaderValue,
  actual: Value,
  path = '$',
): void {
  switch (expected.kind) {
    case 'absent':
      if (actual.kind !== 'absent') {
        throw new Error(`${path}: expected the absent sentinel, got kind '${actual.kind}'`);
      }
      return;
    case 'atom':
      if (actual.kind !== 'atom') {
        throw new Error(`${path}: expected an atom, got kind '${actual.kind}'`);
      }
      assertAtomMatches(expected.atom, actual.value, path);
      return;
    case 'record': {
      if (actual.kind !== 'record') {
        throw new Error(`${path}: expected a record, got kind '${actual.kind}'`);
      }
      const actualFields = [...actual.fields.entries()];
      if (actualFields.length !== expected.fields.length) {
        throw new Error(
          `${path}: expected ${String(expected.fields.length)} field(s), got ${String(actualFields.length)}`,
        );
      }
      for (const [i, [expectedField, [actualName, actualValue]]] of zipEqualLength(
        expected.fields,
        actualFields,
      ).entries()) {
        if (actualName !== expectedField.name) {
          throw new Error(
            `${path}.fields[${String(i)}]: expected field name '${expectedField.name}', got '${actualName}'`,
          );
        }
        assertReaderValueMatches(expectedField.value, actualValue, `${path}.${actualName}`);
      }
      return;
    }
    case 'array': {
      if (actual.kind !== 'array') {
        throw new Error(`${path}: expected an array, got kind '${actual.kind}'`);
      }
      if (actual.elements.length !== expected.elements.length) {
        throw new Error(
          `${path}: expected ${String(expected.elements.length)} element(s), got ${String(actual.elements.length)}`,
        );
      }
      for (const [i, [expectedElement, actualElement]] of zipEqualLength(
        expected.elements,
        actual.elements,
      ).entries()) {
        assertReaderValueMatches(expectedElement, actualElement, `${path}[${String(i)}]`);
      }
      return;
    }
    case 'map': {
      if (actual.kind !== 'map') {
        throw new Error(`${path}: expected a map, got kind '${actual.kind}'`);
      }
      if (actual.entries.length !== expected.entries.length) {
        throw new Error(
          `${path}: expected ${String(expected.entries.length)} entr(y/ies), got ${String(actual.entries.length)}`,
        );
      }
      for (const [i, [expectedEntry, actualEntry]] of zipEqualLength(
        expected.entries,
        actual.entries,
      ).entries()) {
        assertReaderValueMatches(expectedEntry.key, actualEntry.key, `${path}[${String(i)}].key`);
        assertReaderValueMatches(
          expectedEntry.value,
          actualEntry.value,
          `${path}[${String(i)}].value`,
        );
      }
      return;
    }
  }
}
