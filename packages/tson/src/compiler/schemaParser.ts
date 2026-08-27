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
 * token or the absent sentinel (§5.2), never annotations, a type-ref, or a container.
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
import { adjacentTo, type TokenForm } from '../lexer/token.js';
import { tryParseNumber } from '../base/numberGrammar.js';
import type { Annotation, DataValue, TokenValue } from '../ast/value.js';
import type { Declaration, SchemaDocument, SchemaMap } from '../ast/schema/document.js';
import type {
  AtomRefinement,
  FieldDef,
  FieldModifier,
  FieldModifierKind,
  FieldModifierValue,
  GroupDef,
  GroupMember,
  Instance,
  RecordEntry,
  RemovalSet,
  SizeSpec,
} from '../ast/schema/fields.js';
import type {
  ConstructionDef,
  RecordDef,
  ReferenceTypeDef,
  StructuralDef,
  StructuralTypeDef,
  TypeDef,
} from '../ast/schema/typedef.js';
import type {
  ArrayRef,
  ChoiceRef,
  ElementType,
  GenericRef,
  MapRef,
  SimpleRef,
  TupleRef,
  TypeArg,
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
  parseNamedDirective,
  peekDirectiveName,
  peekSecond,
  peekToken,
  tokenFormOf,
} from './cursor.js';
import { parseAnnotationList, parseCoreValue } from './dataValueGrammar.js';

/**
 * Parses a whole schema document (§2.1-§2.2, §12.1) from `input`, fail-fast: the first syntax
 * error anywhere throws {@link TsonParseError}. `input` need not be complete -- like every
 * generator-returning entry point in this stack, drive the returned {@link Task} with `runSync`
 * (complete input) or `runAsync` (chunked input), per `io/bytes.ts`.
 */
export function* parseSchemaDocument(input: ByteInput): Task<SchemaDocument> {
  const state = createCursor(input);
  return yield* parseDocumentBody(state);
}

function* parseDocumentBody(state: CursorState): Task<SchemaDocument> {
  let id: string | undefined;
  if ((yield* check(state, 'directive-token')) && (yield* peekDirectiveName(state)) === 'id') {
    id = yield* parseNamedDirective(state, 'id');
  }

  if (!(yield* check(state, 'directive-token')) || (yield* peekDirectiveName(state)) !== 'meta') {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "expected '!!meta' (a schema document requires exactly one, immediately after '!!id' if present)",
    );
  }
  const meta = yield* parseNamedDirective(state, 'meta');

  const imports: string[] = [];
  while (
    (yield* check(state, 'directive-token')) &&
    (yield* peekDirectiveName(state)) === 'import'
  ) {
    imports.push(yield* parseNamedDirective(state, 'import'));
  }
  if (yield* check(state, 'directive-token')) {
    const name = yield* peekDirectiveName(state);
    const here = yield* peekToken(state);
    throw parseError(
      here,
      `directive '!!${name ?? describe(here)}' is not permitted here (expected '!!import' or ` +
        "the schema map's opening '{')",
    );
  }

  const body = yield* parseSchemaMap(state);

  if (!(yield* check(state, 'eof'))) {
    const here = yield* peekToken(state);
    throw parseError(here, `unexpected content after the schema map: ${describe(here)}`);
  }
  return { ...(id !== undefined ? { id } : {}), meta, imports, body };
}

// ── Schema Map (§2.1, §12.1) ────────────────────────────────────────────

function* parseSchemaMap(state: CursorState): Task<SchemaMap> {
  const annotations = yield* parseAnnotationList(state);
  yield* expect(state, 'lbrace', "a schema map's opening '{'");
  if (yield* check(state, 'rbrace')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "a schema map requires at least one declaration; '{}' is not permitted here (§2.1)",
    );
  }
  const declarations = new Map<string, Declaration>();
  const first = yield* parseDeclaration(state);
  declarations.set(first.name, first);
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbrace')) {
    const next = yield* parseDeclaration(state);
    declarations.set(next.name, next);
  }
  yield* expect(state, 'rbrace', "a schema map's closing '}'");
  return { annotations, declarations };
}

function* parseDeclaration(state: CursorState): Task<Declaration> {
  const nameAnnotations = yield* parseAnnotationList(state);
  const name = yield* expectTypeName(state, 'a declaration name');
  yield* expect(state, 'map-arrow-token', "a declaration's '=>'");
  const typeDefAnnotations = yield* parseAnnotationList(state);
  const typeDef = yield* parseTypeDef(state);
  return { nameAnnotations, name, typeDefAnnotations, typeDef };
}

