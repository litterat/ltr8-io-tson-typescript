/**
 * Writes a {@link JsonValue} back out as RFC 8259 JSON text — the exact inverse of
 * `json/schemalessTree.ts`'s read side. Every one of RFC 8259's six kinds has exactly one spelling
 * and the tree already holds it: a number re-emits the literal it was read from, so [TSON-JSON]
 * §5.3's digits and scale survive (`199.90` stays `199.90`, never `199.9`), and a string's content
 * and this module's own escaping are one inverse pair with `json/lexer.ts`'s decoding.
 *
 * Two forms, matching the reference's `JsonTreeWriter`/JEP 540's own `toString`/`toDisplayString`
 * split: {@link jsonValueToText} is compact RFC 8259 on one line (the form to send — §9.3 makes
 * whitespace insignificant to a round trip, so both parse back to the same value and the indented
 * form costs bytes only for a human reader), {@link jsonValueToDisplayString} is the indented,
 * pretty-printed form.
 *
 * **Never a BOM** (§3.1: "A byte order mark MUST NOT be emitted"). This module writes `string`
 * only through JavaScript's own UTF-16 text; `io/utf8.ts`'s `encodeUtf8` is what a caller reaches
 * for to get UTF-8 bytes, and it never prepends one.
 */
import { TsonWriteError } from '../core/errors.js';
import type { JsonArray, JsonObject, JsonValue } from './tree.js';

/**
 * `value` as an RFC 8259 string literal, quotation marks included — the write-side inverse of
 * `json/lexer.ts`'s escape decoding, and the only place this module writes a string. Escapes what
 * RFC 8259 requires and nothing more: the quotation mark, the reverse solidus, and the control
 * characters U+0000–U+001F (five of which have short forms); `/` is left alone (`\/` is legal and
 * pointless to emit), and every other character is written as itself, since a UTF-8 document has
 * no reason to spell an ordinary character as an escape.
 *
 * @throws TsonWriteError if `value` holds a lone surrogate half — never producible by
 * `json/lexer.ts`, which refuses one on the way in (§3.1), but reachable from a hand-built
 * `JsonString`. §9.2 requires an encoder's output to be "accepted by this document's decode
 * rules"; writing it as its own `\u` escape is well-formed UTF-16 text, but `json/index.ts`'s own
 * `parseJson` would then refuse reading it back (the same lone-surrogate rule §3.1 states for the
 * read side), which would break exactly that round trip. §4.3 treats input this profile cannot
 * carry as refused with an error, so this does the same at the point of writing rather than
 * sending it.
 */
export function quoteJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charAt(i);
    const code = value.charCodeAt(i);
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        if (isUnpairedSurrogate(value, i, code)) {
          throw new TsonWriteError(
            `U+${code.toString(16).toUpperCase().padStart(4, '0')} is a lone surrogate half; ` +
              'this profile cannot carry one (§3.1, §4.3, §9.2)',
          );
        }
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : c;
    }
  }
  return out + '"';
}

/** Whether the UTF-16 code unit at `i` is a surrogate half with no partner: a high one with no low after it, or a low one with no high before it. */
function isUnpairedSurrogate(value: string, i: number, code: number): boolean {
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = i + 1 < value.length ? value.charCodeAt(i + 1) : undefined;
    return next === undefined || next < 0xdc00 || next > 0xdfff;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const prev = i > 0 ? value.charCodeAt(i - 1) : undefined;
    return prev === undefined || prev < 0xd800 || prev > 0xdbff;
  }
  return false;
}

/** `value` as compact RFC 8259 JSON, on one line — what {@link parseJson} (`json/index.ts`) accepts back, §9.2's round trip. */
export function jsonValueToText(value: JsonValue): string {
  const out: string[] = [];
  writeCompact(value, out);
  return out.join('');
}

function writeCompact(value: JsonValue, out: string[]): void {
  switch (value.kind) {
    case 'object': {
      out.push('{');
      let first = true;
      for (const [name, member] of value.members) {
        if (!first) out.push(',');
        first = false;
        out.push(quoteJsonString(name), ':');
        writeCompact(member, out);
      }
      out.push('}');
      break;
    }
    case 'array': {
      out.push('[');
      value.elements.forEach((element, i) => {
        if (i > 0) out.push(',');
        writeCompact(element, out);
      });
      out.push(']');
      break;
    }
    case 'string':
      out.push(quoteJsonString(value.value));
      break;
    case 'number':
      out.push(value.literal);
      break;
    case 'boolean':
      out.push(value.value ? 'true' : 'false');
      break;
    case 'null':
      out.push('null');
      break;
  }
}

/**
 * A pretty-printed rendering, one member or element per line, indented by `indent` per level
 * (default two spaces) — for a person to read; {@link jsonValueToText} is the form to send. An
 * empty object or array stays on one line either way, matching the reference's own choice.
 */
export function jsonValueToDisplayString(value: JsonValue, indent = '  '): string {
  const out: string[] = [];
  writeIndented(value, indent, 0, out);
  return out.join('');
}

function writeIndented(value: JsonValue, indent: string, level: number, out: string[]): void {
  if (value.kind === 'object' && value.members.size > 0) {
    writeIndentedObject(value, indent, level, out);
    return;
  }
  if (value.kind === 'array' && value.elements.length > 0) {
    writeIndentedArray(value, indent, level, out);
    return;
  }
  writeCompact(value, out);
}

function writeIndentedObject(
  value: JsonObject,
  indent: string,
  level: number,
  out: string[],
): void {
  out.push('{\n');
  let first = true;
  for (const [name, member] of value.members) {
    if (!first) out.push(',\n');
    first = false;
    out.push(indent.repeat(level + 1), quoteJsonString(name), ': ');
    writeIndented(member, indent, level + 1, out);
  }
  out.push('\n', indent.repeat(level), '}');
}

function writeIndentedArray(value: JsonArray, indent: string, level: number, out: string[]): void {
  out.push('[\n');
  value.elements.forEach((element, i) => {
    if (i > 0) out.push(',\n');
    out.push(indent.repeat(level + 1));
    writeIndented(element, indent, level + 1, out);
  });
  out.push('\n', indent.repeat(level), ']');
}
