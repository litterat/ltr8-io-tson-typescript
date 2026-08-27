/**
 * A cursor over a token's text with one function per production of §7.6's numeric ABNF, plus the
 * raw shapes those productions build ({@link NumberForm}, {@link RationalForm}, {@link
 * ComplexForm}). `numberGrammar.ts` is the public door onto this module; every function here
 * mirrors exactly one grammar rule, hand-written, and none of it uses `RegExp`.
 *
 * **Why hand-written rather than a regex.** A grammar stated as a host regex pattern is stated in
 * a dialect no other language shares — an unspecified host dependency in the one artifact that
 * should carry the spec's own algorithm. TSON pins I-Regexp for a schema's `pattern` facets and
 * says nothing about how a number is recognized, so a regex here would be this implementation's
 * private choice leaking into what other ports copy. Each function below reads as its ABNF rule
 * and ports as one.
 *
 * **The cursor is single-pass with explicit backtracking** (`mark`/`reset`, both private to this
 * module — nothing outside it needs to save a position) at the two places the grammar is
 * genuinely optional: a float's fraction and its exponent. Everywhere else the grammar is decided
 * by the character at the cursor, so no lookahead is needed — a digit run is maximal-munch and
 * nothing that may follow one is a digit.
 *
 * **Addressing is by UTF-16 code unit (`charCodeAt`), not code point**, and that is deliberately
 * safe here even though the rest of this port is code-point addressed (§7.1): every character
 * §7.6's grammar admits — digits, `+`/`-`, `.`, the radix/exponent/imaginary letters, `_` — is
 * ASCII, so a supplementary-plane code point can only ever appear as *not* one of them, which
 * every comparison below already treats as "stop matching". There is nothing here that indexing
 * by code unit could get wrong.
 */

/** `sign = "+" / "-"` (§7.6). */
export type Sign = 'plus' | 'minus';

/** `exponent = ( "e" / "E" ) [sign] digits` (§7.6). Never itself a {@link NumberForm}. */
export interface ExponentPart {
  readonly sign?: Sign;
  readonly digits: string;
}

/** Which of `.nan`/`.inf`/`.infinity` a {@link SpecialValueForm} names. */
export type SpecialKind = 'nan' | 'infinity';

/** Which of the three `based-integer` prefixes (`0x`/`0o`/`0b`) a {@link BasedIntegerForm} names. */
export type Radix = 'hex' | 'octal' | 'binary';

/**
 * `.nan`, `.inf`, `.infinity` (§4.3, §7.6). `sign` applies only to infinity —
 * `special-value = [sign] infinity / ".nan"`, ABNF concatenation binding tighter than
 * alternation, so `.nan` is never signed: `+.nan`/`-.nan` don't match this production at all.
 */
export interface SpecialValueForm {
  readonly kind: 'special-value';
  readonly sign?: Sign;
  readonly special: SpecialKind;
}

/** A signed decimal integer. `digits` has no leading zeros except the single digit `"0"`. */
export interface IntegerForm {
  readonly kind: 'integer';
  readonly sign?: Sign;
  readonly digits: string;
}

/** A `0x`/`0o`/`0b`-prefixed integer. The prefix itself is lowercase-only by grammar. */
export interface BasedIntegerForm {
  readonly kind: 'based-integer';
  readonly sign?: Sign;
  readonly radix: Radix;
  readonly digits: string;
}

/**
 * A decimal float. Exactly one of {@link integerPart}/{@link fractionDigits} may be absent
 * (never both) per the grammar's three alternatives: `decimal-natural "." digits` has both;
 * `"." digits` has no integer part; `decimal-natural exponent` (mandatory exponent, no dot) has
 * no fraction.
 */
export interface FloatForm {
  readonly kind: 'float';
  readonly sign?: Sign;
  readonly integerPart?: string;
  readonly fractionDigits?: string;
  readonly exponent?: ExponentPart;
}

