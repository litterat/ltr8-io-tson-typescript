/**
 * A domain name as a host names it ([TSON-DATA] §5.5's `!hostname`): labels of letters, digits and
 * hyphens (RFC 1123 §2.1), or internationalized labels judged by IDNA2008 (RFC 5890-5893), written
 * as U-labels or as their A-labels in any mix. The value is the name, so every spelling of one
 * name is one value: `Example.COM` and `example.com`, and `xn--bcher-kva.example` and
 * `bücher.example`.
 *
 * **Two forms of one value.** {@link HostnameValue.unicode} is the name with each label as its
 * U-label where it has one, for display and an IRI; {@link HostnameValue.ascii} is the name with
 * each such label as its A-label, for DNS, a URI and HTTP. Each is recovered from the other by
 * Punycode alone, so neither is lost. {@link HostnameValue.text} is the U-label form, the
 * canonical text, and two names are one value exactly when their `ascii` forms are equal -- which
 * is when their `text` forms are.
 *
 * **Validity is IDNA2008's, and nothing is mapped.** A U-label must already be in its one valid
 * form -- NFC, every code point `PVALID` or meeting its contextual rule (`unicode/idna.ts`), the
 * name meeting RFC 5893's Bidi rule -- and text that is not is refused with what to write instead,
 * never rewritten into it. UTS #46's mapping is what would rewrite it, and its tables move with
 * each Unicode release. The one fold is ASCII's: `A`-`Z` read as `a`-`z`, in an LDH label, an
 * A-label or a U-label alike, which is how DNS has always compared.
 *
 * **The boundaries an operator meets**, each refused with its fix: uppercase beyond ASCII
 * (`BÜCHER` -- IDNA2008 has no uppercase U-label), a trailing dot (`example.com.`),
 * percent-encoding (URI syntax, not a name), and a last label beginning with a digit, which keeps
 * a dotted-quad from ever being a host name. Labels are at most 63 octets and the name at most
 * 253, counted in the A-label form.
 *
 * The facet `allow_idn` of `hostname_type` ([TSON-SCHEMA] §5.5) is {@link HostnameFacets}: `false`
 * refuses an internationalized name as a constraint violation, the name being one.
 *
 * Every grammar here is hand-written, one function per rule, and no `RegExp` reaches it.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { asciiLowercase, nfkcCasefold } from '../../unicode/normalization.js';
import { bidiViolation, hasRightToLeft } from '../../unicode/bidi.js';
import { isDecimalDigit, uLabelProblem } from '../../unicode/idna.js';
import { toNfc } from '../../unicode/nfc.js';
import type { AtomToken, AtomType } from '../contract.js';
import { punycodeDecode, punycodeEncode } from './punycode.js';

/** The longest label, in octets of its A-label form (RFC 1035 §2.3.4). */
const MAX_LABEL_OCTETS = 63;
/** The longest name, in octets of its A-label form (RFC 1035 §2.3.4). */
const MAX_NAME_OCTETS = 253;

const ASCII_PREFIX = 'xn--';

/** The outcome of reading text under a grammar: the value, or why the text is not one. */
export type Syntax<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** A {@link Syntax} that failed. */
export function syntaxFailure(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

/** A {@link Syntax} that succeeded. */
export function syntaxSuccess<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/**
 * A host name, read: the value of a `!hostname` atom. Two host names are one value when their
 * {@link ascii} forms are equal.
 */
export interface HostnameValue {
  readonly kind: 'hostname';
  /** The canonical text: {@link unicode}. */
  readonly text: string;
  /** The name with each internationalized label as its U-label, for display and an IRI. */
  readonly unicode: string;
  /** The name with each internationalized label as its A-label, for DNS, a URI and HTTP. */
  readonly ascii: string;
  /** Whether any label is internationalized -- written as a U-label or an A-label alike. */
  readonly isIdn: boolean;
}

/**
 * The facets of `hostname_type` ([TSON-SCHEMA] §5.5) a read applies. Absent members take the
 * constructor's defaults.
 */
export interface HostnameFacets {
  /** Whether an internationalized name is admitted. Default `true`. */
  readonly allowIdn?: boolean;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) return false;
  }
  return true;
}

