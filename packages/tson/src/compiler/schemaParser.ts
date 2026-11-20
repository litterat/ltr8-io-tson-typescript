/**
 * The schema grammar (Part 2 §5, §12.1): parses a schema document's body into a
 * {@link SchemaDocument} faithfully -- no composition, no refinement, no constructor
 * application, no desugaring. A schema document that is grammatically well-formed but
 * semantically nonsense parses cleanly here and fails at a later phase, because that is where
 * §8's diagnostics belong and where the conformance vectors expect them (see this module's own
 * top-level Javadoc equivalent in the Java reference, `TsonSchemaParser`).
 *
 * §12.1 states the schema grammar imports [TSON-DATA]'s grammar at exactly one point -- the
 * constructor-application payload, a `core-value` (§5.5-§5.6) -- and no production here uses the
 * full `data-value`: an atom-refinement body is a braced `record-def` (§5.5, not a `core-value`;
 * see {@link parseAtomRefinementOrInstance}'s own note), and a field-modifier value is a bare
 * token or the void sentinel (§5.2), never annotations, a type-ref, or a container.
 *
 * Built directly over {@link CursorState} (a raw, two-token-lookahead cursor over the shared
 * lexer) rather than through `stream/dataStream.ts`'s data-document event source: a schema
 * document's header shape and body grammar are both different productions from a data
 * document's, and the schema grammar additionally needs raw access to operators (`~ ^ & | ( ) <
 * > ? ; -`) that data-grammar event stream never models. `dataValueGrammar.ts` supplies the one
 * data-grammar production this file imports (`instance`'s `core-value` payload).
 *
 * Fail-fast only: the first syntax error anywhere in the document throws a {@link
 * TsonParseError}. The Java reference implementation additionally offers a
 * diagnostics-collecting, panic-mode-recovery entry point that reports every declaration's
 * syntax error in one pass; that mode depends on a schema-syntax {@link DiagnosticCode} this
 * port's frozen `core/diagnostic.ts` does not yet declare, and belongs with the rest of
 * schema-side diagnostics reporting (resolution, linking) rather than the grammar-only parser --
 * see this package's own STRUCTURED-OUTPUT note.
 */

import { TsonParseError } from '../core/errors.js';
import type { Position } from '../core/position.js';
import type { ByteInput, Task } from '../io/bytes.js';
import { adjacentTo, type Token, type TokenForm } from '../lexer/token.js';
import type { Annotation, DataValue, TokenValue } from '../ast/value.js';
import type { Declaration, SchemaDocument, SchemaMap } from '../ast/schema/document.js';
import type {
  AtomRefinement,
  FieldDef,
  FieldModifier,
  GroupDef,
  GroupMember,
  GroupQuantifier,
  Instance,
  RecordEntry,
  RemovalSet,
  SizeSpec,
} from '../ast/schema/fields.js';
import type {
  ConstructionDef,
  RecordDef,
  SchemaMapDef,
  StructuralTypeDef,
  TypeDef,
  TypeExprDef,
} from '../ast/schema/typedef.js';
import type {
  ArrayExpr,
  ChoiceExpr,
  DependentType,
  ElementType,
  FieldTypeExpr,
  MapExpr,
  RecordExpr,
  TupleExpr,
  TypeExpr,
  TypeRef,
} from '../ast/schema/typeref.js';
import {
  advance,
  check,
  consumeSeparatorOrCloseCheck,
  createCursor,
  type CursorState,
  describe,
  expect,
  expectFieldNameToken,
  mismatch,
  parseError,
  nested,
  peekSecond,
  peekToken,
} from './cursor.js';
import type { NestingLimitOptions } from '../core/limits.js';
import { parseAnnotationList, parseCoreValue } from './dataValueGrammar.js';
import { parseHeader, parseTypeRefName, requireQualifiedName } from '../stream/dataStream.js';
import { isSiblingField } from '../atom/referenceGrammar.js';
import { tryParseNumber } from '../base/numberGrammar.js';
import { isIdentifierText } from '../unicode/identifier-profile.js';

/**
 * Parses a whole schema document (§2.1-§2.2, §12.1) from `input`, fail-fast: the first syntax
 * error anywhere throws {@link TsonParseError}. `input` need not be complete -- like every
 * generator-returning entry point in this stack, drive the returned {@link Task} with `runSync`
 * (complete input) or `runAsync` (chunked input), per `io/bytes.ts`.
 */
export function* parseSchemaDocument(
  input: ByteInput,
  options?: NestingLimitOptions,
): Task<SchemaDocument> {
  const state = createCursor(input, options);
  return yield* parseDocumentBody(state);
}

/**
 * The kernel root's `schema`, the tag of a schema document's root and of a schema map nested as an
 * entry, and its target by path (§2.1, §4.1). Matched as a spelling: which grammar the payload takes
 * is settled before any name is looked up, so no declaration of the document can capture it.
 */
const SCHEMA_TAG = 'schema';
const SCHEMA_TARGET = 'meta.schema';

/** What one parse threads through its declarations: the document's one declaration map, and the path prefix of the map being read. */
interface SchemaParse {
  readonly declarations: Map<string, Declaration>;
  /** The path of the schema map whose members are being read, with its trailing dot; `''` at the root. */
  prefix: string;
}

function* parseDocumentBody(state: CursorState): Task<SchemaDocument> {
  // §2.2's header is the data grammar's, one production for both kinds of document. What differs is
  // the verdict, which is this parser's: a schema document's root is tagged `!schema`.
  const { id, imports } = yield* parseHeader(state);

  const body = yield* parseSchemaMap(state);

  if (!(yield* check(state, 'eof'))) {
    const here = yield* peekToken(state);
    throw parseError(here, `unexpected content after the schema map: ${describe(here)}`);
  }
  return { ...(id !== undefined ? { id } : {}), imports, body };
}

// ── Schema Map (§2.1, §12.1) ────────────────────────────────────────────

function* parseSchemaMap(state: CursorState): Task<SchemaMap> {
  const annotations = yield* parseAnnotationList(state);
  yield* expectSchemaTag(state);
  const parse: SchemaParse = { declarations: new Map<string, Declaration>(), prefix: '' };
  yield* parseMembers(state, parse);
  return { annotations, declarations: parse.declarations };
}

/**
 * The root's `!schema` tag ([TSON-DATA] §2.2): what makes the document a schema. A document without it
 * is data, and handing one to the schema parser is a syntax error naming the rule.
 */