// ── Type Definitions (§5, §12.1) ────────────────────────────────────────

function* parseTypeDef(state: CursorState): Task<TypeDef> {
  // The parameter list comes first, so one token then decides the alternative: `!` with no
  // parameters is an instance or an atom refinement, `!` with parameters an instance-template
  // (§12.1). `<` only ever starts a parameter list, so consuming it costs no lookahead.
  const typeParams = yield* parseTypeParamsOpt(state);

  if (yield* check(state, 'bang')) {
    return yield* parseAtomRefinementOrInstance(state, typeParams);
  }
  if (yield* check(state, 'tilde')) {
    yield* advance(state);
    return {
      kind: 'structuralTypeDef',
      typeParams,
      constructor: true,
      body: yield* parseMandatoryStructuralDef(state),
    } satisfies StructuralTypeDef;
  }
  if (yield* check(state, 'lbrace')) {
    return yield* braceTypeDef(state, typeParams);
  }
  if (yield* check(state, 'lparen')) {
    return {
      kind: 'referenceTypeDef',
      typeParams,
      ref: yield* parseTypeRef(state),
    } satisfies ReferenceTypeDef;
  }
  if (yield* check(state, 'lbracket')) {
    return {
      kind: 'referenceTypeDef',
      typeParams,
      ref: yield* parseBracket(state),
    } satisfies ReferenceTypeDef;
  }

  const head = yield* parseTypeRefHead(state);
  if (yield* check(state, 'caret')) {
    yield* advance(state);
    return {
      kind: 'structuralTypeDef',
      typeParams,
      constructor: false,
      body: { kind: 'refinedDef', target: head, body: yield* parseRecordDef(state) },
    } satisfies StructuralTypeDef;
  }
  if ((yield* check(state, 'ampersand')) || (yield* check(state, 'minus'))) {
    return {
      kind: 'structuralTypeDef',
      typeParams,
      constructor: false,
      body: yield* parseConstructionDefContinuation(state, head),
    } satisfies StructuralTypeDef;
  }
  if (yield* check(state, 'lbrace')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "expected '^' (refinement) or '&' (composition) after a bare type-ref, found '{'",
    );
  }
  return { kind: 'referenceTypeDef', typeParams, ref: head } satisfies ReferenceTypeDef;
}

/** The `structural-def` reached after a leading `~` -- unlike {@link parseTypeDef}'s own dispatch, a bare type-ref here (nothing following) is a parse error: `~` promises a refinement, composition, or record body. */
function* parseMandatoryStructuralDef(state: CursorState): Task<StructuralDef> {
  if (yield* check(state, 'lbrace')) {
    return yield* parseRecordDef(state);
  }
  const head = yield* parseTypeRefHead(state);
  if (yield* check(state, 'caret')) {
    yield* advance(state);
    return { kind: 'refinedDef', target: head, body: yield* parseRecordDef(state) };
  }
  if ((yield* check(state, 'ampersand')) || (yield* check(state, 'minus'))) {
    return yield* parseConstructionDefContinuation(state, head);
  }
  const here = yield* peekToken(state);
  throw parseError(here, "expected '^', '&', '-', or a record body after '~' (constructor marker)");
}

/**
 * §12.2's brace dispatch at a type-def position, where `'{'` opens either a record body or the
 * map sugar. The token is consumed and the decision made on what follows -- the
 * consume-one-then-inspect idiom [TSON-DATA] §2.8 already fixes for the data grammar's own
 * brace, within the same budget of one consumed token plus one of lookahead.
 */
function* braceTypeDef(state: CursorState, typeParams: readonly string[]): Task<TypeDef> {
  yield* expect(state, 'lbrace', "a record body's or map type's opening '{'");
  if (yield* braceOpensMap(state)) {
    return {
      kind: 'referenceTypeDef',
      typeParams,
      ref: yield* parseMapBody(state),
    } satisfies ReferenceTypeDef;
  }
  return {
    kind: 'structuralTypeDef',
    typeParams,
    constructor: false,
    body: yield* parseRecordBody(state),
  } satisfies StructuralTypeDef;
}

/** The dispatch decision itself, with the `'{'` already consumed -- see {@link braceTypeDef}. */
function* braceOpensMap(state: CursorState): Task<boolean> {
  if (!(yield* check(state, 'unquoted-token'))) return false;
  const second = yield* peekSecond(state);
  return second.type === 'map-arrow-token' || second.type === 'less-than';
}

