/**
 * Atom-typed positions ([TSON-JSON] §5): one rule ("where a family's rules admit a string, the
 * string's content is handed to the atom's own parser exactly as a TSON quoted token's text
 * would be", §5.1) and a per-family table of which JSON kinds reach it (§5's own table, this
 * module's {@link AtomForm}). This encoding adds no atom grammar of its own: a string's content
 * faces the same parser, the same acceptance set and the same error split as the equivalent TSON
 * token (`atom/forType.ts`'s `atomParserFor`), so the two encodings cannot disagree about whether
 * `"2026-07-01"` is a `date`.
 *
 * **Contract rejection and constraint violation stay apart** ({@link atomReader}'s own `try`):
 * `core/diagnostic.ts`'s `diagnosticCodeForAtomError` maps `TsonAtomParseError` to
 * `ATOM_FORM_INVALID` and `TsonAtomValidationError` to `ATOM_CONSTRAINT_VIOLATION` — §5.1's split,
 * applied by the same function that applies it for TSON text.
 *
 * **`void`, `value` and `identifier`** are the kernel's three `unit` instances (§4.2 — "the atom
 * with no constraint vocabulary"), dispatched on the *declared name* rather than on the (identical)
 * resolved body, matching [TSON-SCHEMA] §4.2's own normative dispatch: {@link voidReader} (§5.7 —
 * the absent sentinel's own type, admitting JSON null and nothing else), {@link
 * valuePositionReader} (§5.7 — the escape hatch, classifying a JSON value by its own grammar with
 * no base-type-resolution detour), and {@link identifierReader} (this encoding's own reading: the
 * shared `unicode/identifier-profile.ts` grammar over a JSON string's content, since `atom/forType.ts`
 * offers no parser for `identifier` — its own top note: "neither does `unit`'s `value`/`token`
 * instance"). An alias of any of the three (`day => date` is not one of them, since `date` is a
 * `date_type` body and not `unit`) reaches the same reader by [TSON-SCHEMA] §8.3's
 * reference-collapse, since `json/schema/compile.ts` resolves a closed reference to its target's
 * reader once, at compile time, by name — the same collapse an alias of `boolean` (an `enum`
 * body, not `unit`) reaches below.
 *
 * **§5.2's enum rule is applied uniformly, `boolean` included**: `boolean` is the kernel's own
 * `!enum [true false]`, and {@link enumReader} special-cases it (by declared name) only for the
 * *decode* side — every enum, `boolean`'s own instances (an alias, via reference collapse) and
 * every other member set alike, matches on **content**, never on JSON kind: a string contributes
 * its escape-processed content, `true`/`false` their literals, a number its lexeme, so a JSON
 * string, boolean, or number can all reach a `boolean` position (this module's own {@link
 * contentOf}) and only content matching `{"true", "false"}` narrows to the real host boolean.
 *
 * **A JSON number at an enum position is matched by its lexeme — a deliberate divergence from the
 * pinned Java reference, which refuses one.** [TSON-JSON] §5.2 states the rule over "the arriving
 * JSON value's content", enumerating string, `true`/`false`, and "a number, its lexeme" as the three
 * cases with no exception for numbers; the worked example even shows a `TEXT`-profile member spelled
 * `80` decoding from the number `80`. `AtomForm.ENUM.contentOf` in the Java module (`tson-json`) does
 * not admit `JsonEvent.NumberValue` at all — an omission from the table this port does not carry
 * over, since Part 3 is the authority Revision 36's own front matter names ("Part 3 is the authority"
 * over the Java reference wherever the two disagree). Reported upstream as a §5.2 conformance gap in
 * the Java module.
 */
import type { AtomToken } from '../../atom/contract.js';
import { atomParserFor, type ScalarParser } from '../../atom/forType.js';
import { diagnosticCodeForAtomError } from '../../core/diagnostic.js';
import { TsonAtomParseError, TsonAtomValidationError } from '../../core/errors.js';
import { toExactDecimal, toExactInteger } from '../../base/numberNarrowing.js';
import { isHexFloat, tryParseNumber } from '../../base/numberGrammar.js';
import { isIdentifierText } from '../../unicode/identifier-profile.js';
import type { EnumBody } from '../../schema/meta/bodies.js';
import type { Atom } from '../../schema/meta/typedef.js';
import type { SchemaLocation } from '../../core/diagnostic.js';
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';
import type { JsonEvent } from '../stream.js';
import { jsonBoolean, jsonNull, jsonNumber, jsonString, type JsonValue } from '../tree.js';
import { skipValue } from './eventSkip.js';
import type { JsonTypeReader } from './types.js';
import { identityOfHost, type Identified } from './valueIdentity.js';