/**
 * The recognized shape of a token matching the `number` production (§4.3, §7.6): which of the
 * four disjoint grammar alternatives it is, and that alternative's own components, captured as
 * raw substrings straight from the source text.
 *
 * Deliberately not narrowed to a host numeric type here — this is identification, not binding.
 * Digit groups are exactly as written (underscore separators included, based-integer digits not
 * yet interpreted in their radix). `numberNarrowing.ts` performs that later, separate step.
 */
export type NumberForm = SpecialValueForm | IntegerForm | BasedIntegerForm | FloatForm;

/**
 * `rational = [sign] decimal-natural "/" denominator` (§7.6) — an extended form, recognised only
 * through the built-in vocabulary's `rational` atom, never part of {@link NumberForm}. Unlike
 * hex-float there is no host parser to lean on for "numerator/denominator" text, so the two
 * halves survive here as separate raw digit strings for a later step to convert to an exact
 * `bigint` pair. `denominator`'s grammar (`nonzero-digit *( ["_"] DIGIT )`) never permits a
 * leading zero, unlike the numerator's `decimal-natural` (which allows the single digit `"0"`).
 */
export interface RationalForm {
  readonly sign?: Sign;
  readonly numerator: string;
  readonly denominator: string;
}

/**
 * `complex = [sign] magnitude sign magnitude imag-unit / [sign] magnitude imag-unit` (§7.6) — an
 * extended form, recognised only through the built-in vocabulary's `complex` atom.
 * `realMagnitude` is absent for the second (imaginary-only) alternative, e.g. `4i` or `-2.5j`,
 * where the real part is implicitly zero; when present, it's always paired with the first
 * alternative's mandatory (never optional, unlike every other sign in this grammar) separator
 * sign before the imaginary part — `3 4i` (space, no explicit sign between the parts) does not
 * match the grammar at all. `magnitude` substrings are raw and unsigned (§7.6 gives `magnitude`
 * no sign of its own) — each one is exactly what {@link NumberForm} already recognizes as an
 * `integer` or `float` shape, decomposed further by re-parsing rather than by this shape
 * extracting structure itself.
 */
export interface ComplexForm {
  readonly realSign?: Sign;
  readonly realMagnitude?: string;
  readonly imaginarySign?: Sign;
  readonly imaginaryMagnitude: string;
}

/**
 * The cursor operations {@link "./numberGrammar.js"} drives. Everything else in this module
 * (digit runs, signs, exponents, the based-integer prefix, the two backtracking points) is
 * private to the scanner's own construction — nothing outside this file needs to see it.
 */
export interface NumberScanner {
  /** True when the cursor has consumed the whole text. */
  atEnd(): boolean;
  /** `number = special-value / based-integer / float / integer` (§7.6). */
  number(): NumberForm | undefined;
  /** `hex-float` — a shape check with nothing to extract; a caller reads the text itself. */
  hexFloat(): boolean;
  /** `rational = [sign] decimal-natural "/" denominator` (§7.6). */
  rational(): RationalForm | undefined;
  /**
   * `complex = [sign] magnitude sign magnitude imag-unit / [sign] magnitude imag-unit` (§7.6).
   * Unlike the other three entry points, this one already enforces its own full-text match —
   * both alternatives fail unless the cursor lands on {@link atEnd} — since a complex has no
   * separate opt-in door the way `hexFloat`/`rational`/`number` do.
   */
  complex(): ComplexForm | undefined;
}

/** Digit classes the grammar names, addressed by their radix. */
function isDigitCode(code: number, radix: 2 | 8 | 10 | 16): boolean {
  switch (radix) {
    case 10:
      return code >= 0x30 && code <= 0x39;
    case 16:
      return (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x61 && code <= 0x66) ||
        (code >= 0x41 && code <= 0x46)
      );
    case 8:
      return code >= 0x30 && code <= 0x37;
    case 2:
      return code === 0x30 || code === 0x31;
  }
}

