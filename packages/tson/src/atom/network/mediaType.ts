/**
 * A media type (RFC 6838) with its parameters (RFC 9110 §8.3.1) -- `text/html;charset=utf-8`
 * ([TSON-DATA] §5.5's `!media_type`). The value is the type, the subtype and a map of parameters,
 * so every spelling of one is one value.
 *
 * **Equality is the RFCs'.** The type, subtype and parameter names compare without ASCII case;
 * parameters are a map, so their order carries no meaning and a repeated name is refused; a quoted
 * value equals its token form. A parameter value keeps its case, except `charset`'s, which folds
 * (RFC 9110 §8.3.2) -- and only `charset`'s, a closed list, since which other registrations fold
 * their values is the registry's to say and not a rule a processor can hold.
 *
 * **The grammar.** The type and subtype are RFC 6838 §4.2's `restricted-name`: at most 127
 * characters, the first a letter or digit. Parameters are RFC 9110's: `;` with optional
 * whitespace around it, a token name, `=`, and a token or quoted-string value. Nothing beyond
 * US-ASCII. A media range (`text/*`) is `Accept`'s syntax for a pattern over media types, and not
 * one. One function per production; no `RegExp` reaches it.
 *
 * {@link MediaTypeValue.text} is the canonical text: lowercase names, the `charset` value folded,
 * parameters sorted by name with each value a token where it is one and a quoted-string
 * otherwise, joined by `;` with no whitespace. Two media types are one value exactly when their
 * canonical texts are equal.
 *
 * The facets of `media_type_type` ([TSON-SCHEMA] §5.5) are {@link MediaTypeFacets}.
 */

import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { asciiLowercase } from '../../unicode/normalization.js';
import type { AtomToken, AtomType } from '../contract.js';
import { syntaxFailure, syntaxSuccess, type Syntax } from './hostName.js';

const MAX_NAME_LENGTH = 127;

/** A media type, read: the value of a `!media_type` atom. */
export interface MediaTypeValue {
  readonly kind: 'media_type';
  /** The canonical text. */
  readonly text: string;
  /** The top-level type, lowercase: `text` in `text/html`. */
  readonly type: string;
  /** The subtype, lowercase: `ld+json` in `application/ld+json`. */
  readonly subtype: string;
  /** RFC 6839's structured suffix, the subtype's text after its last `+`: `json` in `ld+json`. */
  readonly suffix?: string;
  /** The parameters, names lowercase and in name order, values as read, `charset`'s folded. */
  readonly parameters: ReadonlyMap<string, string>;
}

/**
 * The facets of `media_type_type` ([TSON-SCHEMA] §5.5) a read applies. Absent members take the
 * constructor's defaults.
 */
export interface MediaTypeFacets {
  /** Whether parameters are admitted. Default `false`: a media type proper, not a `Content-Type` value. */
  readonly allowParameters?: boolean;
  /** When present, the types a value's type is one of, compared without ASCII case. */
  readonly types?: readonly string[];
  /**
   * When present, the structured suffixes a value's subtype is, or ends with after a `+`,
   * compared without ASCII case.
   */
  readonly suffixes?: readonly string[];
}

function isAlphaNum(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39)
  );
}

/** RFC 6838 §4.2's `restricted-name-chars` beyond letters and digits. */
const RESTRICTED_NAME_PUNCTUATION = '!#$&-^_.+';

/** RFC 9110 §5.6.2's `tchar`. */
const TCHAR_PUNCTUATION = "!#$%&'*+-.^_`|~";

function isTchar(code: number): boolean {
  return isAlphaNum(code) || TCHAR_PUNCTUATION.includes(String.fromCharCode(code));
}

/** RFC 9110 §5.6.4's `qdtext`, without `obs-text`: nothing beyond US-ASCII. */
function isQdtext(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x20 ||
    code === 0x21 ||
    (code >= 0x23 && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e)
  );
}

/** What a `quoted-pair` may escape: HTAB, SP and VCHAR. */
function isQuotedPairChar(code: number): boolean {
  return code === 0x09 || (code >= 0x20 && code <= 0x7e);
}