/** Everywhere except a type-def position, `'{'` opens the map sugar and nothing else (§5.2). */
function* requireMapBrace(state: CursorState): Task<void> {
  if (!(yield* braceOpensMap(state))) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "'{' here opens the map sugar '{K => V}'; a record body is not permitted at a type " +
        'position (§5.2), so declare a named record type and reference it by name',
    );
  }
}

function* parseAtomRefinementOrInstance(
  state: CursorState,
  typeParams: readonly string[],
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
  rejectNumericTypeName(name.text, name.start);
  const target = name.text;

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
  // the payload to carry further annotations or a second, competing type-ref. A parameter list
  // makes it a template and changes nothing else: the payload is held rather than read against
  // the constructor's own vocabulary, so every core-value the closed form admits the open one
  // admits too -- a collection included.
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
  if (yield* check(state, 'map-arrow-token')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      "a record body's entries are 'name: type'; '=>' begins a map type only where a type is " +
        'expected (§12.2), not in a refinement body, a composition tail or a constructor vocabulary',
    );
  }
  yield* expect(state, 'colon', "a record field's ':'");

  let type: FieldDef['type'];
  let modifier: FieldModifier | undefined;
  if ((yield* check(state, 'tilde')) || (yield* check(state, 'equal'))) {
    modifier = yield* parseFieldModifier(state);
  } else {
    const ref = yield* parseTypeRef(state);
    const optional = yield* consumeAdjacentQuestion(state);
    type = { typeRef: ref, optional };
    if ((yield* check(state, 'tilde')) || (yield* check(state, 'equal'))) {
      modifier = yield* parseFieldModifier(state);
    }
  }
  return {
    kind: 'fieldDef',
    annotations,
    name: name.text,
    ...(type !== undefined ? { type } : {}),
    ...(modifier !== undefined ? { modifier } : {}),
  };
}

function* parseFieldModifier(state: CursorState): Task<FieldModifier> {
  const isDefault = yield* check(state, 'tilde');
  const kind: FieldModifierKind = isDefault ? 'default' : 'fixed';
  yield* advance(state);

  let value: FieldModifierValue;
  if (yield* check(state, 'absent-token')) {
    yield* advance(state);
    value = { kind: 'absent' };
  } else {
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
          `a scalar token or the absent sentinel '_' after '${kind === 'default' ? '~' : '='}'`,
          t,
        );
    }
    yield* advance(state);
    const token: TokenValue = { kind: 'token', text: t.text, form };
    value = { kind: 'literal', token };
  }
  return { kind, value };
}

function* parseGroupDef(state: CursorState, annotations: readonly Annotation[]): Task<GroupDef> {
  const start = (yield* peekToken(state)).start;
  yield* expect(state, 'lparen', "a field group's opening '('");
  const members: GroupMember[] = [yield* parseGroupMember(state)];
  if (!(yield* check(state, 'pipe'))) {
    throw new TsonParseError(
      "a field group requires at least two members separated by '|' (§5.11)",
      start,
    );
  }
  while (yield* check(state, 'pipe')) {
    yield* advance(state);
    members.push(yield* parseGroupMember(state));
  }
  yield* expect(state, 'rparen', "a field group's closing ')'");
  const optional = yield* consumeAdjacentQuestion(state);
  return {
    kind: 'groupDef',
    annotations,
    members: members as [GroupMember, GroupMember, ...GroupMember[]],
    optional,
  };
}

function* parseGroupMember(state: CursorState): Task<GroupMember> {
  const annotations = yield* parseAnnotationList(state);
  const name = yield* expectFieldNameToken(state, "a field group member's name");
  yield* expect(state, 'colon', "a field group member's ':'");
  return { annotations, name: name.text, typeRef: yield* parseTypeRef(state) };
}

// ── Type References (§5.3, §12.1) ───────────────────────────────────────

/**
 * A type-ref position (§5.3): a field's type, a group member's type, a choice variant, an
 * inline element, a type argument. `!` is rejected here by name rather than by falling through
 * to "expected a type reference" -- writing the refinement inline is the natural first attempt,
 * and the grammar's answer (hoist it to its own declaration, reference it by name) is a
 * one-line fix an author cannot guess from a token-level complaint.
 */