function* expectSchemaTag(state: CursorState): Task<void> {
  if (!(yield* check(state, 'bang'))) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      `a schema document's root is tagged '!${SCHEMA_TAG}' ([TSON-DATA] §2.2); this document's root ` +
        'is not, which makes it a data document',
    );
  }
  const here = yield* peekToken(state);
  const name = yield* parseTypeRefName(state);
  if (name !== SCHEMA_TAG) {
    throw parseError(
      here,
      `a schema document's root is tagged '!${SCHEMA_TAG}' ([TSON-DATA] §2.2), found '!${name}'`,
    );
  }
}

/**
 * A schema map's braced members, from its opening `'{'` to its closing `'}'`, each put into the
 * document's one declaration map under the current prefix plus its own name: the root's under their
 * names, a nested map's under their paths ({@link SchemaMapDef}). Returns the members' own names in the
 * order written.
 */
function* parseMembers(state: CursorState, parse: SchemaParse): Task<[string, ...string[]]> {
  yield* expect(state, 'lbrace', "a schema map's opening '{'");
  if (yield* check(state, 'rbrace')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "a schema map requires at least one declaration; '{}' is not permitted here (§2.1)",
    );
  }
  const prefix = parse.prefix;
  const first = yield* parseDeclaration(state, parse);
  const members: [string, ...string[]] = [first.name.slice(prefix.length)];
  parse.declarations.set(first.name, first);
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbrace')) {
    const next = yield* parseDeclaration(state, parse);
    parse.declarations.set(next.name, next);
    members.push(next.name.slice(prefix.length));
  }
  yield* expect(state, 'rbrace', "a schema map's closing '}'");
  return members;
}

function* parseDeclaration(state: CursorState, parse: SchemaParse): Task<Declaration> {
  const nameAnnotations = yield* parseAnnotationList(state);
  // Inlines `expectTypeName` (rather than calling it) so this site alone keeps the name token's
  // own `.start` -- the declaration's `position` (`ast/schema/document.ts`'s own note on why).
  const nameToken = yield* expect(state, 'unquoted-token', 'a declaration name');
  requireIdentifierName(nameToken.text, nameToken.start);
  const prefix = parse.prefix;
  const name = prefix + nameToken.text;
  yield* expect(state, 'map-arrow-token', "a declaration's '=>'");
  const typeDefAnnotations = yield* parseAnnotationList(state);
  const markToken = yield* peekToken(state);
  const mark = yield* parseDefinitionMarkOpt(state);
  const parameterTypes = new Map<string, TypeExpr>();
  parse.prefix = `${name}.`;
  const typeDef = yield* parseTypeDef(state, parameterTypes, parse, mark);
  parse.prefix = prefix;
  if (mark !== undefined && typeDef.kind !== 'structuralTypeDef') {
    throw parseError(
      markToken,
      `'${mark}' marks a record definition -- a record body, a composition or a subtraction -- and none ` +
        'follows it (§5.2, §12.1)',
    );
  }
  return {
    nameAnnotations,
    name,
    typeDefAnnotations,
    typeDef,
    ...(parameterTypes.size > 0 ? { parameterTypes } : {}),
    position: nameToken.start,
  };
}

/**
 * `[ definition-mark ws ]` (§12.1, §5.2): `abstract`/`final`, read UNCONDITIONALLY at this one
 * slot -- `pet => abstract base & { ... }` is a marked composition, not a reference to a type
 * named `base` applied to `abstract`. The two words are ordinary identifiers everywhere else
 * ([TSON-DATA] §7.7); what cannot be written is a declaration whose whole type-def is the bare
 * word, which {@link parseTypeDef} then fails to parse (nothing valid follows the consumed mark),
 * surfacing as "a declaration missing its definition".
 */
function* parseDefinitionMarkOpt(state: CursorState): Task<'abstract' | 'final' | undefined> {
  if (!(yield* check(state, 'unquoted-token'))) return undefined;
  const t = yield* peekToken(state);
  if (t.type !== 'unquoted-token' || (t.text !== 'abstract' && t.text !== 'final'))
    return undefined;
  const mark = t.text;
  yield* advance(state);
  const next = yield* peekToken(state);
  if (next.type === 'unquoted-token' && (next.text === 'abstract' || next.text === 'final')) {
    throw parseError(
      next,
      `'${mark}' and '${next.text}' on one declaration -- a record states how it may be realised once, ` +
        'and the marks are alternatives rather than companions (§5.2)',
    );
  }
  if (next.type === 'unquoted-token' && (yield* peekSecond(state)).type === 'map-arrow-token') {
    throw missingDefinition(next, mark);
  }
  return mark;
}

/**
 * A declaration that wrote a mark and then no type definition. The mark is the reading, so the diagnostic
 * names what the author most likely meant instead: the one thing the two words give up at this position.
 */
function missingDefinition(at: Token, mark: 'abstract' | 'final'): TsonParseError {
  return parseError(
    at,
    `'${mark}' here marks how the type that follows may be realised (§5.2), and no definition follows -- ` +
      `a type or parametric record named '${mark}' may be declared and referenced anywhere else, but not ` +
      'named as a whole declaration body',
  );
}

/** Whether the cursor is on a token that can open a `type-def` (§12.1) -- the five alternatives' heads. */
function* startsTypeDef(state: CursorState): Task<boolean> {
  return (
    (yield* check(state, 'bang')) ||
    (yield* check(state, 'lbrace')) ||
    (yield* check(state, 'lparen')) ||
    (yield* check(state, 'lbracket')) ||
    (yield* check(state, 'unquoted-token'))
  );
}

// ── Type Definitions (§5, §12.1) ────────────────────────────────────────

