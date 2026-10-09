import type { Normalization } from '../schema/meta/atoms-text.js';
import { compatibilityDecompositionOf, nfkcCasefoldOf } from './normalization-tables.js';

/**
 * The `normalization` facet's five forms ([TSON-SCHEMA] §5.5): the form a text family puts its
 * decoded value into. A token is unquoted and unescaped, then put into the form, and the result is
 * the value -- the one every facet judges and every identity compares, as `0x10` decodes to 16. A
 * written value is never refused for not being in the form.
 *
 * **No comparison goes below NFC** (§5.5, change log §8.2 item 8): two text values are one when,
 * each in its type's form, they are NFC-equal. `NONE` and `NFC` therefore share one equality and
 * differ only in the value a read returns. {@link nfcFloor} is that floor.
 *
 * The compatibility forms read checked-in data (`normalization-tables.ts`), not the host's:
 * `NFKC` is NFC of the text with every code point put through its compatibility decomposition, and
 * `NFKC_CASEFOLD` is NFC of the NFD text with every code point put through its `NFKC_Casefold`
 * value. NFC and NFD are `String.prototype.normalize`, the one place the host is consulted, which
 * is safe because canonical decompositions never change once a character is encoded (`nfc.ts`).
 * `ASCII_CASEFOLD` maps U+0041..005A to U+0061..007A and nothing else: no Unicode normalization
 * runs, so a full-width or Kelvin-sign spelling stays distinct. It is the comparison the
 * case-insensitive ASCII naming systems state -- RFC 9110 field names, RFC 3986 §3.1 schemes,
 * RFC 4343 DNS names.
 */

/** `text` in `form`, the same string when it already is. */
export function applyNormalization(form: Normalization, text: string): string {
  switch (form) {
    case 'NONE':
      return text;
    case 'NFC':
      return nfcFloor(text);
    case 'NFKC':
      return mapThenNfc(text, compatibilityDecompositionOf);
    case 'NFKC_CASEFOLD':
      return nfkcCasefold(text);
    case 'ASCII_CASEFOLD':
      return asciiLowercase(text);
  }
}

/** Whether `text` is already in `form`. */
export function holdsNormalization(form: Normalization, text: string): boolean {
  return applyNormalization(form, text) === text;
}

/**
 * `text` in NFC -- the floor no text comparison goes below. Allocation-free for text below U+0300,
 * which no canonical composition or decomposition can change.
 */
export function nfcFloor(text: string): string {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x0300) return text.normalize('NFC');
  }
  return text;
}

/**
 * `toNFKC_Casefold(NFD(text))` (The Unicode Standard D147): the text decomposed canonically, each
 * code point mapped to its `NFKC_Casefold` value, then the whole text put into NFC. Over ASCII it is lowercasing.
 */
export function nfkcCasefold(text: string): string {
  return mapThenNfc(nfdFloor(text), nfkcCasefoldOf, asciiLowercase);
}

/**
 * `text` in NFD, the step Unicode D147 puts ahead of the `NFKC_Casefold` mapping. Without it a
 * composed and a decomposed spelling that are NFC-equal can fold apart (`Á` + U+0345), and no
 * comparison may go below NFC. Allocation-free for text below U+00C0, which has no canonical
 * decomposition. Canonical decomposition is covered by the same stability policy as NFC.
 */
function nfdFloor(text: string): string {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0xc0) return text.normalize('NFD');
  }
  return text;
}

/** U+0041..005A mapped to U+0061..007A and nothing else; the same string when there is none. */
export function asciiLowercase(text: string): string {
  let i = 0;
  while (i < text.length && !isAsciiUpper(text.charCodeAt(i))) i++;
  if (i === text.length) return text;
  let out = text.slice(0, i);
  for (; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out += isAsciiUpper(unit) ? String.fromCharCode(unit + 0x20) : (text[i] ?? '');
  }
  return out;
}

function isAsciiUpper(unit: number): boolean {
  return unit >= 0x41 && unit <= 0x5a;
}

/**
 * Puts every code point of `text` through `table` (a code point the table does not name stands for
 * itself), then the result into NFC -- the whole text, since a mapping can leave combining marks
 * that reorder or compose across the boundaries it created. `asciiFast` answers an all-ASCII text
 * without the loop.
 */
function mapThenNfc(
  text: string,
  table: (codePoint: number) => string | undefined,
  asciiFast?: (text: string) => string,
): string {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return asciiFast === undefined ? text : asciiFast(text);
  let mapped = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    mapped += table(codePoint) ?? character;
  }
  return nfcFloor(mapped);
}

/**
 * How a refusal names a token: `'written'`, and where the type's form changed it, the value it was
 * read as -- `'PUT' (read as 'put' under NFKC_CASEFOLD)` (§5.5). The facets judge the value, so the
 * message states it; the written spelling leads because it is the text a reader has to find in the
 * document.
 */
export function describeToken(written: string, value: string, form: Normalization): string {
  return written === value ? `'${written}'` : `'${written}' (read as '${value}' under ${form})`;
}
