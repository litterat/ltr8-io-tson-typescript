/**
 * Parses and validates against meta-kernel's `integer_type` constructor (§5.6's integer atoms:
 * the fixed-width `int8`..`int256`/`uint8`..`uint256` ladder and the four sign-bounded,
 * unbounded-precision refinements) -- the port of `atom/IntegerParser.java`.
 *
 * Accepts only the `integer`/`based-integer` grammar forms (§7.6) -- §5.6's table is explicit
 * that the integer atoms don't accept `float`/`special-value` tokens, unlike `float32`/`float64`.
 * Parsing and validation are kept as two visibly distinct steps because §5.2 requires the
 * distinction to survive to error reporting: a token the grammar rejects is a
 * {@link TsonAtomParseError}, a parsed value outside the atom's range is a
 * {@link TsonAtomValidationError}.
 *
 * **Host representation, per `value/types.ts`'s `Int8`..`Int256` aliases and this package's own
 * hard constraint:** a fixed width of 32 bits or less (`int8`/`int16`/`int32`, their unsigned
 * counterparts) narrows to a plain `number` -- every such range sits well inside `number`'s exact
 * ±2^53 integer range. A width of 64 bits or more, and every unbounded (no `size` at all)
 * instance -- the kernel's own unconstrained `integer`, and the four sign-bounded refinements
 * (`positive_integer`, ...) -- stays `bigint`: `int64` alone already exceeds 2^53, so narrowing it
 * to `number` would silently lose precision with no visible failure. This is a deliberate,
 * width-driven choice rather than `IntegerParser.java`'s own "narrowest primitive that fits"
 * table (which additionally has to route an unsigned 8-bit range to `Short` because signed `Byte`
 * cannot hold it) -- JS's single 2^53-exact `number` type makes that per-width primitive table
 * unnecessary here.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { toExactInteger } from '../../base/numberNarrowing.js';
import { tryParseNumber } from '../../base/numberGrammar.js';
import type { IntegerSize, IntegerType } from '../../schema/meta/atoms-numeric.js';
import type { AtomToken, AtomType } from '../contract.js';

/** The host representation an {@link IntegerType} instance's own `size` selects. See this module's own TSDoc. */
export type IntegerHost = number | bigint;

/** `{ min, max }` for a fixed-width, two's-complement `size` -- exact at any width, via `bigint` shifts. */
function integerBounds(size: IntegerSize): { min: bigint; max: bigint } {
  if (size.signed) {
    const half = 1n << (size.bits - 1n);
    return { min: -half, max: half - 1n };
  }
  return { min: 0n, max: (1n << size.bits) - 1n };
}

/**
 * Builds the `AtomType` for one fully-parameterised `integer_type` instance -- e.g. `int32`'s
 * entry in a built-in vocabulary table is `createIntegerParser('int32', { kind: 'integer_type',
 * size: { bits: 32n, signed: true } })`, mirroring `core.tn`'s own `int32 => !integer ^ { size: {
 * bits: 32 signed: true } } }`.
 *
 * `typeRef` is required explicitly, unlike `FloatParser.java`/`BinaryParser.java`'s own
 * `typeName()` (derived from `format`/`encoding`): `integer_type` (unlike `float_type`/`binary`)
 * carries no field of its own that names an instance -- a schema can refine it under any local
 * type name, not only the built-in ladder -- so the caller constructing an instance is the only
 * party that knows which name it is.
 */
export function createIntegerParser(
  typeRef: string,
  constraints: IntegerType,
): AtomType<IntegerHost> {
  const host: 'number' | 'bigint' =
    constraints.size !== undefined && constraints.size.bits <= 32n ? 'number' : 'bigint';

  function readExact(token: AtomToken): bigint {
    const text = token.text;
    const form = tryParseNumber(text);
    if (form === undefined || (form.kind !== 'integer' && form.kind !== 'based-integer')) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid integer -- only integer and based-integer forms are accepted (§5.6)`,
        'an integer or based-integer form',
      );
    }
    const value = toExactInteger(form);
    validate(value, text);
    return value;
  }

  function validate(value: bigint, text: string): void {
    const { size, min, exclusiveMin, max, exclusiveMax, multipleOf } = constraints;
    if (size !== undefined) {
      const bounds = integerBounds(size);
      if (value < bounds.min || value > bounds.max) {
        const min2 = String(bounds.min);
        const max2 = String(bounds.max);
        throw new TsonAtomValidationError(
          typeRef,
          `'${text}' is out of range for a ${size.signed ? 'signed' : 'unsigned'} ${String(size.bits)}-bit integer [${min2}, ${max2}]`,
          `>= ${min2} and <= ${max2}`,
        );
      }
    }
    if (min !== undefined && value < min) {
      const bound = String(min);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is less than the minimum ${bound}`,
        `>= ${bound}`,
      );
    }
    if (exclusiveMin !== undefined && value <= exclusiveMin) {
      const bound = String(exclusiveMin);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly greater than ${bound}`,
        `> ${bound}`,
      );
    }
    if (max !== undefined && value > max) {
      const bound = String(max);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is greater than the maximum ${bound}`,
        `<= ${bound}`,
      );
    }
    if (exclusiveMax !== undefined && value >= exclusiveMax) {
      const bound = String(exclusiveMax);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' must be strictly less than ${bound}`,
        `< ${bound}`,
      );
    }
    if (multipleOf !== undefined && value % multipleOf !== 0n) {
      const of = String(multipleOf);
      throw new TsonAtomValidationError(
        typeRef,
        `'${text}' is not a multiple of ${of}`,
        `a multiple of ${of}`,
      );
    }
  }

  return {
    read(token) {
      const value = readExact(token);
      return host === 'number' ? Number(value) : value;
    },
    /** Plain decimal digits -- no width-dependent formatting quirk the way {@link createFloatParser} has. */
    write(value) {
      return value.toString();
    },
  };
}