function* parseTypeDef(
  state: CursorState,
  parameterTypes: Map<string, TypeExpr>,
  parse: SchemaParse,
  mark: 'abstract' | 'final' | undefined,
): Task<TypeDef> {
  // The parameter list comes first, so one token then decides the alternative: `!` with no
  // parameters is an instance or an atom refinement, `!` with parameters an instance carrying them
  // (§12.1). `<` only ever starts a parameter list, so consuming it costs no lookahead.
  const typeParams = yield* parseTypeParamsOpt(state, parameterTypes);
  if (mark !== undefined && !(yield* startsTypeDef(state))) {
    // Reached both by a bare `pet => abstract` and by `pet => abstract<text>`, which applies a
    // parametric record of that name: what separates them is whether a definition follows.
    throw missingDefinition(yield* peekToken(state), mark);
  }

  if (yield* check(state, 'bang')) {
    return yield* parseAtomRefinementOrInstance(state, typeParams, parse);
  }
  if (yield* check(state, 'tilde')) {
    // §12.1: "there is no constructor marker: an entry is a constructor by being IS-A `top`
    // (§4.2), and `~` is a special token with no role at type-def position." `~` keeps exactly
    // one grammar role, the field-modifier default-value marker (§5.2) -- a source document
    // that writes one here (`class2/schema/invalid/a-constructor-marker-is-not-grammar`) fails
    // here rather than being silently read as a type-def marker, since the grammar has none.
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "'~' has no role at type-def position (§4.2, §12.1) -- an entry is a constructor by " +
        "composing or refining IS-A 'top', never by a marker; '~' is otherwise the field-modifier " +
        "default-value operator ('port: integer ~ 8080', §5.2)",
    );
  }
  if (yield* check(state, 'lbrace')) {
    return yield* braceTypeDef(state, typeParams, mark);
  }
  if (yield* check(state, 'lparen')) {
    return {
      kind: 'typeExprDef',
      typeParams,
      ref: yield* parseTypeExpr(state),
    } satisfies TypeExprDef;
  }
  if (yield* check(state, 'lbracket')) {
    return {
      kind: 'typeExprDef',
      typeParams,
      ref: yield* parseBracket(state),
    } satisfies TypeExprDef;
  }

  const head = yield* parseTypeRefHead(state);
  if (yield* check(state, 'caret')) {
    // `refined-def` is gone (§12.1): `^` follows `!name` and takes values, and a record is derived by
    // composition alone.
    const written = head.kind === 'nameRef' ? head.name : `${head.name}<...>`;
    throw parseError(
      yield* peekToken(state),
      `'^' follows '!name' and takes values (§5.5, §5.7), and '${written}' has no '!': a record's ` +
        `fields are restated in a composition, '${written} & { ... }' (§5.8)`,
    );
  }
  if ((yield* check(state, 'ampersand')) || (yield* check(state, 'minus'))) {
    return {
      kind: 'structuralTypeDef',
      ...(mark !== undefined ? { mark } : {}),
      typeParams,
      body: yield* parseConstructionDefContinuation(state, head),
    } satisfies StructuralTypeDef;
  }
  if (yield* check(state, 'lbrace')) {
    const here = yield* peekToken(state);
    throw parseError(here, "expected '&' (composition) after a bare type-ref, found '{'");
  }
  return { kind: 'typeExprDef', typeParams, ref: head } satisfies TypeExprDef;
}

/** A brace at a type-def position: a record body is the declaration's structural-def, a map its type-expr. */
function* braceTypeDef(
  state: CursorState,
  typeParams: readonly string[],
  mark: 'abstract' | 'final' | undefined,
): Task<TypeDef> {
  const form = yield* parseBraceType(state);
  if (form.kind === 'recordExpr') {
    return {
      kind: 'structuralTypeDef',
      ...(mark !== undefined ? { mark } : {}),
      typeParams,
      body: form.body,
    } satisfies StructuralTypeDef;
  }
  return { kind: 'typeExprDef', typeParams, ref: form } satisfies TypeExprDef;
}

/**
 * §12.2's brace dispatch, one rule at every position a brace opens a type (`brace-type = map-type /
 * record-def`): a record body or the map sugar. The token is consumed and the decision made on what
 * follows -- the consume-one-then-inspect idiom [TSON-DATA] §2.8 fixes for the data grammar's own brace,
 * within the same budget of one consumed token plus one of lookahead. A brace or bracket after the brace
 * opens neither, a map's key being a name.
 */
function* parseBraceType(state: CursorState): Task<MapExpr | RecordExpr> {
  yield* expect(state, 'lbrace', "a record body's or map type's opening '{'");
  if ((yield* check(state, 'lbrace')) || (yield* check(state, 'lbracket'))) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      `a map type's key is a type name (§5.3), and ${describe(here)} opens a type written in place, ` +
        'which no key is: declare the key type under a name and write that name',
    );
  }
  if (yield* braceOpensMap(state)) {
    return yield* parseMapBody(state);
  }
  return { kind: 'recordExpr', body: yield* parseRecordBody(state) };
}

/** The dispatch decision itself, with the `'{'` already consumed -- see {@link parseBraceType}. */
function* braceOpensMap(state: CursorState): Task<boolean> {
  if (!(yield* check(state, 'unquoted-token'))) return false;
  const first = yield* peekToken(state);
  const second = yield* peekSecond(state);
  // An adjacent `!` commits to a map too, so the key refuses `kind!` by name (§12.2).
  return (
    second.type === 'map-arrow-token' ||
    second.type === 'less-than' ||
    (second.type === 'bang' && adjacentTo(first, second))
  );
}

/**
 * `"!" qualified-name` and what follows it: a nested schema map (`"!schema" ws schema-map`), an atom
 * refinement (`^`) or a constructor application (a core-value). The `!` is adjacent to the name, which
 * is a qualified name (§3.2); a tag is `"!" qualified-name` and never a reference to a field.
 */