/** RFC 1123 §2.1 over a lowercase ASCII label that is not an A-label: why it is not one, or `undefined`. */
function ldhProblem(label: string): string | undefined {
  for (const c of label) {
    const isLdh = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
    if (!isLdh) {
      return c === '_'
        ? "holds '_', a DNS name character and not a host name one: a label is letters, digits and hyphens"
        : `holds '${c}', and a label is letters, digits and hyphens`;
    }
  }
  if (label.startsWith('-') || label.endsWith('-')) return 'begins or ends with a hyphen';
  if (label.length >= 4 && label[2] === '-' && label[3] === '-') {
    return 'has hyphens in its third and fourth places, which are reserved for A-labels (RFC 5890 §2.3.1)';
  }
  return undefined;
}

/** The lowercase, NFC spelling of `text` as a fix to name, where that would be a host name. */
function suggestion(text: string): string {
  const fixed = toNfc(nfkcCasefold(text));
  if (fixed === text) return '';
  return parseHostName(fixed).ok ? ` -- write '${fixed}'` : '';
}

/** One label read: its U-label form, its A-label form and whether it is internationalized. */
interface Label {
  readonly unicode: string;
  readonly ascii: string;
  readonly idn: boolean;
}

/** An ASCII label beginning `xn--`: it must be the A-label of a valid U-label, spelled as Punycode spells it. */
function readALabel(written: string, label: string): Syntax<Label> {
  const uLabel = punycodeDecode(label.slice(ASCII_PREFIX.length));
  if (uLabel === undefined || isAscii(uLabel)) {
    return syntaxFailure(
      `has the label '${written}', which begins 'xn--' and is not an A-label: its rest does not ` +
        'decode to an internationalized label',
    );
  }
  const problem = uLabelProblem(uLabel);
  if (problem !== undefined) {
    return syntaxFailure(`has the A-label '${written}', whose U-label '${uLabel}' ${problem}`);
  }
  const reencoded = punycodeEncode(uLabel);
  if (reencoded === undefined || reencoded !== label.slice(ASCII_PREFIX.length)) {
    return syntaxFailure(
      `has the label '${written}', which is not the A-label of its own U-label '${uLabel}'`,
    );
  }
  return syntaxSuccess({ unicode: uLabel, ascii: label, idn: true });
}

/** A label holding a character beyond ASCII: it must be a valid U-label as written. */
function readULabel(written: string, label: string, whole: string): Syntax<Label> {
  const problem = uLabelProblem(label);
  if (problem !== undefined) {
    return syntaxFailure(`has the label '${written}', which ${problem}${suggestion(whole)}`);
  }
  const encoded = punycodeEncode(label);
  if (encoded === undefined) {
    return syntaxFailure(`has the label '${written}', too long to encode`);
  }
  const ascii = ASCII_PREFIX + encoded;
  if (ascii.length > MAX_LABEL_OCTETS) {
    return syntaxFailure(
      `has the label '${written}', which is ${String(ascii.length)} octets as an A-label, and a ` +
        `label is at most ${String(MAX_LABEL_OCTETS)}`,
    );
  }
  return syntaxSuccess({ unicode: label, ascii, idn: true });
}

/** One written label, read in whichever form it was written. */
function readLabel(written: string, whole: string): Syntax<Label> {
  const label = asciiLowercase(written);
  if (!isAscii(label)) return readULabel(written, label, whole);
  if (label.length > MAX_LABEL_OCTETS) {
    return syntaxFailure(
      `has the label '${written}', which is ${String(label.length)} octets as an A-label, and a ` +
        `label is at most ${String(MAX_LABEL_OCTETS)}`,
    );
  }
  if (label.startsWith(ASCII_PREFIX)) return readALabel(written, label);
  const problem = ldhProblem(label);
  if (problem !== undefined) {
    return syntaxFailure(`has the label '${written}', which ${problem}`);
  }
  return syntaxSuccess({ unicode: label, ascii: label, idn: false });
}

/**
 * RFC 5893's Bidi rule over a name holding right-to-left text: every label of it, ASCII labels
 * included, meets the rule's six conditions.
 */