// ---------------------------------------------------------------------------------------------
// AtomForm -- which JSON kinds reach the parser (§5's table)
// ---------------------------------------------------------------------------------------------

export type AtomForm = 'boolean' | 'number' | 'string' | 'number-or-string' | 'enum';

/** §5's table, read off the resolved body -- a refinement of a family takes its parent's form. */
export function atomFormOf(body: Atom): AtomForm {
  switch (body.kind) {
    case 'enum':
      return 'enum';
    case 'integer_type':
    case 'decimal_type':
      return 'number';
    case 'float_type':
      return 'number-or-string';
    default:
      return 'string';
  }
}

/** The text `event` carries for `form`'s parser, or `undefined` when `event`'s kind is one `form` does not admit. */
function contentOf(form: AtomForm, event: JsonEvent): string | undefined {
  switch (event.kind) {
    case 'boolean':
      // `boolean` and `enum` both match on content (§5.2), so both admit a JSON boolean's own
      // literal -- see this module's own top note on why `boolean` is not a stricter form.
      return form === 'boolean' || form === 'enum' ? String(event.value) : undefined;
    case 'number':
      // The divergence from the Java reference this module's own top note reports: ENUM admits a
      // number's lexeme too, following [TSON-JSON] §5.2 rather than `AtomForm.ENUM.contentOf`.
      return form === 'number' ||
        form === 'number-or-string' ||
        form === 'enum' ||
        form === 'boolean'
        ? event.literal
        : undefined;
    case 'string':
      // `boolean` admits a string's content too (§5.2: `{"flag": "true"}` and `{"flag": true}`
      // are one value) -- membership against `{true, false}` is `enumReader`'s own `parse`
      // callback, not a kind restriction here.
      return form === 'string' ||
        form === 'number-or-string' ||
        form === 'enum' ||
        form === 'boolean'
        ? event.value
        : undefined;
    default:
      return undefined;
  }
}

/** What `form` admits, for a diagnostic's `expected`. */
function describeForm(form: AtomForm): string {
  switch (form) {
    case 'boolean':
      return 'a JSON boolean (or a string/number spelling one of its members)';
    case 'number':
      return 'a JSON number';
    case 'string':
      return 'a JSON string';
    case 'number-or-string':
      return 'a JSON number, or a string for .inf/-.inf/.nan';
    case 'enum':
      return 'a JSON string, boolean or number naming a member';
  }
}

/** A JSON event, described the way a diagnostic's `actual` names it. */
export function describeEvent(event: JsonEvent): string {
  switch (event.kind) {
    case 'object-start':
      return 'an object';
    case 'array-start':
      return 'an array';
    case 'string':
      return `the string '${event.value}'`;
    case 'number':
      return `the number ${event.literal}`;
    case 'boolean':
      return String(event.value);
    case 'null':
      return 'null';
    default:
      return event.kind;
  }
}

// ---------------------------------------------------------------------------------------------
// The atom-position reader -- host value out (this module's "atoms mode", what `treeAtomReader`
// below wraps and discards for tree mode, matching the Java reference's own split between
// `ValueReaderFactoryRegistry.atoms()` and `.tree()`).
// ---------------------------------------------------------------------------------------------

function tokenOf(text: string): AtomToken {
  // Every JSON string arrives fully decoded already (`json/lexer.ts`), so this is always the
  // "quoted" reading §5.1 asks for; no atom parser in this package inspects `form` for anything
  // beyond that, so the exact literal chosen here is unobservable -- see `atom/contract.ts`'s own
  // `TokenForm` for the three-way type this satisfies structurally, without importing it (this
  // module must not reach into `lexer/`, per the `src/json/**` ESLint zone).
  return { text, form: 'single-line' };
}

/** A record naming the reader an atom position's slot was built for, and the raw host-value reader beneath any tree wrapping -- for `treeAtomKeyedReader`. */
export interface AtomReader extends JsonTypeReader {
  readonly isAtomReader: true;
}

function reportWrongForm(
  ctx: JsonReadContext,
  displayName: string,
  form: AtomForm,
  event: JsonEvent,
): void {
  ctx.report(
    'TYPE_MISMATCH',
    `'${displayName}' takes ${describeForm(form)}, and this is ${describeEvent(event)}`,
    describeForm(form),
    describeEvent(event),
  );
}