function* parseAtomRefinementOrInstance(
  state: CursorState,
  typeParams: readonly string[],
  parse: SchemaParse,
): Task<TypeDef> {
  const bang = yield* expect(
    state,
    'bang',
    "an atom refinement or constructor application ('!name')",
  );
  const name = yield* peekToken(state);
  if (name.type !== 'unquoted-token') {
    throw mismatch('a type name immediately after !', name);
  }
  if (!adjacentTo(bang, name)) {
    const here = yield* peekToken(state);
    throw parseError(here, "'!' must be immediately adjacent to the type name (no whitespace)");
  }
  yield* advance(state);
  requireQualifiedName(name, 'type', '§12.1');
  const target = name.text;
  const afterName = yield* peekToken(state);
  if (afterName.type === 'bang' && adjacentTo(name, afterName)) {
    throw parseError(
      afterName,
      `'!${target}!' marks a type's name as a sibling reference, and a tag names a type ` +
        "([TSON-DATA] §7.4): a tag is '!' and a qualified name, never a reference to a field",
    );
  }

  // A nested schema map is tagged `!schema`, the kernel root's alias the root's tag names, or by
  // its target's path, `!meta.schema`, as resolved output writes it: one grammar for both.
  if ((target === SCHEMA_TAG || target === SCHEMA_TARGET) && (yield* check(state, 'lbrace'))) {
    if (typeParams.length > 0) {
      throw parseError(
        afterName,
        `'!${SCHEMA_TAG} { ... }' is a schema map nested as an entry, a value, and takes no type parameters`,
      );
    }
    const members = yield* parseMembers(state, parse);
    return { kind: 'schemaMapDef', members } satisfies SchemaMapDef;
  }

  if (yield* check(state, 'caret')) {
    // §12.1 gives `atom-refinement` no parameter list: a refinement of an atom instance has no
    // parameter to take, so the two forms are told apart here rather than by a production of
    // their own.
    if (typeParams.length > 0) {
      const here = yield* peekToken(state);
      throw parseError(
        here,
        "a parameterized atom refinement is not a type-def (§12.1): '^' takes no type " +
          'parameters, since a refinement of an atom instance has none to bind',
      );
    }
    yield* advance(state);
    // atom-refinement = "!" type-name ws "^" ws record-def (§12.1) -- a braced record of
    // constraint bindings, and nothing wider: §12.1 fixes this payload to `record-def`, tighter
    // than `instance`'s `core-value` (a refinement body is always braced constraint bindings,
    // never a positional form), so this reads it with the schema grammar's own record-def
    // production rather than the imported data-grammar core-value.
    if (!(yield* check(state, 'lbrace'))) {
      const here = yield* peekToken(state);
      throw mismatch(
        "'{' -- an atom refinement's body is a braced record of constraint bindings (§5.5), " +
          'never a bare value, a second type-ref or an annotation',
        here,
      );
    }
    // A data core-value, not the schema `record-def` production. The braces hold constraint
    // *values* — ordinary data, nested records included — and parsing them as type definitions
    // rejects every real refinement, `spec/m/core.tn` included. The reference does the same:
    // `new AtomRefinement(target, new DataValue(List.of(), Optional.empty(), parseCoreValue()))`.
    return {
      kind: 'atomRefinement',
      target,
      bindings: { annotations: [], coreValue: yield* parseCoreValue(state) },
    } satisfies AtomRefinement;
  }
  // instance = [type-params] "!" type-name ws core-value (§12.1) -- the constructor name goes
  // straight into the wrapping DataValue's own typeRef; there is no room in this production for
  // the payload to carry further annotations or a second, competing type-ref. A parameter list is
  // parsed here and judged where the declaration resolves: before a construction it is the explicit
  // spelling of a parametric record, `<T> !meta.record { … }`, and before any other a resolver error
  // (§5.10).
  const value: DataValue = {
    annotations: [],
    typeRef: target,
    coreValue: yield* parseCoreValue(state),
  };
  return { kind: 'instance', typeParams, value } satisfies Instance;
}

/**
 * Supertype chain, trailing body, and removal set (§5.8, §5.9). `first` is already consumed. On
 * each `&`, one token of lookahead decides whether `{` terminates the chain as the trailing body
 * or another supertype follows.
 *
 * Every operand after `first` is read with {@link parseSupertypeRef} rather than the general
 * {@link parseTypeRef} -- §12.1's own `supertype-ref = type-name [ws "<" type-args ">"]`
 * restricts a composition/subtraction operand to a bare type-name, optionally with type
 * arguments, never a paren/bracket/map form (§4.3, §5.8), and `ast/schema/typedef.ts`'s own
 * `ConstructionDef` Javadoc places the obligation to enforce that restriction on this parser
 * (`supertypes` is typed as plain `TypeRef` because every variant satisfies the field
 * structurally). This is a deliberate correction of the Java reference, which reads every
 * operand after the first with the unrestricted `parseTypeRef()` -- see this port's own
 * spec-feedback notes.
 */
function* parseConstructionDefContinuation(
  state: CursorState,
  first: TypeRef,
): Task<ConstructionDef> {
  const supertypes: TypeRef[] = [first];
  let body: RecordDef | undefined;
  while (yield* check(state, 'ampersand')) {
    yield* advance(state);
    if (yield* check(state, 'lbrace')) {
      body = yield* parseRecordDef(state);
      break;
    }
    supertypes.push(yield* parseSupertypeRef(state));
  }
  let removal: RemovalSet | undefined;
  if (yield* check(state, 'minus')) {
    // §12.3: "-" MUST be separated from the preceding token by whitespace. After an unquoted
    // supertype name the lexer already guarantees this (otherwise the hyphen would have been
    // absorbed into the name) -- but after a construction's closing "}" it does not, since "}"
    // isn't an unquoted-continuation character either way, so this check is only ever
    // load-bearing in that second case.
    const beforeMinus = state.lastEnd;
    const minusToken = yield* peekToken(state);
    if (samePosition(beforeMinus, minusToken.start)) {
      throw parseError(
        minusToken,
        "a removal clause's '-' must be separated from the preceding token by whitespace " +
          '(otherwise it would be absorbed into a hyphenated name)',
      );
    }
    removal = yield* parseRemovalSet(state);
  }
  return {
    kind: 'constructionDef',
    supertypes: supertypes as [TypeRef, ...TypeRef[]],
    ...(body !== undefined ? { body } : {}),
    ...(removal !== undefined ? { removal } : {}),
  } satisfies ConstructionDef;
}

function* parseRemovalSet(state: CursorState): Task<RemovalSet> {
  yield* expect(state, 'minus', "a removal clause's '-'");
  yield* expect(state, 'lbrace', "a removal set's opening '{'");
  const names: string[] = [(yield* expectFieldNameToken(state, 'a removed field name')).text];
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbrace')) {
    names.push((yield* expectFieldNameToken(state, 'a removed field name')).text);
  }
  yield* expect(state, 'rbrace', "a removal set's closing '}'");
  return { fieldNames: names as [string, ...string[]] };
}

// ── Records, Fields, Groups (§5.2, §5.11, §12.1) ────────────────────────

function* parseRecordDef(state: CursorState): Task<RecordDef> {
  yield* expect(state, 'lbrace', "a record body's opening '{'");
  return yield* parseRecordBody(state);
}

/** {@link parseRecordDef} past its opening `'{'` -- {@link braceTypeDef} consumes that token before it knows which construct it opened. */
function* parseRecordBody(state: CursorState): Task<RecordDef> {
  const entries: RecordEntry[] = [];
  if (!(yield* check(state, 'rbrace'))) {
    entries.push(yield* parseRecordEntry(state));
    while (yield* consumeSeparatorOrCloseCheck(state, 'rbrace')) {
      entries.push(yield* parseRecordEntry(state));
    }
  }
  yield* expect(state, 'rbrace', "a record body's closing '}'");
  return { kind: 'recordDef', entries };
}