function bidiProblem(labels: readonly Label[]): string | undefined {
  if (!labels.some((label) => hasRightToLeft(label.unicode))) return undefined;
  for (const label of labels) {
    const violation = bidiViolation(label.unicode);
    if (violation !== undefined) {
      return `holds right-to-left text, and its label '${label.unicode}' breaks the Bidi rule: ${violation}`;
    }
  }
  return undefined;
}

/**
 * The host name `text` spells, in any spelling of it. Failing, the reason is worded to follow
 * `it `: `is empty, ...`, `holds the label ...`.
 */
export function parseHostName(text: string): Syntax<HostnameValue> {
  if (text.length === 0) {
    return syntaxFailure('is empty, and a host name has at least one label');
  }
  if (text.includes('%')) {
    return syntaxFailure(
      'is percent-encoded, which is URI syntax rather than a host name -- write the characters themselves',
    );
  }
  if (text.endsWith('.')) {
    return syntaxFailure(
      `ends with a dot, and a host name carries no trailing dot -- write '${text.slice(0, -1)}'`,
    );
  }
  const labels: Label[] = [];
  for (const written of text.split('.')) {
    if (written.length === 0) {
      return syntaxFailure('has an empty label -- two dots together, or a leading dot');
    }
    const label = readLabel(written, text);
    if (!label.ok) return label;
    labels.push(label.value);
  }
  const last = labels.at(-1);
  if (last === undefined) return syntaxFailure('is empty, and a host name has at least one label');
  if (isDecimalDigit(last.unicode.codePointAt(0) ?? 0)) {
    return syntaxFailure(
      "ends in a label beginning with a digit, and a host name's last label begins with a letter " +
        '-- a dotted-quad is an IPv4 address, not a host name',
    );
  }
  const idn = labels.some((label) => label.idn);
  if (idn) {
    const bidi = bidiProblem(labels);
    if (bidi !== undefined) return syntaxFailure(bidi);
  }
  const ascii = labels.map((label) => label.ascii).join('.');
  if (ascii.length > MAX_NAME_OCTETS) {
    return syntaxFailure(
      `is ${String(ascii.length)} octets as A-labels, and a host name is at most ${String(MAX_NAME_OCTETS)}`,
    );
  }
  const unicode = idn ? labels.map((label) => label.unicode).join('.') : ascii;
  return syntaxSuccess({ kind: 'hostname', text: unicode, unicode, ascii, isIdn: idn });
}

/**
 * Reads a `!hostname` token against `hostname_type` ([TSON-SCHEMA] §5.5) and returns the name with
 * its canonical text.
 *
 * @param text the token's decoded text, in any spelling of the name
 * @param facets the constructor's facets; absent members take its defaults
 * @param typeRef the type's name, for error reporting
 * @throws {@link TsonAtomParseError} when `text` is not a host name -- outside the family's
 *   grammar (§5.2); `expected` is `a host name`
 * @throws {@link TsonAtomValidationError} when `text` is a host name outside a facet:
 *   `allowIdn: false` and the name internationalized; `expected` is
 *   `a host name with no internationalized label`
 */
export function parseHostname(
  text: string,
  facets: HostnameFacets = {},
  typeRef = 'hostname',
): HostnameValue {
  const parsed = parseHostName(text);
  if (!parsed.ok) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a host name: it ${parsed.reason}`,
      'a host name',
    );
  }
  if (facets.allowIdn === false && parsed.value.isIdn) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' is an internationalized host name, and this type admits only names of ASCII ` +
        'labels (allow_idn: false)',
      'a host name with no internationalized label',
    );
  }
  return parsed.value;
}

/**
 * The `AtomType` for one `hostname_type` instance, whose host value is the name's canonical text:
 * two names are one value exactly when their canonical texts are equal, so the string carries the
 * equality §5.5 gives the type and a list of names compares by name in either spelling.
 */
export function createHostnameParser(
  typeRef: string,
  facets: HostnameFacets = {},
): AtomType<string> {
  return {
    read: (token: AtomToken): string => parseHostname(token.text, facets, typeRef).text,
    write: (value: string): string => value,
  };
}
