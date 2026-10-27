/**
 * IDNA2008's code-point rules (RFC 5890-5892) over the checked-in tables: RFC 5892's derived
 * property, the contextual rules of its Appendix A, and the three general-category questions the
 * U-label checks of RFC 5891 §4.2.3 ask. Nothing here consults the host; a name is part of a
 * document's identity (§2.2.1), so its validity may not depend on which runtime reads it.
 *
 * **The property is built so a valid code point stays valid.** The derivation reads properties
 * Unicode keeps stable -- General_Category for letters and digits, normalization, case folding --
 * and RFC 5892 §2.7's BackwardCompatible category exists to pin a value should one move. A newly
 * assigned code point can become PVALID in a later version; one that is PVALID does not stop
 * being so, which is what lets a content-addressed name rest on it.
 */

import { toNfc } from './nfc.js';
import {
  CLASS_COMBINING_MARK,
  CLASS_DECIMAL_DIGIT,
  CLASS_UPPERCASE,
  IDNA_CONTEXTJ,
  IDNA_CONTEXTO,
  IDNA_PVALID,
  IDNA_UNASSIGNED,
  idnaPropertyCode,
  nameClassOf,
} from './idna-tables.js';
import {
  isEnclosingMark,
  isExplicitlyNotTransparent,
  isExplicitlyTransparent,
  isFormatControl,
  isLeftJoining,
  isNonSpacingMark,
  isRightJoining,
  isVirama,
  SCRIPT_GREEK,
  SCRIPT_HAN,
  SCRIPT_HIRAGANA,
  SCRIPT_KATAKANA,
  scriptNamed,
  scriptOf,
} from './uts39.js';

export { IDNA_UNICODE_VERSION } from './idna-tables.js';

/** RFC 5892 §1.1's five values of the derived property. */
export type IdnaProperty = 'PVALID' | 'CONTEXTJ' | 'CONTEXTO' | 'DISALLOWED' | 'UNASSIGNED';

/** RFC 5892 §3's derived property of `codePoint`: the first category it falls in decides. */
export function idnaProperty(codePoint: number): IdnaProperty {
  switch (idnaPropertyCode(codePoint)) {
    case IDNA_PVALID:
      return 'PVALID';
    case IDNA_CONTEXTJ:
      return 'CONTEXTJ';
    case IDNA_CONTEXTO:
      return 'CONTEXTO';
    case IDNA_UNASSIGNED:
      return 'UNASSIGNED';
    default:
      return 'DISALLOWED';
  }
}

/** Whether `codePoint` is a combining mark: general category `Mn`, `Mc` or `Me`. */
export function isCombiningMark(codePoint: number): boolean {
  return nameClassOf(codePoint) === CLASS_COMBINING_MARK;
}

/** Whether `codePoint` is a decimal digit: general category `Nd`. */
export function isDecimalDigit(codePoint: number): boolean {
  return nameClassOf(codePoint) === CLASS_DECIMAL_DIGIT;
}

/**
 * Whether `codePoint` has the `Uppercase` property. Used to word a refusal: IDNA2008 has no
 * uppercase U-label, and the fix to name is its lowercase.
 */
export function isUppercase(codePoint: number): boolean {
  return nameClassOf(codePoint) === CLASS_UPPERCASE;
}

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const MIDDLE_DOT = 0x00b7;
const GREEK_LOWER_NUMERAL_SIGN = 0x0375;
const HEBREW_GERESH = 0x05f3;
const HEBREW_GERSHAYIM = 0x05f4;
const KATAKANA_MIDDLE_DOT = 0x30fb;
const SCRIPT_HEBREW = scriptNamed('Hebrew');

/** The code point ending at UTF-16 index `index`; `index` is above zero. */
function codePointBefore(text: string, index: number): number {
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return low;
}