function* parseRecordEntry(state: CursorState): Task<RecordEntry> {
  const annotations = yield* parseAnnotationList(state);
  if (yield* check(state, 'lparen')) {
    return yield* parseGroupDef(state, annotations);
  }
  return yield* parseFieldDef(state, annotations);
}

function* parseFieldDef(state: CursorState, annotations: readonly Annotation[]): Task<FieldDef> {
  const name = yield* expectFieldNameToken(state, 'a record field name');
  const optional = yield* consumeAdjacentQuestion(state);
  if (yield* check(state, 'map-arrow-token')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "a record body's entries are 'name: type'; '=>' begins a map type only where a type is " +
        'expected (§12.2), not in a composition tail or a constructor vocabulary',
    );
  }
  yield* expect(state, 'colon', "a record field's ':'");

  let type: FieldDef['type'];
  let modifier: FieldModifier | undefined;
  if ((yield* check(state, 'tilde')) || (yield* check(state, 'equal'))) {
    modifier = yield* parseFieldModifier(state);
  } else {
    const ref = yield* parseFieldType(state);
    const voidable = yield* consumeAdjacentQuestion(state);
    type = { typeRef: ref, voidable };
    if ((yield* check(state, 'tilde')) || (yield* check(state, 'equal'))) {
      modifier = yield* parseFieldModifier(state);
    }
  }
  return {
    kind: 'fieldDef',
    annotations,
    name: name.text,
    optional,
    ...(type !== undefined ? { type } : {}),
    ...(modifier !== undefined ? { modifier } : {}),
  };
}

/**
 * `field-modifier = ws ("~" / "=") ws token / ws "=" ws "?"` (§12.1, §5.2). `~` is always a
 * default; `=` is a fixed value UNLESS immediately followed by `?` with nothing else, which is
 * the selector -- `a: T =? v` (a value after the selector) is a parse error, since `field-modifier`
 * admits no token there.
 */
function* parseFieldModifier(state: CursorState): Task<FieldModifier> {
  const isDefault = yield* check(state, 'tilde');
  yield* advance(state);

  if (!isDefault && (yield* check(state, 'question'))) {
    yield* advance(state);
    return { kind: 'selector' };
  }

  const t = yield* peekToken(state);
  let form: TokenForm;
  switch (t.type) {
    case 'unquoted-token':
      form = 'unquoted';
      break;
    case 'single-line-token':
      form = 'single-line';
      break;
    case 'multi-line-token':
      form = 'multi-line';
      break;
    default:
      throw mismatch(
        isDefault
          ? "a scalar token after '~'"
          : "a scalar token after '=', or '?' with nothing following (the selector, §5.2)",
        t,
      );
  }
  yield* advance(state);
  if (
    form === 'unquoted' &&
    (yield* check(state, 'bang')) &&
    adjacentTo(t, yield* peekToken(state))
  ) {
    throw dependentTypeOffAFieldsType(t);
  }
  const token: TokenValue = { kind: 'token', text: t.text, form };
  return isDefault ? { kind: 'default', token } : { kind: 'fixed', token };
}

/**
 * `group-def` (§12.1, §5.11): `|` separates options, and the members of one option are separated as
 * a record body's entries are. The mark after `)` is `?` or `+`, never both, and touches the `)`.
 */
function* parseGroupDef(state: CursorState, annotations: readonly Annotation[]): Task<GroupDef> {
  const start = (yield* peekToken(state)).start;
  yield* expect(state, 'lparen', "a field group's opening '('");
  const options: [GroupMember, ...GroupMember[]][] = [yield* parseGroupOption(state)];
  while (yield* check(state, 'pipe')) {
    yield* advance(state);
    options.push(yield* parseGroupOption(state));
  }
  yield* expect(state, 'rparen', "a field group's closing ')'");
  const quantifier: GroupQuantifier = (yield* consumeAdjacent(state, 'question'))
    ? 'AT_MOST_ONE'
    : (yield* consumeAdjacent(state, 'plus'))
      ? 'AT_LEAST_ONE'
      : 'EXACTLY_ONE';
  if (
    quantifier !== 'EXACTLY_ONE' &&
    ((yield* check(state, 'question')) || (yield* check(state, 'plus')))
  ) {
    const here = yield* peekToken(state);
    if (samePosition(state.lastEnd, here.start)) {
      throw parseError(
        here,
        "a field group takes one mark after its ')': '?' for at most one option, or '+' for at " +
          'least one of its members (§5.11)',
      );
    }
  }
  const group: GroupDef = { kind: 'groupDef', annotations, options, quantifier };
  checkGroupShape(group, start);
  return group;
}

/**
 * The shapes a group may take (§5.11), each refused with the spelling it restates, so that every
 * presence rule has one spelling:
 *
 * - the only member of an option takes no `?`, being present exactly when its option is chosen;
 * - `+` takes options of one field each, at least two of them;
 * - a group of one option is `?`, with at least two members and one of them unmarked. A bare one
 *   is plain fields, or with every member marked the `+` group; a `?` one with a single member, or
 *   with every member marked, is plain optional fields.
 */
function checkGroupShape(group: GroupDef, start: Position): void {
  for (const option of group.options) {
    const only = option[0];
    if (option.length === 1 && only.omittable) {
      throw new TsonParseError(
        `'${only.name}' is the only member of its option, so the '?' on its name changes nothing ` +
          '-- it is present exactly when its option is chosen (§5.11); write it without the ' +
          "'?'",
        start,
      );
    }
  }
  const members = group.options.flat();
  const names = members.map((member) => member.name);
  if (group.quantifier === 'AT_LEAST_ONE') {
    if (group.options.some((option) => option.length > 1)) {
      throw new TsonParseError(
        "a '+' group's options are single fields, at least one of them present -- an option " +
          "holding several fields belongs to a bare or '?' group (§5.11)",
        start,
      );
    }
    if (members.length < 2) {
      throw new TsonParseError(
        "a '+' group needs at least two members -- at least one of a single field is that " +
          'field, required (§5.11)',
        start,
      );
    }
    return;
  }
  if (group.options.length > 1) return;
  const anyUnmarked = members.some((member) => !member.omittable);
  if (group.quantifier === 'EXACTLY_ONE') {
    throw new TsonParseError(
      anyUnmarked
        ? 'a bare group of one option states plain fields -- its option is always chosen, so its ' +
            `unmarked members are required and its marked ones optional; declare (${names.join(', ')}) ` +
            'as fields (§5.11)'
        : 'a bare group of one option whose members are all marked admits at least one of them -- ' +
            `write it with '+', each member its own option: (${names.join(' | ')})+ (§5.11)`,
      start,
    );
  }
  if (members.length < 2 || !anyUnmarked) {
    throw new TsonParseError(
      `a '?' group of one option ${members.length < 2 ? 'and one member' : 'whose members are all marked'} ` +
        `admits each member independently -- declare (${names.join(', ')}) as optional fields (§5.11)`,
      start,
    );
  }
}