/**
 * `content` (a `number-or-string` position's string-event content) is confined to the
 * special-value or hex-float productions ([TSON-JSON] §5.4: "Decode at an approximate position
 * hands string content to the family's parser, which accepts exactly the special-value forms
 * ... and the hex-float production; any other string content is a resolver error") -- a JSON
 * string carrying a plain decimal float, e.g. `"1.5"`, is not admitted even though the family's
 * own token parser (`atom/numeric/float.ts`) would accept that text unquoted, since this
 * restriction is the JSON encoding's own, not the atom's text-token contract.
 */
function isApproximateStringForm(content: string): boolean {
  const form = tryParseNumber(content);
  if (form !== undefined) return form.kind === 'special-value';
  return isHexFloat(content);
}

/**
 * Whether `found` (an object-typed value, already consumed) is recognized as an annotation
 * object attempt ([TSON-JSON] §3.3's recognition rule: "at any typed position other than a
 * map-typed one, when the object's first member is a reserved member") -- checked with the one
 * token of lookahead this package's contexts carry, peeking the event right after `found` without
 * consuming it. `$`-initial covers the whole reserved namespace (§3.2), not only the three named
 * members, since recognizing an attempt is what is being decided here, not which member it is.
 *
 * Recognizing the attempt is as far as this package goes: reading it needs the annotation
 * object's own apparatus (§3.3), not built yet (`json/schema/compile.ts`'s own top note), so a
 * caller that gets `true` back reports `NOT_IMPLEMENTED` -- a gap, never a verdict on the
 * document -- rather than the wrong-kind error the same event would otherwise draw.
 */
export function* looksLikeAnnotationObject(ctx: JsonReadContext, found: JsonEvent): Task<boolean> {
  if (found.kind !== 'object-start') return false;
  const after = yield* ctx.peek();
  return after.kind === 'member-name' && after.name.startsWith('$');
}

/**
 * Reports and consumes `found` for a position that cannot read it: `NOT_IMPLEMENTED` when `found`
 * looks like an annotation object this package does not read yet ({@link
 * looksLikeAnnotationObject}), else the wrong-kind report `reportMismatch` builds. Either way the
 * whole value is skipped ({@link skipValue}), so the event stream is exactly where a reader that
 * understood this position would have left it.
 */
export function* reportUnreadable(
  ctx: JsonReadContext,
  displayName: string,
  found: JsonEvent,
  reportMismatch: () => void,
): Task<void> {
  if (yield* looksLikeAnnotationObject(ctx, found)) {
    ctx.report(
      'NOT_IMPLEMENTED',
      `'${displayName}' is annotated with a reserved member ([TSON-JSON] §3.3), and the ` +
        'annotation object this package does not read yet stands here',
    );
  } else {
    reportMismatch();
  }
  yield* skipValue(ctx, found);
}

/** The atom-position reader for an ordinary (non-`unit`, non-`enum`) family: §5's table, then `atomParserFor`'s own parser. */
export function atomReader(
  displayName: string,
  body: Atom,
  schemaLocation: SchemaLocation,
): AtomReader {
  const form = atomFormOf(body);
  const parser: ScalarParser | undefined = atomParserFor(displayName, body);
  return makeAtomReader(displayName, form, schemaLocation, (content) => {
    if (parser === undefined) {
      throw new Error(`'${displayName}' is an atom body with no parser -- this is a library bug`);
    }
    return parser.read(tokenOf(content));
  });
}

/**
 * The enum-position reader (§5.2): `boolean` reads a real JSON boolean (never the general
 * content-matching form, per this module's own top note); every other enum matches the arriving
 * value's *content* against its member set, and its host value is the natural parse of whichever
 * member matched.
 */
export function enumReader(
  displayName: string,
  body: EnumBody,
  schemaLocation: SchemaLocation,
): AtomReader {
  const members = body.members;
  const memberSet = new Set(members);
  const isBooleanFamily =
    displayName === 'boolean' &&
    members.length === 2 &&
    memberSet.has('true') &&
    memberSet.has('false');
  const form: AtomForm = isBooleanFamily ? 'boolean' : 'enum';
  const membership = `one of (${members.join(', ')})`;
  return makeAtomReader(displayName, form, schemaLocation, (content) => {
    if (!memberSet.has(content)) {
      throw new TsonAtomValidationError(
        displayName,
        `'${content}' is not a member of '${displayName}' -- expected ${membership}`,
        membership,
      );
    }
    return isBooleanFamily ? content === 'true' : content;
  });
}