function* parseTypeRef(state: CursorState): Task<TypeRef> {
  if (yield* check(state, 'lparen')) {
    return yield* parseChoiceRef(state);
  }
  if (yield* check(state, 'lbracket')) {
    return yield* parseBracket(state);
  }
  if (yield* check(state, 'lbrace')) {
    return yield* parseMap(state);
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

/** `type-name ["<" type-args ">"]` -- the type-name-based tail shared by every type-ref position and by refinement/construction heads. */
function* parseTypeRefHead(state: CursorState): Task<SimpleRef | GenericRef> {
  const name = yield* expectTypeName(state, 'a type reference');
  if (yield* check(state, 'less-than')) {
    yield* advance(state);
    const args = yield* parseTypeArgs(state);
    yield* expect(state, 'greater-than', "a type argument list's closing '>'");
    return { kind: 'genericRef', name, args };
  }
  return { kind: 'simpleRef', name };
}

/**
 * `supertype-ref = type-name [ws "<" type-args ">"]` (§12.1, §5.8) -- a composition/subtraction
 * operand: the same shape {@link parseTypeRefHead} builds, named separately so every call site
 * that must not admit a paren/bracket/map operand says so.
 */
function* parseSupertypeRef(state: CursorState): Task<SimpleRef | GenericRef> {
  return yield* parseTypeRefHead(state);
}

function* parseChoiceRef(state: CursorState): Task<ChoiceRef> {
  const start = (yield* peekToken(state)).start;
  yield* expect(state, 'lparen', "a choice type's opening '('");
  const variants: TypeRef[] = [yield* parseTypeRef(state)];
  if (!(yield* check(state, 'pipe'))) {
    throw new TsonParseError(
      "a choice type requires at least two variants separated by '|' (§5.4)",
      start,
    );
  }
  while (yield* check(state, 'pipe')) {
    yield* advance(state);
    variants.push(yield* parseTypeRef(state));
  }
  yield* expect(state, 'rparen', "a choice type's closing ')'");
  return { kind: 'choiceRef', variants: variants as [TypeRef, TypeRef, ...TypeRef[]] };
}

/**
 * `bracket-type` (§12.1) -- the one bracket production, serving every position. One element
 * with an optional size specifier is an {@link ArrayRef}; two or more are a {@link TupleRef}.
 * Arity is all that distinguishes them, which is why both alternatives share a first element.
 */
function* parseBracket(state: CursorState): Task<ArrayRef | TupleRef> {
  yield* expect(state, 'lbracket', "an array or tuple type's opening '['");
  const first = yield* parseElementType(state);
  if (yield* check(state, 'semicolon')) {
    yield* advance(state);
    const size = yield* parseSizeSpec(state, 'rbracket');
    yield* expect(state, 'rbracket', "an array type's closing ']'");
    return { kind: 'arrayRef', elementType: first, size };
  }
  const elements: ElementType[] = [first];
  while (yield* consumeSeparatorOrCloseCheck(state, 'rbracket')) {
    elements.push(yield* parseElementType(state));
  }
  yield* expect(state, 'rbracket', "an array or tuple type's closing ']'");
  return elements.length === 1
    ? { kind: 'arrayRef', elementType: first }
    : { kind: 'tupleRef', elementTypes: elements as [ElementType, ElementType, ...ElementType[]] };
}

/** `map-type` (§12.1) including its opening brace -- {@link braceTypeDef} reaches the body directly, having consumed one already. */
function* parseMap(state: CursorState): Task<MapRef> {
  yield* expect(state, 'lbrace', "a map type's opening '{'");
  yield* requireMapBrace(state);
  return yield* parseMapBody(state);
}

/** `map-key = type-name ["<" type-args ">"]` (§12.1) -- a plain reference, optionally carrying type arguments, never a bracket or paren form. */
function* parseMapKey(state: CursorState): Task<TypeRef> {
  const key = yield* parseTypeRefHead(state);
  yield* rejectMapQuestion(state, 'key');
  return key;
}

/** Neither side of the map sugar's `'=>'` admits `?` (§5.3): `map` declares no `state` field, and an absent key is already a data-grammar error. */
function* rejectMapQuestion(state: CursorState, side: string): Task<void> {
  if (yield* check(state, 'question')) {
    const here = yield* peekToken(state);
    throw parseError(
      here,
      `'?' is not permitted on a map type's ${side} (§5.3); a map has no element state to mark optional`,
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

function* parseTypeArgs(state: CursorState): Task<[TypeArg, ...TypeArg[]]> {
  const args: TypeArg[] = [yield* parseTypeArg(state)];
  while (yield* consumeSeparatorOrCloseCheck(state, 'greater-than')) {
    args.push(yield* parseTypeArg(state));
  }
  return args as [TypeArg, ...TypeArg[]];
}

/**
 * `type-arg = type-ref / value-literal` (§12.1, §5.10). A quoted token or a numeric unquoted
 * token is unambiguously a {@link TypeArg} `value`; any other unquoted token parses as a `ref`
 * -- §12.1's own prose defers that classification to the semantic layer, which has the applied
 * signature's parameter kinds to consult.
 */
function* parseTypeArg(state: CursorState): Task<TypeArg> {
  const t = yield* peekToken(state);
  if (t.type === 'single-line-token' || t.type === 'multi-line-token') {
    yield* advance(state);
    return { kind: 'value', value: { kind: 'token', text: t.text, form: tokenFormOf(t.type) } };
  }
  if (t.type === 'unquoted-token') {
    if (tryParseNumber(t.text) !== undefined) {
      yield* advance(state);
      return { kind: 'value', value: { kind: 'token', text: t.text, form: 'unquoted' } };
    }
    return { kind: 'ref', ref: yield* parseTypeRefHead(state) };
  }
  if (t.type === 'lparen') {
    return { kind: 'ref', ref: yield* parseChoiceRef(state) };
  }
  if (t.type === 'lbracket') {
    return { kind: 'ref', ref: yield* parseBracket(state) };
  }
  if (t.type === 'lbrace') {
    return { kind: 'ref', ref: yield* parseMap(state) };
  }
  if (t.type === 'absent-token') {
    throw parseError(t, "the absent sentinel '_' is not valid in a type argument position (§7.6)");
  }
  throw mismatch('a type argument (a type reference or a scalar value)', t);
}

// ── Declaration-Level Container Forms (§5.3, §12.1) ─────────────────────

/** `map-type` past its opening `'{'` (§12.1): one `key => value` entry, an optional size specifier after `';'`, and the closing brace. */
function* parseMapBody(state: CursorState): Task<MapRef> {
  const key = yield* parseMapKey(state);
  yield* expect(state, 'map-arrow-token', "a map type's '=>'");
  const value = yield* parseTypeRef(state);
  yield* rejectMapQuestion(state, 'value');
  let size: SizeSpec | undefined;
  if (yield* check(state, 'semicolon')) {
    yield* advance(state);
    size = yield* parseSizeSpec(state, 'rbrace');
  }
  yield* requireMapClose(state);
  yield* expect(state, 'rbrace', "a map type's closing '}'");
  return {
    kind: 'mapRef',
    keyType: key,
    valueType: { typeRef: value, optional: false },
    ...(size !== undefined ? { size } : {}),
  };
}

/** `element-type = type-ref ["?"]` (§12.1). Nesting needs no case of its own: a bracket or map form *is* a type-ref. */
function* parseElementType(state: CursorState): Task<ElementType> {
  const ref = yield* parseTypeRef(state);
  return { typeRef: ref, optional: yield* consumeAdjacentQuestion(state) };
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

function* parseTypeParamsOpt(state: CursorState): Task<string[]> {
  if (!(yield* check(state, 'less-than'))) {
    return [];
  }
  yield* advance(state);
  const params: string[] = [yield* expectTypeName(state, 'a type parameter')];
  while (yield* consumeSeparatorOrCloseCheck(state, 'greater-than')) {
    params.push(yield* expectTypeName(state, 'a type parameter'));
  }
  yield* expect(state, 'greater-than', "a type parameter list's closing '>'");
  return params;
}

/** `type-name = unquoted-token` (§12.1), with the added restriction that its text MUST NOT match [TSON-DATA] §7.6's `number` production -- "numbers are not declarable names" (`param-name` shares the rule). */
function* expectTypeName(state: CursorState, context: string): Task<string> {
  const t = yield* expect(state, 'unquoted-token', context);
  rejectNumericTypeName(t.text, t.start);
  return t.text;
}

function rejectNumericTypeName(text: string, start: Position): void {
  if (tryParseNumber(text) !== undefined) {
    throw new TsonParseError(
      `'${text}' is not a valid type name -- names that match the number grammar are not ` +
        'declarable (§12.1)',
      start,
    );
  }
}

/** `"?"` MUST be immediately adjacent to the preceding token (§12.3) -- field type, tuple/array position, or field group. */
function* consumeAdjacentQuestion(state: CursorState): Task<boolean> {
  if (!(yield* check(state, 'question'))) {
    return false;
  }
  const prevEnd = state.lastEnd;
  const q = yield* peekToken(state);
  if (!samePosition(prevEnd, q.start)) {
    throw parseError(q, "'?' must be immediately adjacent to the preceding type (no whitespace)");
  }
  yield* advance(state);
  return true;
}

function samePosition(a: Position, b: Position): boolean {
  return a.line === b.line && a.column === b.column && a.offset === b.offset;
}