function* parseGroupOption(state: CursorState): Task<[GroupMember, ...GroupMember[]]> {
  const members: [GroupMember, ...GroupMember[]] = [yield* parseGroupMember(state)];
  while (
    !(yield* check(state, 'pipe')) &&
    !(yield* check(state, 'rparen')) &&
    !(yield* check(state, 'eof'))
  ) {
    if (yield* check(state, 'comma')) {
      yield* advance(state);
    }
    members.push(yield* parseGroupMember(state));
  }
  return members;
}

function* parseGroupMember(state: CursorState): Task<GroupMember> {
  const annotations = yield* parseAnnotationList(state);
  const name = yield* expectFieldNameToken(state, "a field group member's name");
  // Optional once the member's option is chosen: the option, not the record, is what the mark is about.
  const omittable = yield* consumeAdjacentQuestion(state);
  yield* expect(state, 'colon', "a field group member's ':'");
  const typeRef = yield* parseFieldType(state);
  const voidable = yield* consumeAdjacentQuestion(state);
  if ((yield* check(state, 'tilde')) || (yield* check(state, 'equal'))) {
    // §5.11: a member's presence is the group's and a group never injects, so `~`, `=` and `=?`
    // are refused here by name rather than as a malformed group.
    throw parseError(
      yield* peekToken(state),
      "a field group member takes no value modifier -- §5.11 gives the group a member's " +
        "presence, so none of them takes a default, a pin, or the discriminator mark '=?'",
    );
  }
  return { annotations, name: name.text, omittable, typeRef, voidable };
}

// ── Type References (§5.3, §12.1) ───────────────────────────────────────

/**
 * A type-ref position (§5.3): a field's type, a group member's type, a choice variant, an
 * inline element, a type argument. `!` is rejected here by name rather than by falling through
 * to "expected a type reference" -- writing the refinement inline is the natural first attempt,
 * and the grammar's answer (hoist it to its own declaration, reference it by name) is a
 * one-line fix an author cannot guess from a token-level complaint.
 */
function* parseTypeExpr(state: CursorState): Task<TypeExpr> {
  // Every cycle in this grammar passes through here: a choice's variants, a bracket's element
  // types, a map's key and value, and a generic's type arguments all come back to `parseTypeRef`.
  // One guard at this point therefore bounds the whole type-expression grammar (§9.1), where
  // guarding each of those separately would have to be got right four times over.
  const here = yield* peekToken(state);
  if (yield* check(state, 'lparen')) {
    return yield* nested(state, here, () => parseChoiceRef(state));
  }
  if (yield* check(state, 'lbracket')) {
    return yield* nested(state, here, () => parseBracket(state));
  }
  if (yield* check(state, 'lbrace')) {
    return yield* nested(state, here, () => parseBraceType(state));
  }
  if (yield* check(state, 'bang')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      'an atom refinement or constructor application is not permitted at a type-ref position ' +
        "(§5.3); declare a named type instead (e.g. 'quantity_t => !integer ^ { min: 1 }') and " +
        'reference it by name',
    );
  }
  return yield* parseTypeRefHead(state);
}

/**
 * A record field's or a field group member's type: a type-ref, or `kind!`, a {@link DependentType}, which
 * the grammar admits here and nowhere else (§5.2, §12.1). One token of lookahead after the name decides it.
 */
function* parseFieldType(state: CursorState): Task<FieldTypeExpr> {
  const head = yield* peekToken(state);
  const second = yield* peekSecond(state);
  if (second.type === 'bang' && adjacentTo(head, second) && head.type !== 'multi-line-token') {
    if (head.type === 'unquoted-token') {
      yield* advance(state);
      return yield* parseDependentType(state, head);
    }
    if (head.type === 'single-line-token') {
      throw parseError(
        second,
        "a dependent field's '!' follows the name of a field of the same record, one unquoted " +
          'identifier, and a quoted token is none (§12.1)',
      );
    }
  }
  return yield* inPlace(state, yield* parseTypeExpr(state));
}

/**
 * A type at a slot, past which nothing composes or subtracts: those are written at a declaration and never
 * in place (§5.2), since what they make would be named by nothing. `at: point & { z: int32 }` is refused
 * naming the declaration to write, and so is a name followed by `'{'`, the same reach without the operator,
 * or a definition mark, which marks a declaration alone. A `'^'` there is refused as at a declaration: it
 * follows `!name`.
 */
function* inPlace<T extends TypeExpr>(state: CursorState, written: T): Task<T> {
  if (yield* check(state, 'caret')) {
    throw parseError(
      yield* peekToken(state),
      "'^' follows '!name' and takes values (§5.5, §5.7), and a record's fields are restated in a " +
        "composition, declared under a name ('my_type => base & { ... }') and named here (§5.2)",
    );
  }
  const ampersand = yield* check(state, 'ampersand');
  if (ampersand || (yield* check(state, 'minus'))) {
    const operator = ampersand ? '&' : '-';
    const what = ampersand
      ? 'composes a type, and a composition'
      : 'removes fields from a type, and a subtraction';
    throw parseError(
      yield* peekToken(state),
      `'${operator}' ${what} is declared, never written in place (§5.2): declare it under a name ` +
        `('my_type => base ${operator} { ... }') and write that name`,
    );
  }
  if (written.kind === 'nameRef' && (yield* check(state, 'lbrace'))) {
    const marked = written.name === 'abstract' || written.name === 'final';
    throw parseError(
      yield* peekToken(state),
      marked
        ? `'${written.name}' marks how a declared record may be realised (§5.2), and a record written ` +
            "in place is its bare body, '{ ... }': declare the record to mark it"
        : `'${written.name}' followed by '{' is no type: a record written in place is its bare body, ` +
            "'{ ... }', and a composition ('&') of a named type is declared (§5.2)",
    );
  }
  return written;
}