/** Creates a fresh, single-use, single-pass scanner over `text`. */
export function createNumberScanner(text: string): NumberScanner {
  let at = 0;

  function atEnd(): boolean {
    return at >= text.length;
  }

  function mark(): number {
    return at;
  }

  function reset(mark: number): void {
    at = mark;
  }

  /** Consumes the single ASCII character `ch` if it is at the cursor. */
  function take(ch: string): boolean {
    if (at < text.length && text.charCodeAt(at) === ch.charCodeAt(0)) {
      at += 1;
      return true;
    }
    return false;
  }

  /** Consumes `word` if the cursor is on it. */
  function takeWord(word: string): boolean {
    if (text.startsWith(word, at)) {
      at += word.length;
      return true;
    }
    return false;
  }

  function peekIs(ch: string): boolean {
    return at < text.length && text.charCodeAt(at) === ch.charCodeAt(0);
  }

  /**
   * `digits = digit *( ["_"] digit )` in the given radix — an underscore is a separator
   * *between* digits, so it is consumed only together with the digit that must follow it.
   * `undefined` when the cursor is not on a digit; the cursor does not move in that case.
   */
  function digits(radix: 2 | 8 | 10 | 16): string | undefined {
    const start = at;
    if (atEnd() || !isDigitCode(text.charCodeAt(at), radix)) {
      return undefined;
    }
    at += 1;
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (isDigitCode(code, radix)) {
        at += 1;
      } else if (
        code === 0x5f /* _ */ &&
        at + 1 < text.length &&
        isDigitCode(text.charCodeAt(at + 1), radix)
      ) {
        at += 2;
      } else {
        break;
      }
    }
    return text.slice(start, at);
  }

  /** `decimal-natural = "0" / ( nonzero-digit *( ["_"] DIGIT ) )` — no leading zeros. */
  function decimalNatural(): string | undefined {
    if (atEnd()) {
      return undefined;
    }
    const code = text.charCodeAt(at);
    if (code === 0x30 /* 0 */) {
      at += 1;
      return '0';
    }
    if (code < 0x31 || code > 0x39) {
      return undefined;
    }
    return digits(10);
  }

  /** `denominator = nonzero-digit *( ["_"] DIGIT )` — a natural, but never `0` and never zero-led. */
  function nonZeroNatural(): string | undefined {
    if (atEnd()) {
      return undefined;
    }
    const code = text.charCodeAt(at);
    if (code < 0x31 || code > 0x39) {
      return undefined;
    }
    return digits(10);
  }

  /** `sign = "+" / "-"`, optional at every position the grammar admits one. */
  function sign(): Sign | undefined {
    if (take('+')) {
      return 'plus';
    }
    if (take('-')) {
      return 'minus';
    }
    return undefined;
  }

  /**
   * `exponent = ("e" / "E") [sign] digits` — `undefined`, with the cursor put back, when what
   * follows the `e` is not one. The grammar's optional-group backtracking, made explicit: `3e` is
   * an integer followed by junk, not a float with a broken exponent, and `4ei` in a complex is
   * magnitude `4` followed by the letter that is not there.
   */
  function exponent(): ExponentPart | undefined {
    const start = mark();
    if (!take('e') && !take('E')) {
      return undefined;
    }
    const expSign = sign();
    const expDigits = digits(10);
    if (expDigits === undefined) {
      reset(start);
      return undefined;
    }
    return expSign === undefined ? { digits: expDigits } : { sign: expSign, digits: expDigits };
  }

  /** The radix a consumed `0x`/`0o`/`0b` prefix names, or `0` for no prefix. Lowercase only, by grammar. */
  function radixPrefix(): 0 | 2 | 8 | 16 {
    if (takeWord('0x')) {
      return 16;
    }
    if (takeWord('0o')) {
      return 8;
    }
    if (takeWord('0b')) {
      return 2;
    }
    return 0;
  }

  /**
   * `based-integer = [sign] ( "0x" hex-digits / "0o" octal-digits / "0b" binary-digits )`.
   *
   * A consumed prefix is put back when its digits do not follow, so the decimal alternative sees
   * the `0` it starts with: without that, `0o9` would scan as the integer `9` with the prefix
   * silently eaten, turning a token that is not a number at all into one.
   */
  function basedInteger(leadingSign: Sign | undefined): BasedIntegerForm | undefined {
    const start = mark();
    const radix = radixPrefix();
    if (radix === 0) {
      return undefined;
    }
    const radixDigits = digits(radix);
    if (radixDigits === undefined) {
      reset(start);
      return undefined;
    }
    const named: Radix = radix === 16 ? 'hex' : radix === 8 ? 'octal' : 'binary';
    return leadingSign === undefined
      ? { kind: 'based-integer', radix: named, digits: radixDigits }
      : { kind: 'based-integer', sign: leadingSign, radix: named, digits: radixDigits };
  }

  function makeFloatForm(
    floatSign: Sign | undefined,
    integerPart: string | undefined,
    fractionDigits: string | undefined,
    exponentPart: ExponentPart | undefined,
  ): FloatForm {
    const form: {
      kind: 'float';
      sign?: Sign;
      integerPart?: string;
      fractionDigits?: string;
      exponent?: ExponentPart;
    } = { kind: 'float' };
    if (floatSign !== undefined) form.sign = floatSign;
    if (integerPart !== undefined) form.integerPart = integerPart;
    if (fractionDigits !== undefined) form.fractionDigits = fractionDigits;
    if (exponentPart !== undefined) form.exponent = exponentPart;
    return form;
  }

  /**
   * What a leading `.` can open: `.nan`, `.inf`, `.infinity`, or `"." digits [exponent]`.
   * `.infinity` is tried before `.inf` — the ABNF's alternation is unordered and a regex
   * backtracks into the longer one, so a scanner has to prefer it explicitly. `.nan` is never
   * signed: `special-value = [sign] infinity / ".nan"`, concatenation binding tighter than
   * alternation, so `+.nan` is not a number at all — this function is only reached once `number`
   * has already consumed any leading sign, so a signed call here means the caller saw one.
   */
  function dotLeading(leadingSign: Sign | undefined): NumberForm | undefined {
    if (leadingSign === undefined && takeWord('.nan')) {
      return { kind: 'special-value', special: 'nan' };
    }
    if (takeWord('.infinity') || takeWord('.inf')) {
      return leadingSign === undefined
        ? { kind: 'special-value', special: 'infinity' }
        : { kind: 'special-value', sign: leadingSign, special: 'infinity' };
    }
    if (!take('.')) {
      return undefined;
    }
    const fraction = digits(10);
    if (fraction === undefined) {
      return undefined;
    }
    return makeFloatForm(leadingSign, undefined, fraction, exponent());
  }

  /**
   * One whole `number`, or `undefined`. The alternatives are disjoint on the character after the
   * optional sign, so this is a dispatch rather than a sequence of attempts: `.` opens a special
   * value or a fraction-only float, `0x`/`0o`/`0b` a based integer, and a decimal digit an
   * integer or a float depending on what follows it.
   */
  function number(): NumberForm | undefined {
    const leadingSign = sign();

    if (peekIs('.')) {
      return dotLeading(leadingSign);
    }
    const based = basedInteger(leadingSign);
    if (based !== undefined) {
      return based;
    }

    const integerPart = decimalNatural();
    if (integerPart === undefined) {
      return undefined;
    }
    if (take('.')) {
      const fraction = digits(10);
      if (fraction === undefined) {
        return undefined;
      }
      return makeFloatForm(leadingSign, integerPart, fraction, exponent());
    }
    const trailingExponent = exponent();
    if (trailingExponent !== undefined) {
      return makeFloatForm(leadingSign, integerPart, undefined, trailingExponent);
    }
    return leadingSign === undefined
      ? { kind: 'integer', digits: integerPart }
      : { kind: 'integer', sign: leadingSign, digits: integerPart };
  }

  /** `hex-float`, a shape check with nothing to extract — a caller reads the text itself. */
  function hexFloat(): boolean {
    sign();
    if (radixPrefix() !== 16) {
      return false;
    }
    if (take('.')) {
      if (digits(16) === undefined) {
        return false;
      }
    } else {
      if (digits(16) === undefined) {
        return false;
      }
      if (take('.') && digits(16) === undefined) {
        return false;
      }
    }
    if (!take('p') && !take('P')) {
      return false;
    }
    sign();
    return digits(10) !== undefined;
  }

  /** `rational = [sign] decimal-natural "/" denominator`. */
  function rational(): RationalForm | undefined {
    const rationalSign = sign();
    const numerator = decimalNatural();
    if (numerator === undefined || !take('/')) {
      return undefined;
    }
    const denominator = nonZeroNatural();
    if (denominator === undefined) {
      return undefined;
    }
    return rationalSign === undefined
      ? { numerator, denominator }
      : { sign: rationalSign, numerator, denominator };
  }

  /**
   * `magnitude = decimal-natural [ "." digits ] [ exponent ] / "." digits [ exponent ]` —
   * unsigned, returned as the raw substring, since {@link complex} decomposes a part by running
   * {@link number} over it rather than duplicating digit extraction.
   */
  function magnitude(): string | undefined {
    const start = at;
    if (take('.')) {
      if (digits(10) === undefined) {
        reset(start);
        return undefined;
      }
      exponent();
      return text.slice(start, at);
    }
    if (decimalNatural() === undefined) {
      reset(start);
      return undefined;
    }
    const beforeFraction = mark();
    if (take('.') && digits(10) === undefined) {
      reset(beforeFraction);
    }
    exponent();
    return text.slice(start, at);
  }

  function imaginaryUnit(): boolean {
    return take('i') || take('j');
  }

  function makeComplexForm(
    realSign: Sign | undefined,
    realMagnitude: string | undefined,
    imaginarySign: Sign | undefined,
    imaginaryMagnitude: string,
  ): ComplexForm {
    const form: {
      realSign?: Sign;
      realMagnitude?: string;
      imaginarySign?: Sign;
      imaginaryMagnitude: string;
    } = { imaginaryMagnitude };
    if (realSign !== undefined) form.realSign = realSign;
    if (realMagnitude !== undefined) form.realMagnitude = realMagnitude;
    if (imaginarySign !== undefined) form.imaginarySign = imaginarySign;
    return form;
  }

  function complexTwoPart(): ComplexForm | undefined {
    const realSign = sign();
    const real = magnitude();
    if (real === undefined) {
      return undefined;
    }
    const imaginarySign = sign();
    if (imaginarySign === undefined) {
      // The middle sign is mandatory, unlike every other sign in this grammar.
      return undefined;
    }
    const imaginary = magnitude();
    if (imaginary === undefined || !imaginaryUnit() || !atEnd()) {
      return undefined;
    }
    return makeComplexForm(realSign, real, imaginarySign, imaginary);
  }

  /**
   * The two-part form first, since a purely imaginary `1e+5i` is only the second form once the
   * first has failed on the sign its magnitude swallowed.
   */
  function complex(): ComplexForm | undefined {
    const start = mark();
    const twoPart = complexTwoPart();
    if (twoPart !== undefined) {
      return twoPart;
    }
    reset(start);

    const leadingSign = sign();
    const magn = magnitude();
    if (magn === undefined || !imaginaryUnit() || !atEnd()) {
      return undefined;
    }
    return makeComplexForm(undefined, undefined, leadingSign, magn);
  }

  return { atEnd, number, hexFloat, rational, complex };
}