/**
 * The bare (context-free) form and parser for `body` under `displayName` — what {@link
 * atomReader}/{@link enumReader} wrap with the read protocol, and what
 * `json/schema/record.ts`'s own `fieldValueOf` needs to resolve a schema-stated `~`/`=` token
 * (§5.2 confines one to an atom- or enum-typed field) into a host value and a spelling, with no
 * `JsonReadContext` in hand at compile time. `identifier` is the one case `atomParserFor` has no
 * parser for (this module's own top note); `void`/`value` carry no content grammar a stated token
 * could denote at all, so §5.2's own confinement rules them out before this is ever reached.
 */
export interface FieldValueParser {
  readonly form: AtomForm;
  readonly parse: (content: string) => unknown;
  /** `read`'s inverse, present only for the general `atomParserFor` branch — see this function's own use of it below. */
  readonly write?: (value: unknown) => string;
}

export function fieldValueParser(displayName: string, body: Atom): FieldValueParser {
  if (body.kind === 'enum') {
    const members = body.members;
    const memberSet = new Set(members);
    const isBooleanFamily =
      displayName === 'boolean' &&
      members.length === 2 &&
      memberSet.has('true') &&
      memberSet.has('false');
    const membership = `one of (${members.join(', ')})`;
    return {
      form: isBooleanFamily ? 'boolean' : 'enum',
      parse: (content: string) => {
        if (!memberSet.has(content)) {
          throw new TsonAtomValidationError(
            displayName,
            `'${content}' is not a member of '${displayName}' -- expected ${membership}`,
            membership,
          );
        }
        return isBooleanFamily ? content === 'true' : content;
      },
    };
  }
  if (body.kind === 'unit' && displayName === 'identifier') {
    return {
      form: 'string',
      parse: (content: string) => {
        if (!isIdentifierText(content)) {
          throw new TsonAtomParseError(
            displayName,
            `'${content}' is not a well-formed identifier (§7.7)`,
            'an identifier',
          );
        }
        return content;
      },
    };
  }
  const parser = atomParserFor(displayName, body) as
    (ScalarParser & { write(value: unknown): string }) | undefined;
  if (parser === undefined) {
    throw new Error(
      `'${displayName}' carries a schema-stated value but has no parser to read it with -- ` +
        '[TSON-SCHEMA] §5.2 confines a ~/= value to an atom- or enum-typed field',
    );
  }
  return {
    form: atomFormOf(body),
    parse: (content: string) => parser.read(tokenOf(content)),
    write: (value: unknown) => parser.write(value),
  };
}