/**
 * `kind!` past its token, the `!` next at the cursor: the token one identifier, a single segment, and the `!`
 * followed by whitespace or the end of the document (§12.3). The whitespace is what keeps a postfix `!` apart
 * from a prefix one, so `a!b`, `kind!}` and `kind!?` do not parse.
 */
function* parseDependentType(state: CursorState, head: Token): Task<DependentType> {
  if (!isSiblingField(head.text)) {
    throw parseError(
      head,
      `'${head.text}!' types no dependent field -- the '!' follows the name of one field of the same ` +
        'record, one identifier, a single segment (§12.1)',
    );
  }
  const bang = yield* advance(state);
  const next = yield* peekToken(state);
  if (next.type !== 'eof' && adjacentTo(bang, next)) {
    throw parseError(
      next,
      `a dependent field's '!' must be followed by whitespace (§12.3): write '${head.text}! ' before ${describe(next)}`,
    );
  }
  return { kind: 'dependentType', on: head.text };
}

/** `head` followed by an adjacent `!` where no field's type is written. */
function dependentTypeOffAFieldsType(head: Token): TsonParseError {
  return parseError(
    head,
    `'${head.text}!' is a dependent field's type, and stands only as a record field's type, a field ` +
      "group member's included -- never inside a type, nor at any other position (§5.2, §12.1)",
  );
}

/**
 * `qualified-name ["<" type-args ">"]` -- the name-based tail shared by every type-ref position and by
 * construction heads. An adjacent `<` makes it an application; an adjacent `!` is a dependent field's type
 * off a field's type ({@link parseFieldType}), refused naming where it stands.
 */
function* parseTypeRefHead(state: CursorState): Task<TypeRef> {
  const head = yield* expect(state, 'unquoted-token', 'a type reference');
  if ((yield* check(state, 'bang')) && adjacentTo(head, yield* peekToken(state))) {
    throw dependentTypeOffAFieldsType(head);
  }
  requireQualifiedName(head, 'type', '§12.1');
  const name = head.text;
  if (yield* check(state, 'less-than')) {
    const less = yield* peekToken(state);
    if (!adjacentTo(head, less)) {
      throw parseError(
        less,
        `'<' applies '${name}' only adjacent to it (§12.3): write '${name}<...>' with no whitespace before '<'`,
      );
    }
    yield* advance(state);
    const args = yield* parseTypeArgs(state);
    yield* expect(state, 'greater-than', "a type argument list's closing '>'");
    return { kind: 'applicationRef', name, args };
  }
  return { kind: 'nameRef', name };
}

/**
 * `supertype-ref = type-ref` (§12.1, §5.8) -- a composition/subtraction operand: the same shape
 * {@link parseTypeRefHead} builds, named separately so every call site that must not admit a
 * paren/bracket/map operand says so.
 */
function* parseSupertypeRef(state: CursorState): Task<TypeRef> {
  return yield* parseTypeRefHead(state);
}

function* parseChoiceRef(state: CursorState): Task<ChoiceExpr> {
  const start = (yield* peekToken(state)).start;
  yield* expect(state, 'lparen', "a choice type's opening '('");
  const variants: TypeExpr[] = [yield* inPlace(state, yield* parseTypeExpr(state))];
  if (!(yield* check(state, 'pipe'))) {
    throw new TsonParseError(
      "a choice type requires at least two variants separated by '|' (§5.4)",
      start,
    );
  }
  while (yield* check(state, 'pipe')) {
    yield* advance(state);
    variants.push(yield* inPlace(state, yield* parseTypeExpr(state)));
  }
  yield* expect(state, 'rparen', "a choice type's closing ')'");
  return { kind: 'choiceExpr', variants: variants as [TypeExpr, TypeExpr, ...TypeExpr[]] };
}

/**
 * `bracket-type` (§12.1) -- the one bracket production, serving every position. One element
 * with an optional size specifier is an {@link ArrayRef}; two or more are a {@link TupleRef}.
 * Arity is all that distinguishes them, which is why both alternatives share a first element.
 */
function* parseBracket(state: CursorState): Task<ArrayExpr | TupleExpr> {
  yield* expect(state, 'lbracket', "an array or tuple type's opening '['");
  const first = yield* parseElementType(state);
  if (yield* check(state, 'semicolon')) {
    yield* advance(state);
    const size = yield* parseSizeSpec(state, 'rbracket');
    yield* expect(state, 'rbracket', "an array type's closing ']'");
    return { kind: 'arrayExpr', elementType: first, size };
  }
  const elements: ElementType[] = [first];
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbracket')) {
    elements.push(yield* parseElementType(state));
  }
  yield* expect(state, 'rbracket', "an array or tuple type's closing ']'");
  return elements.length === 1
    ? { kind: 'arrayExpr', elementType: first }
    : { kind: 'tupleExpr', elementTypes: elements as [ElementType, ElementType, ...ElementType[]] };
}

/** `map-key = type-ref` (§12.1) -- a plain reference, optionally carrying type arguments, never a bracket or paren form. */
function* parseMapKey(state: CursorState): Task<TypeRef> {
  const key = yield* parseTypeRefHead(state);
  yield* rejectMapQuestion(state, 'key');
  return key;
}

/** The map sugar's key side admits no `?` (§5.3): an absent key is already a data-grammar error ([TSON-DATA] §2.9), and `map-key` has no `?` to write (§12.1). The value side does admit one. */
function* rejectMapQuestion(state: CursorState, side: string): Task<void> {
  if (yield* check(state, 'question')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      `'?' is not permitted on a map type's ${side} (§5.3); a void key states an entry for nothing`,
    );
  }
}

/** The single-entry rule (§5.3): a map *type* carries one key type and one value type. */
function* requireMapClose(state: CursorState): Task<void> {
  if (!(yield* check(state, 'rbrace'))) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "a map type is a single 'key => value' entry (§5.3), however many entries a map value " +
        `may hold; found ${describe(here)}`,
    );
  }
}

function* parseTypeArgs(state: CursorState): Task<[TypeExpr, ...TypeExpr[]]> {
  const args: TypeExpr[] = [yield* inPlace(state, yield* parseTypeArg(state))];
  while (yield* consumeSeparatorOrCloseCheck(state, 'greater-than')) {
    args.push(yield* inPlace(state, yield* parseTypeArg(state)));
  }
  return args as [TypeExpr, ...TypeExpr[]];
}

