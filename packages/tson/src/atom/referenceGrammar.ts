/**
 * The reference production of [TSON-DATA] §7.4 read from text into the {@link Reference} it spells:
 * what a JSON string at a reference-typed position holds, JSON having no unquoted form, and the text
 * form {@link referenceText} writes. The TSON text reader builds the same value from tokens
 * (`stream/dataStream.ts`); both share the rule functions below, one per production.
 *
 * ```
 * reference   = sibling-ref / qualified-name ["<" ws type-args ws ">"]  ; "<" adjacent to the name
 * sibling-ref = identifier "!"                                  ; one segment; the text ends at the "!"
 * type-args   = type-arg *(separator type-arg) [ws ","]         ; separator = ws "," ws / ws1
 * type-arg    = reference / token                               ; a qualified name is a reference, any
 *                                                               ; other token (a number, a quoted token) a value
 * ```
 *
 * A quoted argument is `"` delimited, with the `\"`, `\\`, `\/`, `\n`, `\r`, `\t` and `\uXXXX`
 * escapes, and is never a reference. Whitespace inside an argument list is free, so `result< T >`
 * and `result<T>` parse to one reference.
 *
 * Two entry points, one production: {@link parseReference} reads every variant, a sibling reference
 * among them, for the one slot that holds one, a record field's type; {@link parseTypeReference}
 * reads a name or an application and refuses a sibling reference by the position rule
 * ([TSON-SCHEMA] §5.2): every other reference-typed position names a type. A sibling reference is
 * never an argument, so one inside an argument list is refused wherever the reference stands.
 *
 * This is the grammar alone: what the head and each argument resolve to is the position's to judge.
 * No regular expression stands in it -- the segments are matched by the identifier grammar (§7.7).
 */
import type { Reference, ReferenceArgument, TypeReference } from '../ast/reference.js';
import { TsonAtomParseError } from '../core/errors.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';

export { argumentText, referenceText } from '../ast/reference.js';

/** The `expected` fragment every failure of this grammar reports. */
const A_REFERENCE = 'a reference';

/**
 * Whether `text` is a qualified name: one or more identifiers (§7.7) joined by `.`, none empty,
 * each matched in full.
 */
export function isQualifiedName(text: string): boolean {
  if (text.length === 0) return false;
  for (const segment of text.split('.')) {
    if (!isIdentifierText(segment)) return false;
  }
  return true;
}

/**
 * Whether `field` may stand before a sibling reference's `!`: one identifier, a single segment
 * (§7.4). A dotted name would be a chained projection, which the grammar does not have.
 */
export function isSiblingField(field: string): boolean {
  return field.length > 0 && !field.includes('.') && isIdentifierText(field);
}

/**
 * `text` as the type reference it spells, a name or an application.
 *
 * @throws TsonAtomParseError where it spells none, or spells a sibling reference, which stands only
 *   at a record field's type
 */
export function parseTypeReference(text: string): TypeReference {
  const reference = parseReference(text);
  if (reference.kind === 'sibling') {
    throw new TsonAtomParseError(
      'reference',
      `a sibling reference ('${reference.field}!') stands only at a record field's type ` +
        '([TSON-SCHEMA] §5.2), not at a position typed by a type reference',
      "a type's name",
    );
  }
  return reference;
}

/**
 * `text` as the reference it spells: a name, an application or a sibling reference.
 *
 * @throws TsonAtomParseError where it spells none, naming what failed
 */
export function parseReference(text: string): Reference {
  const cursor = createCursor(text);
  const reference = cursor.reference();
  if (!cursor.atEnd()) throw cursor.error(`'${cursor.rest()}' follows the reference`);
  return reference;
}

/**
 * The names `reference` writes -- its head and every reference among its arguments, at any depth --
 * which a position's name hygiene judges one by one, as it judges a bare name (§8.2).
 */
export function referenceNames(reference: TypeReference): string[] {
  const names = [reference.name];
  if (reference.kind === 'application') {
    for (const argument of reference.arguments) {
      if (argument.kind === 'reference') names.push(...referenceNames(argument.reference));
    }
  }
  return names;
}

// ── The cursor over the text ─────────────────────────────────────────────────────────────

interface TextCursor {
  readonly atEnd: () => boolean;
  readonly rest: () => string;
  readonly error: (detail: string) => TsonAtomParseError;
  readonly reference: () => Reference;
}

