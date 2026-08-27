/**
 * The [TSON-DATA] `annotation`/`data-value`/`core-value` productions (§2.3-§2.9, §3.1, §7.4),
 * reimplemented directly over {@link CursorState} for the schema grammar to import at exactly
 * the one point §12.1 says it does -- the constructor-application payload (`instance`, §5.5).
 *
 * Builds `ast/value.ts` nodes straight from the token cursor rather than through the streaming
 * `stream/event.ts`/`stream/dataStream.ts` machinery: an `instance` payload is read whole as
 * part of building the (already fully materialised) schema AST, so there is no laziness to
 * preserve here the way there is for a top-level data document of unbounded size. The grammar
 * itself -- record/map `{}` disambiguation (§2.8), annotations, type-refs, scoped-values -- is
 * the same grammar `dataStream.ts` walks; this module is a second, independent walk of it
 * because `dataStream.ts`'s entry point owns a whole document's header and rejects `!!meta`
 * outright, which a schema document's `instance` payload is nested many levels inside of.
 */

import type { Task } from '../io/bytes.js';
import { adjacentTo } from '../lexer/token.js';
import type {
  AbsentValue,
  Annotation,
  ArrayValue,
  CoreValue,
  DataValue,
  EmptyBrace,
  MapEntry,
  MapValue,
  RecordField,
  RecordValue,
  ScopedValue,
  TokenValue,
} from '../ast/value.js';
import {
  advance,
  check,
  consumeSeparatorOrCloseCheck,
  type CursorState,
  describe,
  expect,
  expectFieldNameToken,
  isAlwaysMapStart,
  isBareTokenType,
  parseError,
  parseNamedDirective,
  peekDirectiveName,
  peekSecond,
  peekToken,
  tokenFormOf,
} from './cursor.js';

/** `*annotation` (§3.1). */
export function* parseAnnotationList(state: CursorState): Task<Annotation[]> {
  const annotations: Annotation[] = [];
  while (yield* check(state, 'at')) {
    annotations.push(yield* parseAnnotation(state));
  }
  return annotations;
}

/** `"@" unquoted-token [ ":" data-value ]` (§3.1). */
export function* parseAnnotation(state: CursorState): Task<Annotation> {
  const at = yield* advance(state);
  const name = yield* peekToken(state);
  if (name.type !== 'unquoted-token') {
    throw parseError(name, `expected an annotation name after '@', found ${describe(name)}`);
  }
  if (!adjacentTo(at, name)) {
    throw parseError(
      name,
      "'@' must be immediately adjacent to the annotation name (no whitespace)",
    );
  }
  yield* advance(state); // name

  const afterName = yield* peekToken(state);
  if (afterName.type === 'colon' && adjacentTo(name, afterName)) {
    yield* advance(state); // ':'
    const value = yield* parseDataValue(state);
    return { name: name.text, value };
  }

  // Valueless: at least one whitespace character MUST follow the annotation name (§3.1).
  if (adjacentTo(name, afterName)) {
    throw parseError(
      afterName,
      `expected whitespace after annotation name '${name.text}' (or an adjacent ':' to give it a value)`,
    );
  }
  return { name: name.text };
}

/** `*annotation [type-ref] core-value` (§2.3). */
export function* parseDataValue(state: CursorState): Task<DataValue> {
  const annotations = yield* parseAnnotationList(state);
  let typeRef: string | undefined;
  if (yield* check(state, 'bang')) {
    typeRef = yield* parseDataTypeRefName(state);
  }
  const coreValue = yield* parseCoreValue(state);
  return {
    annotations,
    ...(typeRef !== undefined ? { typeRef } : {}),
    coreValue,
  };
}

/**
 * `"!" unquoted-token` (§3.2) -- a *data*-value type-ref, rejecting the schema-only type
 * expression forms (array brackets, `<...>`, `?`) that have no role here: the payload this
 * module builds is a nested value inside a schema's own `instance` production, but that value
 * is ordinary data-grammar content once inside it, not more schema syntax.
 */
function* parseDataTypeRefName(state: CursorState): Task<string> {
  const bang = yield* advance(state);
  const name = yield* peekToken(state);
  if (name.type !== 'unquoted-token') {
    if (name.type === 'lbracket' && adjacentTo(bang, name)) {
      throw parseError(
        name,
        "'![...]' writes an array type, which is schema syntax and not available in a data value " +
          "(§3.2); write the array itself, or name the type in the schema ('my_type => [...]') and " +
          "write '!my_type' here",
      );
    }
    throw parseError(name, `expected a type name after '!', found ${describe(name)}`);
  }
  if (!adjacentTo(bang, name)) {
    throw parseError(name, "'!' must be immediately adjacent to the type name (no whitespace)");
  }
  yield* advance(state); // name

  const next = yield* peekToken(state);
  if (next.type === 'less-than') {
    throw parseError(
      next,
      `'!${name.text}<...>' applies type arguments, which is schema syntax and not available in a ` +
        `data value (§3.2): a data type-ref is a bare name. Name the application in the schema ` +
        `('my_type => ${name.text}<...>') and write '!my_type' here`,
    );
  }
  if (next.type === 'question' && adjacentTo(name, next)) {
    throw parseError(
      next,
      `'!${name.text}?' uses the optional suffix, which is schema syntax and not available in a ` +
        `data value (§3.2): optionality is a field's state where the schema declares it, and a ` +
        `value that is absent is written '_' (§2.9)`,
    );
  }
  if (!isStructuralDelimiter(next.type) && adjacentTo(name, next)) {
    throw parseError(
      next,
      `expected whitespace after type name '${name.text}' before ${describe(next)}`,
    );
  }
  return name.text;
}