/**
 * `type-arg = type-expr` (§12.1, §5.10): an argument is a type, so a quoted or numeric token, which names
 * none, is refused here rather than read as a value.
 */
function* parseTypeArg(state: CursorState): Task<TypeExpr> {
  const t = yield* peekToken(state);
  if (
    t.type === 'single-line-token' ||
    t.type === 'multi-line-token' ||
    (t.type === 'unquoted-token' && tryParseNumber(t.text) !== undefined)
  ) {
    throw parseError(
      t,
      `'${t.text}' is no type argument: an argument is a type, written as a reference -- a name or an ` +
        'application -- and never a literal token (§5.10)',
    );
  }
  if (t.type === 'unquoted-token') return yield* parseTypeRefHead(state);
  if (t.type === 'lparen') return yield* parseChoiceRef(state);
  if (t.type === 'lbracket') return yield* parseBracket(state);
  if (t.type === 'lbrace') return yield* parseBraceType(state);
  if (t.type === 'void-token') {
    throw parseError(t, "the void sentinel '_' is not valid in a type argument position (§7.6)");
  }
  throw mismatch('a type argument (a type reference)', t);
}

// ── Declaration-Level Container Forms (§5.3, §12.1) ─────────────────────

/** `map-type` past its opening `'{'` (§12.1): one `key => value` entry, an optional size specifier after `';'`, and the closing brace. */
function* parseMapBody(state: CursorState): Task<MapExpr> {
  const key = yield* parseMapKey(state);
  yield* expect(state, 'map-arrow-token', "a map type's '=>'");
  const value = yield* parseElementType(state);
  let size: SizeSpec | undefined;
  if (yield* check(state, 'semicolon')) {
    yield* advance(state);
    size = yield* parseSizeSpec(state, 'rbrace');
  }
  yield* requireMapClose(state);
  yield* expect(state, 'rbrace', "a map type's closing '}'");
  return {
    kind: 'mapExpr',
    keyType: key,
    valueType: value,
    ...(size !== undefined ? { size } : {}),
  };
}

/** `element-type = type-expr ["?"]` (§12.1). Nesting needs no case of its own: a bracket or map form *is* a type-expr. */
function* parseElementType(state: CursorState): Task<ElementType> {
  const ref = yield* inPlace(state, yield* parseTypeExpr(state));
  return { typeRef: ref, voidable: yield* consumeAdjacentQuestion(state) };
}

/** `size-spec` (§12.1), shared by the bracket and map forms -- `closing` is the bracket or brace the open-ended `N..` form runs up against. */
function* parseSizeSpec(state: CursorState, closing: 'rbracket' | 'rbrace'): Task<SizeSpec> {
  if (yield* check(state, 'range-token')) {
    yield* advance(state);
    return { kind: 'max', upper: yield* expectSizeBound(state) };
  }
  const lower = yield* expectSizeBound(state);
  if (yield* check(state, 'range-token')) {
    yield* advance(state);
    if (yield* check(state, closing)) {
      return { kind: 'min', lower };
    }
    return { kind: 'ranged', lower, upper: yield* expectSizeBound(state) };
  }
  return { kind: 'exact', bound: lower };
}

function* expectSizeBound(state: CursorState): Task<string> {
  return (yield* expect(state, 'unquoted-token', 'a size bound')).text;
}

// ── Names and Small Helpers ──────────────────────────────────────────────

/**
 * `type-params = "<" type-param *( separator type-param ) [","] ">"`, with `type-param =
 * param-name [ ":" type-ref ]` (§12.1, §5.10). The names are the list every consumer reads; a
 * written type is collected into `written` for the declaration being parsed, since it narrows what
 * resolution derives rather than shaping the type-def.
 */
function* parseTypeParamsOpt(state: CursorState, written: Map<string, TypeExpr>): Task<string[]> {
  if (!(yield* check(state, 'less-than'))) {
    return [];
  }
  yield* advance(state);
  const params: string[] = [yield* parseTypeParam(state, written)];
  while (yield* consumeSeparatorOrCloseCheck(state, 'greater-than')) {
    params.push(yield* parseTypeParam(state, written));
  }
  yield* expect(state, 'greater-than', "a type parameter list's closing '>'");
  return params;
}

function* parseTypeParam(state: CursorState, written: Map<string, TypeExpr>): Task<string> {
  const name = yield* expectTypeName(state, 'a type parameter');
  if (yield* check(state, 'colon')) {
    yield* advance(state);
    written.set(name, yield* parseTypeExpr(state));
  }
  return name;
}

/**
 * `type-name = identifier` (§12.1, through the kernel's `meta.type_name` role; `param-name` shares it
 * verbatim). The token is matched in full against the kernel's `meta.identifier` profile, which
 * subsumes §12.1's separate "numbers are not declarable names" rule: identifier-Start is `XID_Start`, and
 * every spelling the number grammar admits begins with a digit, a sign or a dot, all of which sit in
 * token-Start only so a number can be an unquoted token.
 */
function* expectTypeName(state: CursorState, context: string): Task<string> {
  const t = yield* expect(state, 'unquoted-token', context);
  requireIdentifierName(t.text, t.start);
  return t.text;
}

function requireIdentifierName(text: string, start: Position): void {
  if (!isIdentifierText(text)) {
    throw new TsonParseError(
      `'${text}' is not a valid type name -- a name is an identifier: it starts with an XID_Start ` +
        "character and continues with XID_Continue or '-', so a name that matches the number grammar " +
        'is not declarable (§12.1)',
      start,
    );
  }
}

/** `"?"` MUST be immediately adjacent to the preceding token (§12.3) -- field type, tuple/array position, or field group. */
function* consumeAdjacentQuestion(state: CursorState): Task<boolean> {
  return yield* consumeAdjacent(state, 'question');
}

/** A `?` or `+` mark binds to the token before it and so must touch it (§12.3). */
function* consumeAdjacent(state: CursorState, mark: 'question' | 'plus'): Task<boolean> {
  if (!(yield* check(state, mark))) {
    return false;
  }
  const prevEnd = state.lastEnd;
  const q = yield* peekToken(state);
  if (!samePosition(prevEnd, q.start)) {
    throw parseError(
      q,
      `'${q.text}' must be immediately adjacent to what it marks (no whitespace)`,
    );
  }
  yield* advance(state);
  return true;
}

function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.column === b.column && a.offset === b.offset;
}
