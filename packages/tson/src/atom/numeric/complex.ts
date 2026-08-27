/**
 * Parses and validates against meta-kernel's `complex_type` constructor (§5.6's `complex` atom)
 * -- the port of `atom/ComplexParser.java`/`atom/Complex.java`.
 *
 * `complex_type`'s `component` field selects which numeric family backs the real/imaginary parts
 * (`schema/meta/atoms-numeric.ts`'s `ComplexComponent`); this, like the reference implementation,
 * implements only the default `NUMBER` component (exact {@link TsonDecimal}) -- meta.tn's own
 * built-in `!complex` instance never refines `component`, and a schema narrowing it to
 * `INTEGER`/`RATIONAL`/`FLOAT32`/`FLOAT64` is separate, not-yet-relevant work (`Complex.java`'s
 * own Javadoc makes the same deferral). `complex_type` has no other constraint fields -- meta.tn
 * marks `complex` `@ordered:NONE`, so there is nothing to bound -- which is why, unlike every
 * other factory in this directory, this one takes no `constraints` parameter at all.
 *
 * Accepts `complex`/`float`/`integer` forms (§7.6, §5.6) -- not `based-integer`, not hex-float,
 * not the special values. A bare `integer`/`float` token (no `imag-unit`) is a real-only complex
 * number, imaginary part zero.
 */

import { TsonAtomParseError, TsonInternalError } from '../../core/errors.js';
import { toExactDecimal, toExactInteger } from '../../base/numberNarrowing.js';
import { tryParseComplex, tryParseNumber, type Sign } from '../../base/numberGrammar.js';
import type { Complex, TsonDecimal } from '../../value/types.js';
import type { AtomToken, AtomType } from '../contract.js';
import { writeDecimal } from './decimalMath.js';

const ZERO: TsonDecimal = { unscaled: 0n, exponent: 0 };

function applySign(sign: Sign | undefined, magnitude: TsonDecimal): TsonDecimal {
  return sign === 'minus'
    ? { unscaled: -magnitude.unscaled, exponent: magnitude.exponent }
    : magnitude;
}

/**
 * A `ComplexForm` magnitude substring is unsigned `integer`/`float` text -- re-parsed via
 * `tryParseNumber` rather than duplicating digit extraction, mirroring `ComplexParser.java`'s own
 * `reparseMagnitude`. The re-parse cannot fail: `numberScanner.ts`'s `magnitude()` production is a
 * strict subset of `number`'s own `integer`/`float` alternatives, so a string it accepted is
 * always one `tryParseNumber` accepts too -- a mismatch here is this module's own bug, not bad
 * input, hence {@link TsonInternalError} rather than a parse error.
 */
function magnitudeToDecimal(magnitude: string): TsonDecimal {
  const form = tryParseNumber(magnitude);
  if (form === undefined || (form.kind !== 'integer' && form.kind !== 'float')) {
    throw new TsonInternalError(`complex magnitude substring failed to re-parse: '${magnitude}'`);
  }
  return form.kind === 'integer'
    ? { unscaled: toExactInteger(form), exponent: 0 }
    : toExactDecimal(form);
}

/**
 * `[sign] magnitude sign magnitude i` -- the middle sign is always written explicitly (§7.6
 * requires it on read too), the real part's own leading sign only when negative
 * ({@link writeDecimal} already supplies it). Always plain decimal notation, never scientific --
 * see `decimalMath.ts`'s own `writeDecimal` doc for why that is enough for a correct round trip.
 */
function writeComplex(value: Complex): string {
  const sign = value.imaginary.unscaled < 0n ? '-' : '+';
  const absImaginary: TsonDecimal = {
    unscaled: value.imaginary.unscaled < 0n ? -value.imaginary.unscaled : value.imaginary.unscaled,
    exponent: value.imaginary.exponent,
  };
  return `${writeDecimal(value.real)}${sign}${writeDecimal(absImaginary)}i`;
}

/** Builds the `AtomType` for `complex => !complex_type {}`, §5.6's `!complex`. See this module's own TSDoc for `component`'s deferral. */
export function createComplexParser(typeRef: string): AtomType<Complex> {
  function read(token: AtomToken): Complex {
    const text = token.text;
    const complexForm = tryParseComplex(text);
    if (complexForm !== undefined) {
      const real =
        complexForm.realMagnitude !== undefined
          ? applySign(complexForm.realSign, magnitudeToDecimal(complexForm.realMagnitude))
          : ZERO;
      const imaginary = applySign(
        complexForm.imaginarySign,
        magnitudeToDecimal(complexForm.imaginaryMagnitude),
      );
      return { real, imaginary };
    }

    const form = tryParseNumber(text);
    if (form === undefined || (form.kind !== 'integer' && form.kind !== 'float')) {
      throw new TsonAtomParseError(
        typeRef,
        `'${text}' is not a valid complex number -- only complex, integer, and float forms are accepted (§5.6)`,
        'a complex, integer or float form',
      );
    }
    const real =
      form.kind === 'integer'
        ? { unscaled: toExactInteger(form), exponent: 0 }
        : toExactDecimal(form);
    return { real, imaginary: ZERO };
  }

  return { read, write: writeComplex };
}