function makeAtomReader(
  displayName: string,
  form: AtomForm,
  schemaLocation: SchemaLocation,
  parse: (content: string) => unknown,
): AtomReader {
  return {
    isAtomReader: true,
    *read(ctx: JsonReadContext): Task<unknown> {
      ctx = ctx.underDeclaration(schemaLocation);
      const event = yield* ctx.next();
      const content = contentOf(form, event);
      if (content === undefined) {
        yield* reportUnreadable(ctx, displayName, event, () => {
          reportWrongForm(ctx, displayName, form, event);
        });
        return undefined;
      }
      if (
        form === 'number-or-string' &&
        event.kind === 'string' &&
        !isApproximateStringForm(content)
      ) {
        ctx.report(
          'ATOM_FORM_INVALID',
          `'${content}' is a string at an approximate-numeric position, and [TSON-JSON] §5.4 ` +
            'confines string content there to .inf/-.inf/.nan or a hex-float',
          'a special-value (.inf/-.inf/.nan) or hex-float string',
          `'${content}'`,
        );
        return undefined;
      }
      try {
        return parse(content);
      } catch (error) {
        if (error instanceof TsonAtomParseError || error instanceof TsonAtomValidationError) {
          ctx.report(diagnosticCodeForAtomError(error), error.message, error.expected, content);
          return undefined;
        }
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// void, value, identifier -- the kernel's three `unit` instances (§5.7), dispatched by name
// ---------------------------------------------------------------------------------------------

/** §5.7: `void`'s sole value is absence, and JSON null is its one spelling. */
export function voidReader(
  displayName: string,
  schemaLocation: SchemaLocation,
): JsonTypeReader<JsonValue> {
  return {
    *read(ctx: JsonReadContext): Task<JsonValue | undefined> {
      ctx = ctx.underDeclaration(schemaLocation);
      const event = yield* ctx.next();
      if (event.kind === 'null') return jsonNull();
      yield* reportUnreadable(ctx, displayName, event, () => {
        ctx.report(
          'TYPE_MISMATCH',
          `'${displayName}' admits only the absent sentinel, spelled null, and this is ${describeEvent(event)}`,
          'null',
          describeEvent(event),
        );
      });
      return undefined;
    },
  };
}

/**
 * §5.7: `value` admits boolean, number, or string, classified by JSON's own grammar -- a number
 * with no fraction or exponent is an integer, one with either a float, and a string's content is
 * uninspected. No base-type-resolution detour: JSON's forms are not overloaded the way unquoted
 * tokens are, so `"null"` is simply the four-character string.
 */
export function valuePositionReader(
  displayName: string,
  schemaLocation: SchemaLocation,
): JsonTypeReader {
  return {
    *read(ctx: JsonReadContext): Task<unknown> {
      ctx = ctx.underDeclaration(schemaLocation);
      const event = yield* ctx.next();
      switch (event.kind) {
        case 'boolean':
          return event.value;
        case 'string':
          return event.value;
        case 'number': {
          const form = tryParseNumber(event.literal);
          if (form === undefined) {
            throw new Error(
              `'${event.literal}' is a JSON number literal that this package's own number grammar ` +
                'does not accept -- the JSON lexer and base/numberGrammar.ts disagree, which is a ' +
                'library bug',
            );
          }
          if (form.kind === 'integer' || form.kind === 'based-integer') {
            return toExactInteger(form);
          }
          if (form.kind === 'float') {
            return toExactDecimal(form);
          }
          // A JSON number literal can never parse to the special-value form (`.inf`/`.nan` have
          // no JSON number spelling, §5.4) -- the lexer's own grammar already rules this out, so
          // reaching here is a library bug rather than a document problem.
          throw new Error(
            `'${event.literal}' parsed as ${form.kind}, which a JSON number literal cannot be`,
          );
        }
        default:
          yield* reportUnreadable(ctx, displayName, event, () => {
            ctx.report(
              'TYPE_MISMATCH',
              `'${displayName}' admits a boolean, number or string, and this is ${describeEvent(event)}`,
              'a boolean, number or string',
              describeEvent(event),
            );
          });
          return undefined;
      }
    },
  };
}

/** This encoding's own reading of `identifier`, since `atom/forType.ts` offers no parser for it (its own top note: "neither does `unit`'s `value`/`token` instance"): a JSON string whose content is a well-formed identifier (§7.7). */
export function identifierReader(displayName: string, schemaLocation: SchemaLocation): AtomReader {
  return makeAtomReader(displayName, 'string', schemaLocation, (content) => {
    if (!isIdentifierText(content)) {
      throw new TsonAtomParseError(
        displayName,
        `'${content}' is not a well-formed identifier (§7.7)`,
        'an identifier',
      );
    }
    return content;
  });
}

// ---------------------------------------------------------------------------------------------
// Tree mode's wrapping -- the JSON node the document carried, validated but not decoded
// ---------------------------------------------------------------------------------------------

/** `event`'s own node -- the four leaves and null (`json/schema/atoms.ts`'s own port of the Java reference's `Nodes.scalar`). `undefined` for a composite opener. */
export function scalarNodeOf(event: JsonEvent): JsonValue | undefined {
  switch (event.kind) {
    case 'string':
      return jsonString(event.value);
    case 'number':
      return jsonNumber(event.literal);
    case 'boolean':
      return jsonBoolean(event.value);
    case 'null':
      return jsonNull();
    default:
      return undefined;
  }
}

/**
 * Tree mode's atom position (§7.2's "a schema-directed tree read hands back JSON, not TSON"): the
 * family's parser runs -- which is the validation -- and the JSON value comes back unchanged. A
 * refused value yields no node (all-or-nothing).
 */
export function treeAtomReader(delegate: JsonTypeReader): JsonTypeReader<JsonValue> {
  return {
    *read(ctx: JsonReadContext): Task<JsonValue | undefined> {
      const event = yield* ctx.peek();
      const node = scalarNodeOf(event);
      const before = ctx.reported();
      yield* delegate.read(ctx);
      return node === undefined || ctx.reported() > before ? undefined : node;
    },
  };
}

/**
 * Tree mode's atom as a set's element (`json/schema/array.ts`): the node {@link treeAtomReader}
 * would yield, with the parsed value's {@link identityOfHost} identity beside it -- what a set's
 * duplicate check judges on, since two spellings of one value (`1`/`1.0`) are one element.
 */
export function treeAtomKeyedReader(delegate: JsonTypeReader): JsonTypeReader<Identified> {
  return {
    *read(ctx: JsonReadContext): Task<Identified | undefined> {
      const event = yield* ctx.peek();
      const node = scalarNodeOf(event);
      const before = ctx.reported();
      const value = yield* delegate.read(ctx);
      if (node === undefined || ctx.reported() > before) return undefined;
      return { node, identity: identityOfHost(value) };
    },
  };
}