function isStructuralDelimiter(type: string): boolean {
  switch (type) {
    case 'lbrace':
    case 'rbrace':
    case 'lbracket':
    case 'rbracket':
    case 'colon':
    case 'comma':
      return true;
    default:
      return false;
  }
}

/** `record / map / array / empty-brace / absent / token` (§2.3, §7.4). */
export function* parseCoreValue(state: CursorState): Task<CoreValue> {
  const t = yield* peekToken(state);
  switch (t.type) {
    case 'lbrace':
      return yield* parseBraceValue(state);
    case 'lbracket': {
      yield* advance(state);
      return yield* parseArrayTail(state);
    }
    case 'absent-token':
      yield* advance(state);
      return { kind: 'absent' } satisfies AbsentValue;
    case 'unquoted-token':
    case 'single-line-token':
    case 'multi-line-token':
      yield* advance(state);
      return { kind: 'token', text: t.text, form: tokenFormOf(t.type) } satisfies TokenValue;
    default:
      throw parseError(
        t,
        `expected a value (record, map, array, empty braces, the absent sentinel '_', or a token), ` +
          `found ${describe(t)}`,
      );
  }
}

/** `"[" ws [ scoped-value *( separator scoped-value ) ] ws "]"` (§2.7), with `[` already consumed. */
function* parseArrayTail(state: CursorState): Task<ArrayValue> {
  const elements: ScopedValue[] = [];
  if (!(yield* check(state, 'rbracket'))) {
    elements.push(yield* parseScopedValue(state));
    while (yield* consumeSeparatorOrCloseCheck(state, 'rbracket')) {
      elements.push(yield* parseScopedValue(state));
    }
  }
  yield* expect(state, 'rbracket', "an array's closing ']'");
  return { kind: 'array', elements };
}

/** The one place `{}` disambiguation happens (§2.8): record vs. map vs. empty-brace. */
function* parseBraceValue(state: CursorState): Task<RecordValue | MapValue | EmptyBrace> {
  yield* advance(state); // '{'
  const t1 = yield* peekToken(state);

  if (t1.type === 'rbrace') {
    yield* advance(state);
    return { kind: 'empty-brace' };
  }

  if (isAlwaysMapStart(t1.type)) {
    const firstKey = yield* parseDataValue(state);
    return yield* parseMapTail(state, firstKey);
  }

  if (isBareTokenType(t1.type)) {
    const t2 = yield* peekSecond(state);
    if (t2.type === 'colon') {
      yield* advance(state); // field-name token
      yield* advance(state); // ':'
      const value = yield* parseScopedValue(state);
      return yield* parseRecordTail(state, [{ name: t1.text, value }]);
    }
    if (t2.type === 'map-arrow-token') {
      yield* advance(state); // key token
      yield* advance(state); // '=>'
      const key: DataValue = {
        annotations: [],
        coreValue: { kind: 'token', text: t1.text, form: tokenFormOf(t1.type) },
      };
      const value = yield* parseScopedValue(state);
      return yield* parseMapTail(state, key, [{ key, value }]);
    }
    throw parseError(
      t1,
      `a value inside curly braces must be followed by ':' (record) or '=>' (map), found ${describe(t2)}`,
    );
  }

  throw parseError(
    t1,
    `expected a value (record, map, array, empty braces, the absent sentinel '_', or a token), ` +
      `found ${describe(t1)}`,
  );
}

function* parseRecordTail(state: CursorState, fields: RecordField[]): Task<RecordValue> {
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbrace')) {
    const name = yield* expectFieldNameToken(state, 'a record field name');
    yield* expect(state, 'colon', "a record field's ':'");
    const value = yield* parseScopedValue(state);
    fields.push({ name: name.text, value });
  }
  yield* expect(state, 'rbrace', "a record's closing '}'");
  return { kind: 'record', fields };
}

/** `firstEntry` is supplied when the first key was a bare token already reduced to a `DataValue`; otherwise `firstKey` alone seeds the loop. */
function* parseMapTail(
  state: CursorState,
  firstKey: DataValue,
  firstEntry?: MapEntry[],
): Task<MapValue> {
  const entries = firstEntry ?? [];
  if (firstEntry === undefined) {
    yield* expect(state, 'map-arrow-token', "a map entry's '=>'");
    const value = yield* parseScopedValue(state);
    entries.push({ key: firstKey, value });
  }
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbrace')) {
    const key = yield* parseDataValue(state);
    yield* expect(state, 'map-arrow-token', "a map entry's '=>'");
    const value = yield* parseScopedValue(state);
    entries.push({ key, value });
  }
  yield* expect(state, 'rbrace', "a map's closing '}'");
  return { kind: 'map', entries };
}

/** `[ schema-directive ws ] data-value` (§2.3): a record field value, map entry value, or array element. */
export function* parseScopedValue(state: CursorState): Task<ScopedValue> {
  let schemaRef: string | undefined;
  if (yield* check(state, 'directive-token')) {
    const bangbang = yield* peekToken(state);
    const name = yield* peekDirectiveName(state);
    if (name !== 'schema') {
      const second = yield* peekSecond(state);
      const label = name ?? describe(second);
      throw parseError(
        bangbang,
        `directive '!!${label}' is not permitted here (only '!!schema' is)`,
      );
    }
    schemaRef = yield* parseNamedDirective(state, 'schema');
  }
  const value = yield* parseDataValue(state);
  return { ...(schemaRef !== undefined ? { schemaRef } : {}), value };
}