function hexOf(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

/** RFC 6838 §4.2's `restricted-name`: why `name` (the `part` of the media type) is not one, or `undefined`. */
function restrictedNameProblem(part: string, name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return `has a ${part} of ${String(name.length)} characters, and a ${part} is 1 to ${String(MAX_NAME_LENGTH)} (RFC 6838 §4.2)`;
  }
  if (!isAlphaNum(name.charCodeAt(0))) {
    return `has a ${part} beginning with '${name[0] ?? ''}', and a ${part} begins with a letter or digit (RFC 6838 §4.2)`;
  }
  for (let i = 1; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (!(isAlphaNum(code) || RESTRICTED_NAME_PUNCTUATION.includes(name[i] ?? ''))) {
      return `has U+${hexOf(code)} in its ${part}, and a ${part} is letters, digits and ! # $ & - ^ _ . + (RFC 6838 §4.2)`;
    }
  }
  return undefined;
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/** A parameter read: its lowercase name, its value and where reading resumes. */
interface Parameter {
  readonly name: string;
  readonly value: string;
  readonly next: number;
}

/** `quoted-string` (RFC 9110 §5.6.4), `valueStart` at the opening quote. */
function readQuotedString(
  text: string,
  valueStart: number,
): Syntax<{ readonly value: string; readonly next: number }> {
  let value = '';
  let j = valueStart + 1;
  for (;;) {
    if (j >= text.length) {
      return syntaxFailure("has a quoted parameter value with no closing '\"'");
    }
    const code = text.charCodeAt(j);
    if (code === 0x22) break;
    if (code === 0x5c) {
      if (j + 1 >= text.length || !isQuotedPairChar(text.charCodeAt(j + 1))) {
        return syntaxFailure("has a '\\' escaping nothing it may escape");
      }
      value += text[j + 1] ?? '';
      j += 2;
      continue;
    }
    if (!isQdtext(code)) {
      return syntaxFailure(
        `holds U+${hexOf(code)} in a quoted parameter value, where it may not stand`,
      );
    }
    value += text[j] ?? '';
    j += 1;
  }
  return syntaxSuccess({ value, next: j + 1 });
}

/** `parameter = parameter-name "=" parameter-value` (RFC 9110 §8.3.1), `from` at the name. */
function readParameter(text: string, from: number): Syntax<Parameter> {
  let nameEnd = from;
  while (nameEnd < text.length && isTchar(text.charCodeAt(nameEnd))) nameEnd++;
  const name = asciiLowercase(text.slice(from, nameEnd));
  if (name.length === 0 || nameEnd === text.length || text[nameEnd] !== '=') {
    return syntaxFailure("has a parameter that is not a token name, '=', and a value");
  }
  const valueStart = nameEnd + 1;
  let value: string;
  let next: number;
  if (text[valueStart] === '"') {
    const quoted = readQuotedString(text, valueStart);
    if (!quoted.ok) return quoted;
    value = quoted.value.value;
    next = quoted.value.next;
  } else {
    let valueEnd = valueStart;
    while (valueEnd < text.length && isTchar(text.charCodeAt(valueEnd))) valueEnd++;
    if (valueEnd === valueStart) {
      return syntaxFailure(`has the parameter '${name}' with no value`);
    }
    value = text.slice(valueStart, valueEnd);
    next = valueEnd;
  }
  return syntaxSuccess({ name, value: name === 'charset' ? asciiLowercase(value) : value, next });
}

/** The parameter list from `from` on: `*( OWS ";" OWS [ parameter ] )`, an empty parameter being admitted. */
function readParameters(text: string, from: number): Syntax<Map<string, string>> {
  const found = new Map<string, string>();
  let i = from;
  while (i < text.length) {
    i = skipWhitespace(text, i);
    if (i === text.length) return syntaxFailure('ends in whitespace');
    if (text[i] !== ';') {
      return syntaxFailure(`has '${text[i] ?? ''}' where ';' or the end belongs`);
    }
    i = skipWhitespace(text, i + 1);
    if (i === text.length || text[i] === ';') continue;
    const parameter = readParameter(text, i);
    if (!parameter.ok) return parameter;
    if (found.has(parameter.value.name)) {
      return syntaxFailure(
        `has the parameter '${parameter.value.name}' twice, and parameters are a map`,
      );
    }
    found.set(parameter.value.name, parameter.value.value);
    i = parameter.value.next;
  }
  return syntaxSuccess(found);
}

/** A parameter value as the canonical text spells it: a token where it is one, a quoted-string otherwise. */
function spellValue(value: string): string {
  let isToken = value.length > 0;
  for (let i = 0; i < value.length && isToken; i++) isToken = isTchar(value.charCodeAt(i));
  if (isToken) return value;
  let quoted = '"';
  for (const character of value) {
    if (character === '"' || character === '\\') quoted += '\\';
    quoted += character;
  }
  return `${quoted}"`;
}

/**
 * The media type `text` spells. Failing, the reason is worded to follow `it `: `has no '/', ...`.
 */
export function parseMediaTypeText(text: string): Syntax<MediaTypeValue> {
  const slash = text.indexOf('/');
  if (slash < 0) {
    return syntaxFailure("has no '/', and a media type is a type and a subtype");
  }
  let end = slash + 1;
  while (end < text.length && text[end] !== ';' && text[end] !== ' ' && text[end] !== '\t') end++;
  const writtenType = text.slice(0, slash);
  const writtenSubtype = text.slice(slash + 1, end);
  if (writtenType === '*' || writtenSubtype === '*') {
    return syntaxFailure(
      "is a media range, Accept's pattern over media types, and not a media type",
    );
  }
  const typeProblem = restrictedNameProblem('type', writtenType);
  if (typeProblem !== undefined) return syntaxFailure(typeProblem);
  const subtypeProblem = restrictedNameProblem('subtype', writtenSubtype);
  if (subtypeProblem !== undefined) return syntaxFailure(subtypeProblem);

  const read = readParameters(text, end);
  if (!read.ok) return read;
  const parameters = new Map([...read.value].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const type = asciiLowercase(writtenType);
  const subtype = asciiLowercase(writtenSubtype);
  let canonical = `${type}/${subtype}`;
  for (const [name, value] of parameters) canonical += `;${name}=${spellValue(value)}`;
  const plus = subtype.lastIndexOf('+');
  const value: MediaTypeValue =
    plus < 0
      ? { kind: 'media_type', text: canonical, type, subtype, parameters }
      : {
          kind: 'media_type',
          text: canonical,
          type,
          subtype,
          suffix: subtype.slice(plus + 1),
          parameters,
        };
  return syntaxSuccess(value);
}

/**
 * Reads a `!media_type` token against `media_type_type` ([TSON-SCHEMA] §5.5) and returns the media
 * type with its canonical text.
 *
 * @param text the token's decoded text, in any spelling of the media type
 * @param facets the constructor's facets; absent members take its defaults
 * @param typeRef the type's name, for error reporting
 * @throws {@link TsonAtomParseError} when `text` is not a media type; `expected` is `a media type`
 * @throws {@link TsonAtomValidationError} when `text` is a media type outside a facet:
 *   parameters where `allowParameters` is not `true`, a type not in `types`, or a subtype that is
 *   not, and has no `+` suffix in, `suffixes`; `expected` names the admitted shape
 */
export function parseMediaType(
  text: string,
  facets: MediaTypeFacets = {},
  typeRef = 'media_type',
): MediaTypeValue {
  const parsed = parseMediaTypeText(text);
  if (!parsed.ok) {
    throw new TsonAtomParseError(
      typeRef,
      `'${text}' is not a media type: it ${parsed.reason}`,
      'a media type',
    );
  }
  const value = parsed.value;
  if (facets.allowParameters !== true && value.parameters.size > 0) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' carries parameters, and this type admits a media type without them ` +
        '(allow_parameters: false)',
      'a media type without parameters',
    );
  }
  const types = facets.types;
  if (types !== undefined && !types.some((t) => asciiLowercase(t) === value.type)) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has the type '${value.type}', which is not one of [${types.join(', ')}]`,
      `a media type of type ${types.join(', ')}`,
    );
  }
  const suffixes = facets.suffixes;
  if (
    suffixes !== undefined &&
    !suffixes.some((s) => {
      const suffix = asciiLowercase(s);
      return value.subtype === suffix || value.subtype.endsWith(`+${suffix}`);
    })
  ) {
    throw new TsonAtomValidationError(
      typeRef,
      `'${text}' has the subtype '${value.subtype}', which is none of [${suffixes.join(', ')}] and ` +
        'has none of them as its suffix',
      `a media type with the suffix ${suffixes.join(', ')}`,
    );
  }
  return value;
}

/**
 * The `AtomType` for one `media_type_type` instance, whose host value is the media type's
 * canonical text: two media types are one value exactly when their canonical texts are equal.
 */
export function createMediaTypeParser(
  typeRef: string,
  facets: MediaTypeFacets = {},
): AtomType<string> {
  return {
    read: (token: AtomToken): string => parseMediaType(token.text, facets, typeRef).text,
    write: (value: string): string => value,
  };
}