function charCount(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

/**
 * `Joining_Type=Transparent`: `ArabicShaping.txt`'s default rule (non-spacing mark, enclosing
 * mark, or format) with its explicit exceptions applied -- an explicit value always wins over the
 * `General_Category` default.
 */
function isTransparent(codePoint: number): boolean {
  if (isExplicitlyTransparent(codePoint)) return true;
  if (isExplicitlyNotTransparent(codePoint)) return false;
  return isNonSpacingMark(codePoint) || isEnclosingMark(codePoint) || isFormatControl(codePoint);
}

/** Appendix A.1 and A.2's first rule: the code point before is a virama. */
function afterVirama(label: string, index: number): boolean {
  return index > 0 && isVirama(codePointBefore(label, index));
}

/**
 * Appendix A.1's second rule: ZWNJ between a left-joining and a right-joining character, with
 * transparent ones between -- `(Joining_Type:{L,D})(Joining_Type:T)* ZWNJ (Joining_Type:T)*
 * (Joining_Type:{R,D})`.
 */
function joinsAcross(label: string, index: number): boolean {
  let i = index;
  let before: number;
  do {
    if (i === 0) return false;
    before = codePointBefore(label, i);
    i -= charCount(before);
  } while (isTransparent(before));
  if (!isLeftJoining(before)) return false;
  let j = index + 1;
  while (j < label.length) {
    const after = label.codePointAt(j) ?? 0;
    if (!isTransparent(after)) return isRightJoining(after);
    j += charCount(after);
  }
  return false;
}

/** Appendix A.7: the label holds a Hiragana, Katakana or Han character. */
function hasKanaOrHan(label: string): boolean {
  for (const character of label) {
    const script = scriptOf(character.codePointAt(0) ?? 0);
    if (script === SCRIPT_HIRAGANA || script === SCRIPT_KATAKANA || script === SCRIPT_HAN) {
      return true;
    }
  }
  return false;
}

function hasAny(label: string, from: number, to: number): boolean {
  for (let i = 0; i < label.length; i++) {
    const unit = label.charCodeAt(i);
    if (unit >= from && unit <= to) return true;
  }
  return false;
}

/**
 * RFC 5892 Appendix A: whether the CONTEXTJ or CONTEXTO code point at UTF-16 index `index` of
 * `label` stands where its rule permits it. `label` is one label, in NFC. A code point with no
 * rule -- one whose property is neither contextual value -- is never permitted by this.
 */
export function idnaContextual(label: string, index: number): boolean {
  const codePoint = label.codePointAt(index) ?? 0;
  switch (codePoint) {
    case ZWNJ:
      return afterVirama(label, index) || joinsAcross(label, index);
    case ZWJ:
      return afterVirama(label, index);
    case MIDDLE_DOT:
      return (
        index > 0 &&
        label.charCodeAt(index - 1) === 0x6c &&
        index + 1 < label.length &&
        label.charCodeAt(index + 1) === 0x6c
      );
    case GREEK_LOWER_NUMERAL_SIGN:
      return (
        index + 1 < label.length && scriptOf(label.codePointAt(index + 1) ?? 0) === SCRIPT_GREEK
      );
    case HEBREW_GERESH:
    case HEBREW_GERSHAYIM:
      return (
        index > 0 &&
        SCRIPT_HEBREW !== undefined &&
        scriptOf(codePointBefore(label, index)) === SCRIPT_HEBREW
      );
    case KATAKANA_MIDDLE_DOT:
      return hasKanaOrHan(label);
    default:
      if (codePoint >= 0x0660 && codePoint <= 0x0669) return !hasAny(label, 0x06f0, 0x06f9);
      if (codePoint >= 0x06f0 && codePoint <= 0x06f9) return !hasAny(label, 0x0660, 0x0669);
      return false;
  }
}

/**
 * RFC 5891 §5.4's checks over one non-ASCII, ASCII-case-folded label that would be a U-label: why
 * it is not one, or `undefined`. Nothing is mapped -- text that is not already in its one valid
 * form is refused, never rewritten into it.
 */
export function uLabelProblem(label: string): string | undefined {
  if (toNfc(label) !== label) return 'is not in Normalization Form C';
  if (label.length >= 4 && label[2] === '-' && label[3] === '-') {
    return 'has hyphens in its third and fourth places (RFC 5891 §4.2.3.1)';
  }
  if (label.startsWith('-') || label.endsWith('-')) return 'begins or ends with a hyphen';
  if (isCombiningMark(label.codePointAt(0) ?? 0)) {
    return 'begins with a combining mark (RFC 5891 §4.2.3.2)';
  }
  for (let i = 0; i < label.length;) {
    const codePoint = label.codePointAt(i) ?? 0;
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    switch (idnaProperty(codePoint)) {
      case 'PVALID':
        break;
      case 'CONTEXTJ':
      case 'CONTEXTO':
        if (!idnaContextual(label, i)) {
          return `holds U+${hex} where RFC 5892's contextual rule for it does not hold`;
        }
        break;
      case 'UNASSIGNED':
        return `holds U+${hex}, which is not assigned in this processor's Unicode version`;
      case 'DISALLOWED':
        return isUppercase(codePoint)
          ? `holds the uppercase U+${hex}, and a host name has no uppercase beyond ASCII`
          : `holds U+${hex}, which IDNA2008 does not permit in a host name (RFC 5892)`;
    }
    i += charCount(codePoint);
  }
  return undefined;
}
