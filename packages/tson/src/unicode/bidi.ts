/**
 * RFC 5893's Bidi rule for IDNA2008: the six conditions a label of a domain name containing
 * right-to-left text must meet, so that the name displays in one order however the labels around
 * it run. The classes are Unicode's `Bidi_Class`, read from the checked-in `bidi-tables.ts` and
 * never from the host.
 *
 * The rule applies to **every** label of a bidi domain name -- one where any label holds an R, AL
 * or AN character ({@link hasRightToLeft}) -- including its ASCII labels, so `1abc` is refused
 * beside an Arabic label, its first character being EN rather than L (RFC 5893 §1.4). A caller
 * judges the whole name first and applies {@link bidiViolation} to each label only when the name
 * is a bidi one.
 */

import {
  BIDI_AL,
  BIDI_AN,
  BIDI_BN,
  BIDI_CS,
  BIDI_EN,
  BIDI_ES,
  BIDI_ET,
  BIDI_L,
  BIDI_NSM,
  BIDI_ON,
  BIDI_R,
  bidiClassCode,
} from './bidi-tables.js';

/** Whether `label` holds a character of class R, AL or AN, which makes its name a bidi domain name. */
export function hasRightToLeft(label: string): boolean {
  for (const character of label) {
    const code = bidiClassCode(character.codePointAt(0) ?? 0);
    if (code === BIDI_R || code === BIDI_AL || code === BIDI_AN) return true;
  }
  return false;
}

/** Rule 2: R, AL, AN, EN, ES, CS, ET, ON, BN and NSM. */
function allowedRightToLeft(code: number): boolean {
  return code === BIDI_R || code === BIDI_AL || code === BIDI_AN || neutralOrNumber(code);
}

/** Rule 5: L, EN, ES, CS, ET, ON, BN and NSM. */
function allowedLeftToRight(code: number): boolean {
  return code === BIDI_L || neutralOrNumber(code);
}

function neutralOrNumber(code: number): boolean {
  return (
    code === BIDI_EN ||
    code === BIDI_ES ||
    code === BIDI_CS ||
    code === BIDI_ET ||
    code === BIDI_ON ||
    code === BIDI_BN ||
    code === BIDI_NSM
  );
}

function hex(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * RFC 5893 §2's six conditions over one non-empty label of a bidi domain name: the violation,
 * worded as what is wrong with the label, or `undefined` when it meets all six.
 */
export function bidiViolation(label: string): string | undefined {
  const characters = Array.from(label, (c) => c.codePointAt(0) ?? 0);
  const first = bidiClassCode(characters[0] ?? 0);
  let rtl: boolean;
  if (first === BIDI_R || first === BIDI_AL) {
    rtl = true;
  } else if (first === BIDI_L) {
    rtl = false;
  } else {
    return (
      'its first character is neither left-to-right nor right-to-left, which a label of a name ' +
      'holding right-to-left text must begin with (RFC 5893 §2 rule 1)'
    );
  }
  let europeanNumber = false;
  let arabicNumber = false;
  let lastNonMark = first;
  for (const codePoint of characters) {
    const code = bidiClassCode(codePoint);
    if (!(rtl ? allowedRightToLeft(code) : allowedLeftToRight(code))) {
      return (
        `U+${hex(codePoint)} has a bidi class a ${rtl ? 'right-to-left' : 'left-to-right'} ` +
        `label cannot hold (RFC 5893 §2 rule ${rtl ? '2' : '5'})`
      );
    }
    europeanNumber ||= code === BIDI_EN;
    arabicNumber ||= code === BIDI_AN;
    if (code !== BIDI_NSM) lastNonMark = code;
  }
  if (rtl) {
    if (!(
      lastNonMark === BIDI_R ||
      lastNonMark === BIDI_AL ||
      lastNonMark === BIDI_EN ||
      lastNonMark === BIDI_AN
    )) {
      return 'a right-to-left label must end in a right-to-left character or a digit (RFC 5893 §2 rule 3)';
    }
    if (europeanNumber && arabicNumber) {
      return 'a right-to-left label cannot mix European and Arabic-Indic digits (RFC 5893 §2 rule 4)';
    }
  } else if (!(lastNonMark === BIDI_L || lastNonMark === BIDI_EN)) {
    return 'a left-to-right label must end in a left-to-right character or a digit (RFC 5893 §2 rule 6)';
  }
  return undefined;
}