function createCursor(text: string): TextCursor {
  /** Code points of `text`, so no position is a UTF-16 index into a character. */
  const points = Array.from(text);
  let at = 0;

  const atEnd = (): boolean => at === points.length;
  const here = (): string => points[at] ?? '';
  const rest = (): string => points.slice(at).join('');
  const error = (detail: string): TsonAtomParseError =>
    new TsonAtomParseError('reference', `'${text}' is no reference -- ${detail}`, A_REFERENCE);

  /** The next code point, consumed. Only called where the text is known not to have ended. */
  function take(): string {
    const c = points[at];
    if (c === undefined) throw error('the text ends where more was expected');
    at++;
    return c;
  }

  /** `word = *(any character but whitespace, "<", ">", "," or a quote)`. */
  function word(): string {
    const start = at;
    while (!atEnd() && !isWhitespace(here()) && !'<>,"'.includes(here())) at++;
    return points.slice(start, at).join('');
  }

  /** `ws = *whitespace`. */
  function skipWhitespace(): void {
    while (!atEnd() && isWhitespace(here())) at++;
  }

  /** `separator = ws ["," ws]`. */
  function skipSeparators(): void {
    skipWhitespace();
    if (!atEnd() && here() === ',') {
      at++;
      skipWhitespace();
    }
  }

  /** `qualified-name`: each `.`-separated segment of `head` an identifier, none empty. */
  function requireSegments(head: string): void {
    for (const segment of head.split('.')) {
      if (segment.length === 0) {
        throw error(`'${head}' has an empty segment -- each segment between the dots is a name`);
      }
      if (!isIdentifierText(segment)) {
        throw error(`'${segment}' is no name: a name is an identifier (§7.7)`);
      }
    }
  }

  /** `sibling-ref = identifier "!"`: `head`, a word ending in `!`, the text ending at the mark. */
  function sibling(head: string): Reference {
    const field = head.slice(0, -1);
    if (!isSiblingField(field)) {
      throw error(
        `'${field}' is no field name a sibling reference can mark -- the '!' follows one identifier, a single segment`,
      );
    }
    if (!atEnd()) throw error(`the '!' of a sibling reference ends it, and '${rest()}' follows`);
    return { kind: 'sibling', field };
  }

  /** `quoted-token` inside an argument list: `"`-delimited with the JSON escapes. */
  function quoted(): string {
    let out = '';
    at++; // opening quote
    for (;;) {
      if (atEnd()) throw error("a quoted argument has no closing '\"'");
      const c = take();
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      if (atEnd()) throw error('a quoted argument ends inside an escape');
      const escaped = take();
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          out += escaped;
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const digits = points.slice(at, at + 4).join('');
          if (points.length - at < 4 || !isHexDigits(digits)) {
            throw error("a '\\u' escape needs four hex digits");
          }
          out += String.fromCharCode(Number.parseInt(digits, 16));
          at += 4;
          break;
        }
        default:
          throw error(`'\\${escaped}' is no escape`);
      }
    }
  }

  /** `type-arg = reference / token`. */
  function argument(): ReferenceArgument {
    if (here() === '"') return { kind: 'value', text: quoted(), form: 'single-line' };
    const start = at;
    const w = word();
    if (w.length === 0) throw error(`expected an argument, found '${here()}'`);
    if (w.endsWith('!') && isSiblingField(w.slice(0, -1))) {
      throw error(
        `a sibling reference ('${w}') stands only at a record field's type ([TSON-SCHEMA] §5.2), not at a template argument`,
      );
    }
    if (!isQualifiedName(w)) {
      if (!atEnd() && here() === '<') {
        throw error(`'${w}' is no qualified name, so it takes no argument list`);
      }
      return { kind: 'value', text: w, form: 'unquoted' };
    }
    at = start;
    return { kind: 'reference', reference: reference() as TypeReference };
  }

  /** `reference = sibling-ref / qualified-name ["<" ws type-args ws ">"]`. */
  function reference(): Reference {
    const start = at;
    const head = word();
    if (head.length === 0) {
      throw error(
        atEnd()
          ? 'a reference names something, and this is empty'
          : `expected a name, found '${here()}'`,
      );
    }
    if (head.endsWith('!')) return sibling(head);
    requireSegments(head);
    const afterHead = at;
    if (atEnd() || here() !== '<') return { kind: 'name', name: head };
    at++; // '<'
    const args: ReferenceArgument[] = [];
    skipSeparators();
    for (;;) {
      if (atEnd()) {
        throw error(`'<' after '${points.slice(start, afterHead).join('')}' has no closing '>'`);
      }
      if (here() === '>') {
        if (args.length === 0) {
          throw error(`an argument list holds at least one argument, and '${head}<>' holds none`);
        }
        at++;
        return { kind: 'application', name: head, arguments: args };
      }
      args.push(argument());
      const beforeSeparator = at;
      skipSeparators();
      if (at === beforeSeparator && !atEnd() && here() !== '>') {
        throw error(`expected a separator or '>', found '${here()}'`);
      }
    }
  }

  return { atEnd, rest, error, reference };
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u000B' || c === '\f';
}

function isHexDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (const c of text) {
    const code = c.charCodeAt(0);
    const digit = code >= 0x30 && code <= 0x39;
    const upper = code >= 0x41 && code <= 0x46;
    const lower = code >= 0x61 && code <= 0x66;
    if (!digit && !upper && !lower) return false;
  }
  return true;
}
