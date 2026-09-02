/**
 * Expands the schema sugar forms into the constructor applications they denote, between parsing
 * and resolution: `parse -> desugar -> resolve -> link`.
 *
 * **Every sugar form lifts to a closed synthetic entry (§5.3): "the resolver treats `[T]` as a
 * desugaring for `!array { element_type: T }`", and the same rule governs `[T, U]`, `(A | B)` and
 * `{K => V}`.** Doing that expansion once, here, on the AST, is what lets `DefinitionResolver`
 * (a later work package) see only a bare reference or a `!C value` construction — never a
 * container-shaped `TypeRef` — and it is why this phase consults no governing meta at all: the
 * sugar set is closed and grammar-supplied, so the head each form desugars to and the vocabulary
 * field each argument fills are a fixed table, not something read off a constructor's own
 * parameter list.
 *
 * ```text
 * [T]              !array { element_type: T }
 * [T; N..M]        !array { element_type: T  min_items: N  max_items: M }
 * [T?; ...]        the corresponding form with state: OPTIONAL bound directly
 * [T, U]           !tuple { elements: [{ element_type: T } { element_type: U }] }
 * (A | B)          !choice { variants: [A B] }
 * {K => V}         !map   { key_type: K  value_type: V }
 * {K => V?}        !map   { key_type: K  value_type: V  state: OPTIONAL }
 * {K => V; N..M}   the same, with min_items/max_items
 * { x: T }         !record { fields: [{ name: x  type: T }] } -- only inside a *template* (§5.2);
 *                  a non-template record body stays a plain record definition
 * ```
 *
 * **A nested bracket or brace form expands innermost first.** §5.3's declaration-level container
 * syntax nests inside itself (`[[T; N]; N]`, `{text => [order; 1..]}`), so a position holding one
 * has the inner form injected under its own derived name and becomes a bare reference to it —
 * see {@link elementRefOf}. The enclosing container then routes a plain name like any other, at
 * any depth.
 *
 * **A generic application is a user template, and it passes through.** `name<args>` resolves its
 * head through the type-name namespace only (§3.3.1), so it can only ever be a §5.10 template
 * application — substitution happens over the *resolved* form, one phase later, not here. What is
 * checked here is the one thing an AST alone decides: a head this document declares with no
 * parameters takes no arguments at all ({@link checkTemplateApplication}).
 *
 * **Structural sharing.** Every function here returns its input unchanged when nothing beneath it
 * changed, so a document with no sugar comes back as the exact same object. This is not an
 * optimisation: source positions live in an identity-keyed side table (a rewritten node's own
 * position must be carried across by the caller, see {@link desugar}'s `positions` option), so a
 * declaration this phase leaves alone keeps whatever position table entry it already had.
 *
 * **What is deliberately left alone.** Three positions keep their heads intact, because a name
 * there is being *declared* or *composed*, not applied: a declaration's own body reference
 * ({@link ReferenceTypeDef}), a refinement source, and a composition supertype (D5's rule — "a
 * declaration's own body never lifts"). And nothing inside a *parameterized* declaration's body is
 * expanded any differently than outside one — a concrete form inside a template still lifts
 * closed, exactly as it would at top level; only a form naming one of the declaration's own
 * parameters lifts *open* instead (see {@link hoist}).
 *
 * **An invalid sugar form is reported per declaration, not thrown**, when a
 * {@link DesugarFailureReporter} is supplied — so an author sees every independent problem in one
 * pass rather than one per run, matching the same one-pass treatment the resolver and linker give
 * their own phases. {@link desugarOrReport} has the mechanics and {@link absorbed} what a reported
 * declaration is replaced with.
 */

import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import type { Position } from '../core/position.js';
import type { Declaration, SchemaDocument, SchemaMap } from '../ast/schema/document.js';
import type {
  FieldDef,
  FieldModifier,
  GroupDef,
  GroupMember,
  Instance,
  RecordEntry,
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
import type { ElementType, GenericRef, TypeArg, TypeRef } from '../ast/schema/typeref.js';
import type { CoreValue, RecordField, RecordValue, ScopedValue, TokenValue } from '../ast/value.js';
import { canonicalBinding, ofBinding } from './derivedName.js';
import { createMintedNames, type MintedNames } from './mintedNames.js';
import {
  ARGUMENTS,
  FIELDS,
  GROUPS,
  MEMBERS,
  NAME,
  RECORD,
  STATE,
  TYPE,
  VALUE,
  nameField,
  scoped,
  tokenValue,
} from './wireForm.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * Where {@link desugar} sends a declaration whose sugar form is invalid, so the rest of the
 * document still expands and goes on to resolve ([TSON-DATA] §8.1: implementations SHOULD
 * "continue processing after an error to report multiple issues in a single pass").
 *
 * `declaration` is the failing declaration exactly as parsed — identity matters, since it is
 * what any position side-table is keyed on, and a rewritten copy would find no entry there.
 * `error` is a {@link TsonSchemaValidationError} (an invalid sugar form — the author's mistake)
 * or a {@link TsonNotImplementedError} (a construct this library cannot yet expand — a gap, not a
 * verdict on the schema); which is which is the error's own type, and classifying it further is
 * the caller's job, not this phase's.
 */
export interface DesugarFailureReporter {
  reportFailedDeclaration(
    declaration: Declaration,
    error: TsonSchemaValidationError | TsonNotImplementedError,
  ): void;
}

/** Options for {@link desugar}. */
export interface DesugarOptions {
  /**
   * Where an invalid sugar form is reported. Omitted means fail-fast: the first invalid form
   * throws instead, and the document that reaches the throw site is abandoned.
   */
  readonly reporter?: DesugarFailureReporter;
  /**
   * The identity-keyed carryover for a rewritten declaration's source position, mirroring the
   * position side-table a schema parser keeps. **Must be a `WeakMap`** — a structural map here
   * would let two declarations that happen to look alike collide on one key, corrupting whichever
   * one's position lost the race. When a declaration is genuinely rebuilt (it contained sugar),
   * its entry (if any) is re-registered under the node that replaces it, in place, so a caller
   * threading its own position table through several phases sees it stay current. Omit when no
   * position table is in play.
   */
  readonly positions?: WeakMap<Declaration, Position>;
}

/**
 * The document with every expandable sugar form hoisted into its own declaration, or the exact
 * same instance when there was nothing to expand.
 *
 * A declaration whose sugar form is invalid is reported to `options.reporter` and replaced with
 * {@link absorbed}, so the declarations around it still expand and go on to resolve — see
 * {@link desugarOrReport}. With no reporter, the first invalid form throws instead.
 */
export function desugar(
  document: SchemaDocument,
  imported: ReadonlySet<string>,
  options: DesugarOptions = {},
): SchemaDocument {
  const context: DesugarContext = {
    imported,
    local: document.body.declarations,
    injected: new Map<string, Declaration>(),
    minted: createMintedNames(),
    reporter: options.reporter,
    currentParameters: [],
  };
  const body = schemaMapPass(document.body, context, options.positions);
  if (body === document.body && context.injected.size === 0) {
    return document;
  }
  const declarations = new Map(body.declarations);
  for (const [name, declaration] of context.injected) {
    if (declarations.has(name)) {
      throw new TsonInternalError(
        `desugared name '${name}' collides with a declaration already in this schema`,
      );
    }
    declarations.set(name, declaration);
  }
  return { ...document, body: { annotations: body.annotations, declarations } };
}

/**
 * The names `desugared` holds that `original` did not: the entries this phase lifted — exactly
 * the schema's **synthetic entries** (§5.3's lift rule — closed for a concrete form, open for a
 * parameter-bearing one). A caller marks each of these `@synthetic` at its schema-map key (§8.2);
 * a resolver also uses the set to tell a generated head closing its own intermediate form from an
 * authored one.
 *
 * A set difference rather than a field the pass tracks itself, because {@link hoist} does not
 * inject a form an `!!import` already declares — the imported entry *is* the same form, resolved
 * by the schema that owns it, and marking it here would put this schema's own derived marker on
 * someone else's key. What the difference reports is what this document gained.
 */
export function lifted(original: SchemaDocument, desugared: SchemaDocument): ReadonlySet<string> {
  const names = new Set(desugared.body.declarations.keys());
  for (const name of original.body.declarations.keys()) {
    names.delete(name);
  }
  return names;
}

// ── The pass ─────────────────────────────────────────────────────────────────────────────────

/**
 * Per-document walk state, threaded explicitly rather than held as mutable fields on an object:
 * every function below that needs any of this takes a `context` argument, and only
 * {@link DesugarContext.injected} itself is ever mutated in place (by {@link hoist}).
 */
interface DesugarContext {
  /** Names already in scope from `!!import` — see {@link lifted}'s own note on why these are referenced, not redeclared. */
  readonly imported: ReadonlySet<string>;
  /** This document's own declarations, exactly as parsed — for {@link checkTemplateApplication}. */
  readonly local: ReadonlyMap<string, Declaration>;
  /** Declarations synthesised for sugar forms encountered during the walk, keyed by their derived name, insertion order preserved. */
  readonly injected: Map<string, Declaration>;
  /**
   * §8.2's freshness MUST over the names this pass mints, one instance for this whole desugar
   * phase — see `mintedNames.ts`'s own doc on why one phase gets exactly one instance.
   */
  readonly minted: MintedNames;
  readonly reporter: DesugarFailureReporter | undefined;
  /**
   * The type parameters of the declaration currently being walked, empty outside a template. A
   * sugar form naming one of these lifts to an *open* entry rather than a closed one — a closed
   * entry would carry a reference to a parameter nothing has bound (see {@link hoist}).
   */
  readonly currentParameters: readonly string[];
}

/**
 * **The one place a rewritten declaration replaces an original**, and so the one place a source
 * position has to be carried over. A declaration that genuinely contains sugar *is* rebuilt, and
 * without re-registering its position, every diagnostic against it loses its line — not a rare
 * case, since any record with a single `[T]` field is rewritten whole.
 */
function schemaMapPass(
  map: SchemaMap,
  context: DesugarContext,
  positions: WeakMap<Declaration, Position> | undefined,
): SchemaMap {
  let rewritten: Map<string, Declaration> | undefined;
  for (const [name, declaration] of map.declarations) {
    const next = desugarOrReport(declaration, context);
    if (next !== declaration) {
      if (positions !== undefined) {
        const position = positions.get(declaration);
        if (position !== undefined) {
          positions.set(next, position);
        }
      }
      rewritten ??= new Map(map.declarations);
    }
    rewritten?.set(name, next);
  }
  return rewritten === undefined ? map : { annotations: map.annotations, declarations: rewritten };
}

/**
 * One declaration expanded, or — when its sugar form is invalid and a reporter is in play —
 * reported and replaced with {@link absorbed}.
 *
 * **The substitution is not optional.** Leaving a declaration un-expanded would hand the resolver
 * the very container-shaped `TypeRef` this phase exists to remove; passing it through would turn
 * a reported author error into an unreported one downstream. Fail-fast (no reporter) rethrows the
 * original error untouched.
 *
 * **Anything already injected on behalf of a failed declaration stays injected.** Injected names
 * are derived from the binding record itself, so a later declaration containing the same form
 * finds and references the existing entry (§8.2's structural-equality rule); rolling one back
 * because the declaration that reached it first went on to fail would break whichever declaration
 * referenced it second.
 */
function desugarOrReport(declaration: Declaration, context: DesugarContext): Declaration {
  try {
    return declarationPass(declaration, context);
  } catch (error: unknown) {
    if (
      !(error instanceof TsonSchemaValidationError) &&
      !(error instanceof TsonNotImplementedError)
    ) {
      throw error;
    }
    if (context.reporter === undefined) {
      throw error;
    }
    context.reporter.reportFailedDeclaration(declaration, error);
    return {
      nameAnnotations: declaration.nameAnnotations,
      name: declaration.name,
      typeDefAnnotations: declaration.typeDefAnnotations,
      typeDef: absorbed(declaration),
    };
  }
}

function declarationPass(declaration: Declaration, context: DesugarContext): Declaration {
  const local: DesugarContext = {
    ...context,
    currentParameters: typeParamsOf(declaration.typeDef),
  };
  const typeDef = typeDefPass(declaration.typeDef, local);
  return typeDef === declaration.typeDef ? declaration : { ...declaration, typeDef };
}

/**
 * What a declaration whose sugar form was reported is replaced with: a fresh, zero-field record.
 * Producing one means a diagnostic has already been reported — it is reachable only through
 * {@link DesugarFailureReporter}, so a document that expanded cleanly never contains one.
 *
 * **It keeps the declaration's own type parameters**, which is the one declaration-specific thing
 * it carries. Answering "how many type parameters?" with zero would make a downstream `bl<text>`
 * report that `bl` "declares no type parameters", which is a wrong fix for someone else's error —
 * absorbing means answering every question, not answering them all with nothing.
 */
function absorbed(declaration: Declaration): TypeDef {
  return {
    kind: 'structuralTypeDef',
    typeParams: typeParamsOf(declaration.typeDef),
    constructor: false,
    body: { kind: 'recordDef', entries: [] },
  };
}

/** A declaration's declared type parameters, or none. */
function typeParamsOf(typeDef: TypeDef): readonly string[] {
  switch (typeDef.kind) {
    case 'instance':
      return typeDef.typeParams;
    case 'structuralTypeDef':
      return typeDef.typeParams;
    case 'referenceTypeDef':
      return typeDef.typeParams;
    case 'atomRefinement':
      return [];
  }
}

/**
 * `AtomRefinement` and `Instance` are passed through: their target is a bare type name and their
 * payload is a `DataValue` built from the *data* grammar, so neither can carry a schema sugar
 * form.
 */
function typeDefPass(typeDef: TypeDef, context: DesugarContext): TypeDef {
  switch (typeDef.kind) {
    case 'structuralTypeDef':
      return structuralTypeDefPass(typeDef, context);
    case 'referenceTypeDef':
      return referenceTypeDefPass(typeDef, context);
    case 'atomRefinement':
    case 'instance':
      return typeDef;
  }
}

/**
 * A template's body *is* walked: a concrete form inside it lifts to an ordinary closed entry,
 * exactly as it would outside a template — only a form mentioning one of the declaration's own
 * parameters lifts open (`context.currentParameters`, consulted by {@link hoist}).
 *
 * §5.2's own rewrite is applied here, where the body is written: a bare record body inside a
 * *template* denotes `!record { fields: [...] }` (a non-template record body stays a plain
 * record definition), so a record template becomes the construction it always was.
 */
function structuralTypeDefPass(typeDef: StructuralTypeDef, context: DesugarContext): TypeDef {
  const body = structuralDefPass(typeDef.body, context);
  if (typeDef.typeParams.length > 0 && !typeDef.constructor && body.kind === 'recordDef') {
    return instanceOf(recordBinding(body, context.currentParameters), typeDef.typeParams);
  }
  return body === typeDef.body ? typeDef : { ...typeDef, body };
}

/**
 * A declaration's own body reference names what this declaration *is*; only its arguments are
 * expandable (D5's rule — a declaration's own body never lifts, it *becomes* the construction
 * directly rather than a reference to an injected one). Every sugar form reaches this path, since
 * every container form is a `type-ref` like any other, with no separate declaration-level tier.
 */
function referenceTypeDefPass(typeDef: ReferenceTypeDef, context: DesugarContext): TypeDef {
  const binding = bindingOf(typeDef.ref, context);
  if (binding !== undefined) {
    return instanceOf(binding, typeDef.typeParams);
  }
  if (typeDef.typeParams.length > 0) {
    // §5.10's partial application -- `uuid_pair => <B> pair<text, B>` denotes
    // `!reference { target: pair<text, B> }`, spellable because a reference's target is a
    // type-ref. Closes by the same walk as every other template, one phase later.
    return instanceOf(
      {
        head: REFERENCE,
        fields: [{ name: TARGET, value: scoped(refValueOf(typeDef.ref)) }],
        applicationSlots: new Map(),
      },
      typeDef.typeParams,
    );
  }
  const ref = argumentsOnlyPass(typeDef.ref, context);
  return ref === typeDef.ref ? typeDef : { ...typeDef, ref };
}

function structuralDefPass(def: StructuralDef, context: DesugarContext): StructuralDef {
  switch (def.kind) {
    case 'recordDef':
      return recordDefPass(def, context);
    case 'refinedDef': {
      // §5.7 refines a *named* source -- only the target's own arguments are expandable.
      const target = argumentsOnlyPass(def.target, context);
      const body = recordDefPass(def.body, context);
      return target === def.target && body === def.body ? def : { ...def, target, body };
    }
    case 'constructionDef':
      return constructionDefPass(def, context);
  }
}

/** §5.8 composes with named supertypes; only their arguments are expandable. */
function constructionDefPass(def: ConstructionDef, context: DesugarContext): StructuralDef {
  const supertypes = mapShared(def.supertypes, (ref) => argumentsOnlyPass(ref, context));
  const body = def.body === undefined ? undefined : recordDefPass(def.body, context);
  const bodyChanged = def.body !== undefined && body !== def.body;
  return supertypes === def.supertypes && !bodyChanged
    ? def
    : {
        ...def,
        supertypes: supertypes as ConstructionDef['supertypes'],
        ...(body === undefined ? {} : { body }),
      };
}

function recordDefPass(record: RecordDef, context: DesugarContext): RecordDef {
  const entries = mapShared(record.entries, (entry) => recordEntryPass(entry, context));
  return entries === record.entries ? record : { kind: 'recordDef', entries };
}

function recordEntryPass(entry: RecordEntry, context: DesugarContext): RecordEntry {
  if (entry.kind === 'fieldDef') {
    return fieldDefPass(entry, context);
  }
  const members = mapShared(entry.members, (member) => groupMemberPass(member, context));
  return members === entry.members ? entry : { ...entry, members: members as GroupDef['members'] };
}

function fieldDefPass(field: FieldDef, context: DesugarContext): FieldDef {
  if (field.type === undefined) {
    return field; // modifier-only entry -- a §5.7 tightening entry restating state, nothing to expand
  }
  const ref = typeRefPass(field.type.typeRef, context);
  return ref === field.type.typeRef
    ? field
    : { ...field, type: { typeRef: ref, optional: field.type.optional } };
}

function groupMemberPass(member: GroupMember, context: DesugarContext): GroupMember {
  const ref = typeRefPass(member.typeRef, context);
  return ref === member.typeRef ? member : { ...member, typeRef: ref };
}

/**
 * A reference at a position where a sugar form *is* expandable: expands children first, so a
 * nested form is already a plain name by the time the enclosing one is built (`{text => [integer]}`
 * injects the inner array, then the outer map refers to it).
 */
function typeRefPass(ref: TypeRef, context: DesugarContext): TypeRef {
  switch (ref.kind) {
    case 'simpleRef':
      return ref;
    case 'arrayRef':
    case 'tupleRef':
    case 'mapRef':
    case 'choiceRef':
      return hoistOrKeep(bindingOf(ref, context), ref, context);
    case 'genericRef':
      return genericRefPass(ref, context);
  }
}

/** Expands only within a reference's arguments, leaving its own head in place. */
function argumentsOnlyPass(ref: TypeRef, context: DesugarContext): TypeRef {
  return ref.kind === 'genericRef' ? genericRefPass(ref, context) : ref;
}

function genericRefPass(ref: GenericRef, context: DesugarContext): TypeRef {
  checkTemplateApplication(ref.name, context);
  const args = mapShared(ref.args, (arg) => typeArgPass(arg, context));
  return args === ref.args
    ? ref
    : { kind: 'genericRef', name: ref.name, args: args as GenericRef['args'] };
}

function typeArgPass(arg: TypeArg, context: DesugarContext): TypeArg {
  if (arg.kind !== 'ref') {
    return arg;
  }
  const ref = typeRefPass(arg.ref, context);
  return ref === arg.ref ? arg : { kind: 'ref', ref };
}

/**
 * Checks a generic application, which after §3.3.1's type-name-only head resolution can only ever
 * be a §5.10 user-template application: `box => <T> { v: T }` applied as `box<text>`.
 *
 * A record template passes through untouched here — substitution runs over the *resolved* form,
 * one phase later, so this phase leaves the application for that phase to materialise and the
 * head keeps its arguments into resolution. A head this document neither declares nor imports is
 * left alone too: the reference is simply unresolved, a later phase's verdict to deliver. A local
 * head that declares no parameters is an author error: nothing there takes type arguments.
 */
function checkTemplateApplication(head: string, context: DesugarContext): void {
  const declaration = context.local.get(head);
  if (declaration === undefined) {
    return;
  }
  const parameters = typeParamsOf(declaration.typeDef);
  if (parameters.length === 0) {
    throw new TsonSchemaValidationError(
      `'${head}' declares no type parameters, so '${head}<...>' applies arguments to something ` +
        `that takes none (§5.10); drop the argument list`,
    );
  }
}

// ── The desugar table (§5.3): one sugar form, one binding record ───────────────────────────────

/**
 * A sugar form reduced to what it denotes: a fixed constructor head and the vocabulary fields the
 * form binds, in the table's own order. Everything downstream — the emitted `!C { ... }`, the
 * derived entry name, the bound-coherence check — reads this and nothing else.
 *
 * `applicationSlots` holds, for every field whose value is a §5.10 application rather than a bare
 * name, that field's own `TypeRef` — kept whole because an application has no bare-token
 * spelling yet (the entry it denotes does not exist until materialisation), so the open form
 * needs the reference itself, not the entry name it will eventually become.
 */
interface Binding {
  readonly head: string;
  readonly fields: readonly RecordField[];
  readonly applicationSlots: ReadonlyMap<string, TypeRef>;
}

const ARRAY = 'array';
const MAP = 'map';
const TUPLE = 'tuple';
const CHOICE = 'choice';
const REFERENCE = 'reference';

const ELEMENT_TYPE = 'element_type';
const KEY_TYPE = 'key_type';
const VALUE_TYPE = 'value_type';
const MIN_ITEMS = 'min_items';
const MAX_ITEMS = 'max_items';
const ELEMENTS = 'elements';
const VARIANTS = 'variants';
const TARGET = 'target';

/**
 * A declaration-level container as the binding record it denotes, or `undefined` when a position
 * holds a form this phase cannot reduce to a name — which leaves the whole container unexpanded,
 * since a partially reduced one would be a differently-broken shape rather than a recognisable
 * sugar form.
 */
function bindingOf(ref: TypeRef, context: DesugarContext): Binding | undefined {
  switch (ref.kind) {
    case 'arrayRef':
      return arrayBinding(
        elementRefOf(ref.elementType, context),
        ref.elementType.optional,
        ref.size,
        shownElement(ref.elementType),
      );
    case 'mapRef':
      return mapBinding(
        typeRefPass(ref.keyType, context),
        elementRefOf(ref.valueType, context),
        ref.valueType.optional,
        ref.size,
      );
    case 'tupleRef':
      return tupleBinding(
        ref.elementTypes.map((element) => ({
          typeRef: elementRefOf(element, context),
          optional: element.optional,
        })),
      );
    case 'choiceRef':
      return choiceBinding(mapShared(ref.variants, (variant) => typeRefPass(variant, context)));
    default:
      return undefined;
  }
}

/** One position of a tuple after expansion: the type it names, and whether it is marked OPTIONAL. */
interface TuplePosition {
  readonly typeRef: TypeRef;
  readonly optional: boolean;
}

/**
 * Whether a position holds something this table can put in a type slot: a name, or a name
 * carrying arguments. Anything else is a sugar form the caller was supposed to have expanded
 * first.
 */
function isReference(ref: TypeRef): boolean {
  return ref.kind === 'simpleRef' || ref.kind === 'genericRef';
}

/**
 * `!array { element_type: T [state: OPTIONAL] [min_items: N] [max_items: M] }` — the whole array
 * row of the desugar table, the unsized and sized spellings alike.
 *
 * The element `?` binds `state` directly, alongside the bounds rather than through them: §5.3's
 * `[T?; 3]` states both at once and both land on the one record. An unmarked element states
 * nothing at all and lets §5.2's REQUIRED default supply it.
 */
function arrayBinding(
  element: TypeRef,
  optional: boolean,
  size: SizeSpec | undefined,
  shown: string,
): Binding | undefined {
  if (!isReference(element)) {
    return undefined;
  }
  const fields: RecordField[] = [];
  const applicationSlots = new Map<string, TypeRef>();
  refSlot(ELEMENT_TYPE, element, fields, applicationSlots);
  if (optional) {
    fields.push(nameField(STATE, 'OPTIONAL'));
  }
  if (size !== undefined) {
    fields.push(...sizeFields(size, `[${shown}; 0..]`));
  }
  checkBounds(fields);
  return { head: ARRAY, fields, applicationSlots };
}

/**
 * `!map { key_type: K  value_type: V [state: OPTIONAL] [min_items: N] [max_items: M] }` — the map
 * row. `state` governs the entry value, as `array`'s governs the element: `{K => V?}` binds
 * `OPTIONAL` and admits the absent sentinel there (§5.3, §7.6). The key side carries none — an
 * absent key is already a Part 1 resolver error.
 */
function mapBinding(
  key: TypeRef,
  value: TypeRef,
  valueOptional: boolean,
  size: SizeSpec | undefined,
): Binding | undefined {
  if (!isReference(key) || !isReference(value)) {
    return undefined;
  }
  const fields: RecordField[] = [];
  const applicationSlots = new Map<string, TypeRef>();
  refSlot(KEY_TYPE, key, fields, applicationSlots);
  refSlot(VALUE_TYPE, value, fields, applicationSlots);
  if (valueOptional) {
    fields.push(nameField(STATE, 'OPTIONAL'));
  }
  if (size !== undefined) {
    fields.push(...sizeFields(size, `{${shownRef(key)} => ${shownRef(value)}; 0..}`));
  }
  checkBounds(fields);
  return { head: MAP, fields, applicationSlots };
}

/**
 * How a map side is quoted back in the one diagnostic that shows the form. Only ever called with
 * an {@link isReference} `ref` (a `simpleRef` or `genericRef`), never a container form.
 */
function shownRef(ref: TypeRef): string {
  if (ref.kind === 'simpleRef') {
    return ref.name;
  }
  if (ref.kind === 'genericRef') {
    return `${ref.name}<...>`;
  }
  throw new TsonInternalError('shownRef is only ever called with a simpleRef or genericRef');
}

/**
 * `!tuple { elements: [{ element_type: T } { element_type: U }] }` — the tuple row.
 *
 * Distinct from {@link choiceBinding} in what one position *is*: a tuple element is a
 * `tuple_element` record carrying a type *and* its own state, where a choice variant is a bare
 * type-ref, so each tuple position needs a record built for it rather than a name token.
 */
function tupleBinding(positions: readonly TuplePosition[]): Binding {
  const elements: ScopedValue[] = positions.map((position) => {
    const members: RecordField[] = [
      { name: ELEMENT_TYPE, value: scoped(refValueOf(position.typeRef)) },
    ];
    if (position.optional) {
      members.push(nameField(STATE, 'OPTIONAL'));
    }
    return scoped(recordValue(members));
  });
  return {
    head: TUPLE,
    fields: [{ name: ELEMENTS, value: scoped(arrayValue(elements)) }],
    applicationSlots: new Map(),
  };
}

/**
 * `!choice { variants: [A B ...] }` — the choice row. Variants arrive already expanded: a nested
 * inline form was hoisted by the caller first, so what reaches here is a bare name or, for a
 * §5.10 application (which has no entry to be hoisted to until materialisation mints one), a
 * `type_ref` application spelled through {@link refValueOf}.
 *
 * Distinctness of the variants (§5.4) is deliberately not checked here — it is a question about
 * what the names *resolve* to, after reference flattening, which this phase has no answer to.
 */
function choiceBinding(variants: readonly TypeRef[]): Binding {
  const members: ScopedValue[] = variants.map((variant) => scoped(refValueOf(variant)));
  return {
    head: CHOICE,
    fields: [{ name: VARIANTS, value: scoped(arrayValue(members)) }],
    applicationSlots: new Map(),
  };
}

/**
 * `!record { fields: [ { name: x  type: T } ... ] }` — §5.2's own rewrite of a bare record body,
 * applied where the body is written so that a record template holds an application like every
 * other open form.
 *
 * **Only what the author wrote is written.** A field's unmarked `REQUIRED` is the `record`
 * constructor's own default, so it is never stated — the same economy {@link arrayBinding} makes
 * with an unmarked element's `state`.
 */
function recordBinding(record: RecordDef, parameters: readonly string[]): Binding {
  const fields: ScopedValue[] = [];
  const groups: ScopedValue[] = [];
  const seen = new Set<string>();
  for (const entry of record.entries) {
    if (entry.kind === 'fieldDef') {
      requireFieldNameUnseen(entry.name, seen, 'this body declares it twice');
      fields.push(recordFieldValue(entry, parameters));
      continue;
    }
    const members: ScopedValue[] = [];
    for (const member of entry.members) {
      requireFieldNameUnseen(
        member.name,
        seen,
        "a group member repeats it -- member labels share the enclosing record's field namespace",
      );
      // A group's members are ordinary OPTIONAL fields of the record; the group itself records
      // only their names and its own state (§5.11).
      fields.push(
        scoped(
          recordValue([
            nameField(NAME, member.name),
            { name: TYPE, value: scoped(refValueOf(member.typeRef)) },
            nameField(STATE, 'OPTIONAL'),
          ]),
          member.annotations,
        ),
      );
      members.push(scoped(tokenValue(member.name, 'unquoted')));
    }
    const groupFields: RecordField[] = [{ name: MEMBERS, value: scoped(arrayValue(members)) }];
    if (entry.optional) {
      groupFields.push(nameField(STATE, 'OPTIONAL'));
    }
    groups.push(scoped(recordValue(groupFields), entry.annotations));
  }
  const binding: RecordField[] = [{ name: FIELDS, value: scoped(arrayValue(fields)) }];
  if (groups.length > 0) {
    binding.push({ name: GROUPS, value: scoped(arrayValue(groups)) });
  }
  return { head: RECORD, fields: binding, applicationSlots: new Map() };
}

/**
 * §5.11's uniqueness rule over the body this phase is rewriting: a field name is unique across a
 * record's plain fields and all its groups' members. Asked here as well as by a later resolution
 * phase, and asking it twice is not duplication — this copy sees a template's body, the other a
 * closed one, and after normalisation those are two different phases.
 */
function requireFieldNameUnseen(name: string, seen: Set<string>, explanation: string): void {
  if (seen.has(name)) {
    throw new TsonSchemaValidationError(
      `field '${name}' is declared more than once -- ${explanation} (§5.11: a field name is ` +
        "unique across a record's plain fields and all its groups' members)",
    );
  }
  seen.add(name);
}

/**
 * One `record_field`, with `state` and `value` written only where the author's marks say
 * something the constructor's own defaults do not.
 */
function recordFieldValue(field: FieldDef, parameters: readonly string[]): ScopedValue {
  if (field.type === undefined) {
    throw new TsonSchemaValidationError(
      `field '${field.name}' states only a modifier and no type-ref, but names no inherited ` +
        'field to take a type from -- a modifier-only entry is always a tightening, so it is ' +
        'only meaningful in a refinement or composition body, against a field the source ' +
        'declares (§5.7)',
    );
  }
  const resolved = resolveFieldModifiers(
    field.name,
    field.type.optional,
    field.modifier,
    parameters,
  );
  const members: RecordField[] = [
    nameField(NAME, field.name),
    { name: TYPE, value: scoped(refValueOf(field.type.typeRef)) },
  ];
  if (resolved.state !== 'REQUIRED') {
    members.push(nameField(STATE, resolved.state));
  }
  if (resolved.value !== undefined) {
    members.push({ name: VALUE, value: scoped(resolved.value) });
  }
  return scoped(recordValue(members), field.annotations);
}

/** The five `field_state` (§8.1) spellings a resolved field can carry. */
type FieldStateName =
  'REQUIRED' | 'REQUIRED_DEFAULT' | 'REQUIRED_FIXED' | 'OPTIONAL' | 'OPTIONAL_FIXED';

interface ResolvedFieldModifier {
  readonly state: FieldStateName;
  readonly value?: TokenValue;
}

/**
 * §5.2's field-state table: a field's presence marker and value modifier decide its state and
 * what value, if any, rides with it. The table is closed and consults nothing but the two marks
 * the author wrote, which is why it can be answered before a field's type is known.
 *
 * A token naming a type parameter rides `value` like any other (§5.7's "Open modifiers"); nothing
 * here labels it as one — §8.1's shadowing rule (a token is a parameter exactly when its text
 * resolves into the enclosing entry's own parameter list) is what tells the two apart wherever the
 * question is asked. What a parametric modifier does decide is the `state` beside it.
 *
 * @throws {@link TsonSchemaValidationError} for the three spellings §5.2 rules out: `~ _` on any
 *   field, `= _` on a required one, and a default on an optional one.
 */
function resolveFieldModifiers(
  fieldName: string,
  optional: boolean,
  modifier: FieldModifier | undefined,
  parameters: readonly string[],
): ResolvedFieldModifier {
  if (modifier === undefined) {
    return { state: optional ? 'OPTIONAL' : 'REQUIRED' };
  }
  const fixed = modifier.kind === 'fixed';
  if (modifier.value.kind === 'absent') {
    // §5.2's sixth spelling, `field: type? = _`: OPTIONAL_FIXED carrying no value at all.
    if (!fixed) {
      throw new TsonSchemaValidationError(
        `field '${fieldName}' uses '~ _' -- a required field cannot fall back to not-being-` +
          "filled, so an absent default is a resolver error on any field (§5.2). Write 'type?' " +
          'for a field that may be absent',
      );
    }
    if (!optional) {
      throw new TsonSchemaValidationError(
        `field '${fieldName}' fixes a required field to absent ('= _') -- a field cannot be ` +
          'both required and forbidden from being present (§5.2). Make it optional ' +
          `('${fieldName}: type? = _') to forbid its value while keeping it in the contract`,
      );
    }
    return { state: 'OPTIONAL_FIXED' };
  }
  const token = modifier.value.token;
  if (optional && !fixed) {
    throw new TsonSchemaValidationError(
      `field '${fieldName}' gives an optional field a default ('type? ~ value') -- a default ` +
        "implies the field is always present, which contradicts optional (§5.2). Use 'type ~ " +
        "value' for a fallback, 'type?' for absence, or 'type? = value' for present-implies-value",
    );
  }
  // §5.7's "Open modifiers": a parametric modifier lands in a REQUIRED-family state whatever the
  // presence axis says, since nothing is fixed at declaration -- the value arrives at
  // application, and every application MUST bind every parameter.
  if (parameters.includes(token.text)) {
    return { state: fixed ? 'REQUIRED' : 'REQUIRED_DEFAULT', value: token };
  }
  const state: FieldStateName = optional
    ? 'OPTIONAL_FIXED'
    : fixed
      ? 'REQUIRED_FIXED'
      : 'REQUIRED_DEFAULT';
  return { state, value: token };
}

/**
 * §5.3's size specifier as the `min_items`/`max_items` pair it binds — one rule for arrays and
 * maps alike, since both constructors declare the same two fields. An exact `N` pins both, so
 * `[T; 3]` and `[T; 3..3]` land on the very same entry.
 *
 * **A zero floor is rejected** rather than desugared (§5.3's own rule): identity is structural
 * (§8.2), so `[T; 0..]` would land on an entry distinct from the unbounded `[T]` that means
 * exactly the same thing. Only a literal `0` is caught — a bound naming a value parameter is not
 * concrete until materialisation.
 */
function sizeFields(size: SizeSpec, shown: string): RecordField[] {
  switch (size.kind) {
    case 'min':
      if (size.lower === '0') {
        throw new TsonSchemaValidationError(
          `'${shown}' pins a floor of zero, which every container already satisfies -- drop the ` +
            'size specifier for the unconstrained form (§5.3). The spelling is not merely ' +
            'redundant: identity is structural (§8.2), so it lands on an entry distinct from the ' +
            'unconstrained one that means the same thing',
        );
      }
      return [nameField(MIN_ITEMS, size.lower)];
    case 'max':
      return [nameField(MAX_ITEMS, size.upper)];
    case 'ranged':
      return [nameField(MIN_ITEMS, size.lower), nameField(MAX_ITEMS, size.upper)];
    case 'exact':
      return [nameField(MIN_ITEMS, size.bound), nameField(MAX_ITEMS, size.bound)];
  }
}

/**
 * §5.3's bound-coherence rule on the `min_items`/`max_items` pair, applying identically to arrays
 * and maps: a resolver error where both bounds are literal at schema load. A bound that names a
 * value parameter is not concrete here, and checking it is a materialisation-time question.
 */
function checkBounds(fields: readonly RecordField[]): void {
  let min: bigint | undefined;
  let max: bigint | undefined;
  for (const field of fields) {
    if (field.name !== MIN_ITEMS && field.name !== MAX_ITEMS) {
      continue;
    }
    const value = field.value.value.coreValue;
    if (value.kind !== 'token') {
      continue;
    }
    const parsed = tryParseDecimalInteger(value.text);
    if (parsed === undefined) {
      return; // a bound that is not a literal -- nothing concrete to compare yet
    }
    if (field.name === MIN_ITEMS) {
      min = parsed;
    } else {
      max = parsed;
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new TsonSchemaValidationError(
      `a size specifier binds min_items ${min.toString()} above max_items ${max.toString()} -- a ` +
        'container size range must satisfy min <= max (§5.3), and no value can ever satisfy this one',
    );
  }
}

/**
 * A plain (no digit separators, no radix prefix) signed decimal integer literal, or `undefined`
 * when `text` is not one — the shape a size-spec bound's raw token text has whenever it names a
 * concrete number rather than a template parameter.
 */
function tryParseDecimalInteger(text: string): bigint | undefined {
  let start = 0;
  let negative = false;
  if (text.startsWith('+') || text.startsWith('-')) {
    negative = text.startsWith('-');
    start = 1;
  }
  if (start >= text.length) {
    return undefined;
  }
  for (let i = start; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      return undefined;
    }
  }
  const magnitude = BigInt(text.slice(start));
  return negative ? -magnitude : magnitude;
}

// ── Hoisting: a sugar form becomes a declaration plus a reference to it ────────────────────────

/** `!head { field: value ... }` — the construction a binding record denotes. */
function instanceOf(binding: Binding, typeParams: readonly string[] = []): Instance {
  return {
    kind: 'instance',
    typeParams,
    value: { annotations: [], typeRef: binding.head, coreValue: recordValue(binding.fields) },
  };
}

function hoistOrKeep(
  binding: Binding | undefined,
  unexpanded: TypeRef,
  context: DesugarContext,
): TypeRef {
  return binding === undefined ? unexpanded : hoist(binding, context);
}

/**
 * Records an injected declaration under its derived name and returns the reference that replaces
 * the sugar.
 *
 * **Which entry it lifts to is the one rule that decides open vs. closed.** A form naming none of
 * the enclosing declaration's parameters lifts *closed* — an ordinary construction referenced by
 * a bare name — whether or not the declaration around it is itself a template. A form naming one
 * lifts *open*: a template over just the parameters it uses, referenced by an application binding
 * them straight back through. `<T> { a: [T]  b: [order] }` therefore injects one of each, and
 * only the first has to wait for materialisation.
 */
function hoist(binding: Binding, context: DesugarContext): TypeRef {
  const parameters = parametersIn(binding, context.currentParameters);
  if (parameters.length === 0) {
    const name = bindingName(binding);
    inject(name, binding, () => instanceOf(binding), context);
    return { kind: 'simpleRef', name };
  }
  const renamed = positionalNames(binding, parameters);
  const normalised = rename(binding, parameters, renamed);
  const name = bindingName(normalised);
  inject(name, normalised, () => instanceOf(normalised, renamed), context);
  return {
    kind: 'genericRef',
    name,
    args: asNonEmpty(
      parameters.map((parameter): TypeArg => ({
        kind: 'ref',
        ref: { kind: 'simpleRef', name: parameter },
      })),
    ),
  };
}

/**
 * Injects `declaration` under `name`, unless the same form already claimed it — §8.2's freshness
 * MUST, decided rather than assumed (`mintedNames.ts`'s own doc). `binding` is the form `name` was
 * derived from, canonically rendered here for {@link MintedNames.claim} to compare against
 * whatever that name was first claimed with; a mismatch is a genuine 32-bit hash collision between
 * two distinct forms; TS's own `claim` throws for that rather than silently overwriting the
 * earlier declaration.
 */
function inject(
  name: string,
  binding: Binding,
  build: () => Instance,
  context: DesugarContext,
): void {
  if (context.imported.has(name)) {
    return;
  }
  if (context.minted.claim(name, canonicalBinding(binding.head, binding.fields))) {
    context.injected.set(name, {
      nameAnnotations: [],
      name,
      typeDefAnnotations: [],
      typeDef: build(),
    });
  }
}

/**
 * Every parameter of the enclosing declaration this binding record names, in the order the
 * declaration lists them — the form's own parameter list, and the argument list of the reference
 * that replaces it.
 *
 * Asked of the resolved record, not of the source form, so a parameter reaches it the same way
 * whichever channel carried it: `[T]` names one in a type slot and `[order; N]` in a value slot,
 * and §5.3's size specifier keeps its bound as raw token text precisely because it may be either.
 */
function parametersIn(binding: Binding, currentParameters: readonly string[]): string[] {
  const found: string[] = [];
  for (const parameter of currentParameters) {
    if (binding.fields.some((field) => namesToken(field.value.value.coreValue, parameter))) {
      found.push(parameter);
    }
  }
  return found;
}

/** Whether `value`, or anything nested inside it, is the bare unquoted token `text`. */
function namesToken(value: CoreValue, text: string): boolean {
  switch (value.kind) {
    case 'token':
      return value.text === text;
    case 'array':
      return value.elements.some((element) => namesToken(element.value.coreValue, text));
    case 'record':
      return value.fields.some((field) => namesToken(field.value.value.coreValue, text));
    case 'map':
    case 'empty-brace':
    case 'absent':
      return false;
  }
}

/**
 * The names an open form's own parameters take: `p0`, `p1`, ... positionally.
 *
 * **Renaming is what makes an open entry identify with its equals.** Two forms alike up to a
 * consistent renaming of parameters are one template (§8.2), so `<T> [T]` and `<A> [A]` have to
 * land on one entry — and since the name is derived from the record, normalising the record is
 * what normalises the name.
 *
 * The prefix grows until it collides with nothing the record already names: a binding may hold a
 * concrete reference to a type genuinely called `p0`, and renaming a parameter on top of it would
 * make the two indistinguishable in the body that results.
 */
function positionalNames(binding: Binding, parameters: readonly string[]): string[] {
  let prefix = 'p';
  for (;;) {
    const names = parameters.map((_, index) => `${prefix}${String(index)}`);
    const clash = names.some(
      (name) =>
        !parameters.includes(name) &&
        binding.fields.some((field) => namesToken(field.value.value.coreValue, name)),
    );
    if (!clash) {
      return names;
    }
    prefix += 'p';
  }
}

/** The same binding record with each parameter token replaced by its positional name. */
function rename(
  binding: Binding,
  parameters: readonly string[],
  renamed: readonly string[],
): Binding {
  const substitution = new Map<string, string>();
  for (let i = 0; i < parameters.length; i += 1) {
    const parameter = parameters[i];
    const target = renamed[i];
    if (parameter === undefined || target === undefined) {
      throw new TsonInternalError('positionalNames must return exactly one name per parameter');
    }
    substitution.set(parameter, target);
  }
  const applicationSlots = new Map<string, TypeRef>();
  binding.applicationSlots.forEach((ref, slot) =>
    applicationSlots.set(slot, renameRef(ref, substitution)),
  );
  return {
    head: binding.head,
    fields: binding.fields.map((field) => ({
      name: field.name,
      value: renameScoped(field.value, substitution),
    })),
    applicationSlots,
  };
}

/** An application's own arguments renamed alongside the wire record beside it, so the two stay in step. */
function renameRef(ref: TypeRef, substitution: ReadonlyMap<string, string>): TypeRef {
  if (ref.kind === 'simpleRef') {
    const renamed = substitution.get(ref.name);
    return renamed === undefined ? ref : { kind: 'simpleRef', name: renamed };
  }
  if (ref.kind !== 'genericRef') {
    throw new TsonInternalError('an application slot may only ever hold a simpleRef or genericRef');
  }
  const args = asNonEmpty(
    ref.args.map((argument): TypeArg =>
      argument.kind === 'ref'
        ? { kind: 'ref', ref: renameRef(argument.ref, substitution) }
        : argument,
    ),
  );
  return { kind: 'genericRef', name: ref.name, args };
}

function renameScoped(scoped: ScopedValue, substitution: ReadonlyMap<string, string>): ScopedValue {
  return {
    ...scoped,
    value: { ...scoped.value, coreValue: renameValue(scoped.value.coreValue, substitution) },
  };
}

function renameValue(value: CoreValue, substitution: ReadonlyMap<string, string>): CoreValue {
  switch (value.kind) {
    case 'token': {
      const renamed = substitution.get(value.text);
      return renamed === undefined ? value : { kind: 'token', text: renamed, form: value.form };
    }
    case 'array':
      return {
        kind: 'array',
        elements: value.elements.map((element) => renameScoped(element, substitution)),
      };
    case 'record':
      return {
        kind: 'record',
        fields: value.fields.map((field) => ({
          name: field.name,
          value: renameScoped(field.value, substitution),
        })),
      };
    case 'map':
    case 'empty-brace':
    case 'absent':
      return value;
  }
}

/**
 * The type-ref an element or map-value position denotes: an ordinary reference expanded the usual
 * way, or a **nested declaration-level form** hoisted into its own declaration and replaced by its
 * name.
 *
 * §5.3's declaration-level container syntax nests inside itself (`[[T; 2], U]`,
 * `{text => [order; 1..]}`), and the inner form desugars first — the bottom-up hoist
 * {@link typeRefPass} already performs for an inline form, one tier down.
 */
function elementRefOf(element: ElementType, context: DesugarContext): TypeRef {
  return typeRefPass(element.typeRef, context);
}

/**
 * How an element position was spelled, for the one diagnostic that quotes the sugar form back at
 * its author: the position's own name when it has one, and a stand-in when it is an inline or
 * nested form whose expansion carries a derived name the author never wrote.
 */
function shownElement(element: ElementType): string {
  return element.typeRef.kind === 'simpleRef' ? element.typeRef.name : 'T';
}

// ── Wire-value builders ──────────────────────────────────────────────────────────────────────
//
// `nameField`/`scoped`/`tokenValue` are `wireForm.ts`'s own — see this module's import list.
// `recordValue`/`arrayValue` are small local conveniences over the two `CoreValue` shapes this
// phase builds most, not part of that shared vocabulary.

function recordValue(fields: readonly RecordField[]): RecordValue {
  return { kind: 'record', fields };
}

function arrayValue(elements: readonly ScopedValue[]): CoreValue {
  return { kind: 'array', elements };
}

/**
 * A scalar type slot as both of the things downstream needs it as: the wire field a closed
 * construction writes, and — when the reference carries arguments — the reference itself, kept
 * whole for the open form to bind.
 */
function refSlot(
  slot: string,
  ref: TypeRef,
  fields: RecordField[],
  applicationSlots: Map<string, TypeRef>,
): void {
  fields.push({ name: slot, value: scoped(refValueOf(ref)) });
  if (ref.kind !== 'simpleRef') {
    applicationSlots.set(slot, ref);
  }
}

/**
 * What a `type_ref`-typed slot holds: a bare token for a plain name, `type_ref`'s record form for
 * an application. **One spelling per shape, produced in one place** — a slot written two ways is
 * a slot two phases disagree about, and `derivedName.ts`'s own `ofBinding` hashes what is
 * written, so a second spelling of one reference would split one type across two entries.
 *
 * This is the AST-layer half of that one spelling — it operates on `ast/schema/typeref.js`'s own
 * (unresolved) `TypeRef`, since desugaring runs before resolution. `wireForm.ts`'s own `refValue`
 * is the resolved-layer twin, over `schema/meta`'s `TypeRef` — a held composition/refinement
 * template's fields are already resolved by the time they are held, so that function cannot reuse
 * this one, but both spell the shape identically by construction (see its own doc).
 */
function refValueOf(ref: TypeRef): CoreValue {
  if (ref.kind === 'simpleRef') {
    return tokenValue(ref.name, 'unquoted');
  }
  if (ref.kind === 'genericRef') {
    return refRecordOf(ref);
  }
  throw new TsonInternalError('refValueOf is only ever called with a simpleRef or genericRef');
}

/**
 * `{ name: head  arguments: [ { name: A } ] }` — `type_ref`'s record form, which is how a closed
 * slot carries an application through the constructor's own reader.
 *
 * By the time this runs, every argument's own reference has already passed through
 * {@link typeRefPass} (as part of expanding the `GenericRef` this record form is spelling), so an
 * argument here is always a bare name or a further application — never an inline container form —
 * which is the invariant the two `TypeArg.Ref` branches below rely on.
 */
function refRecordOf(generic: GenericRef): RecordValue {
  const args: ScopedValue[] = generic.args.map((argument) => {
    if (argument.kind === 'value') {
      return scoped(recordValue([{ name: VALUE, value: scoped(argument.value) }]));
    }
    const inner = argument.ref;
    if (inner.kind === 'genericRef') {
      return scoped(recordValue([{ name: NAME, value: scoped(refRecordOf(inner)) }]));
    }
    if (inner.kind === 'simpleRef') {
      return scoped(recordValue([nameField(NAME, inner.name)]));
    }
    throw new TsonInternalError(
      'a type argument reference may only ever be a simpleRef or genericRef by this point in the walk',
    );
  });
  return recordValue([
    nameField(NAME, generic.name),
    { name: ARGUMENTS, value: scoped(arrayValue(args)) },
  ]);
}

// ── Internal names (§8.2) ────────────────────────────────────────────────────────────────────

function bindingName(binding: Binding): string {
  return ofBinding(binding.head, binding.fields);
}

// ── Small shared helpers ─────────────────────────────────────────────────────────────────────

/**
 * Asserts `items` is non-empty and returns it typed as such. Only ever called where the caller
 * already knows this by construction (a non-empty `parameters` list, an application's own
 * argument list); the runtime check is a defensive backstop, not a real possibility.
 */
function asNonEmpty<T>(items: readonly T[]): readonly [T, ...T[]] {
  if (items.length === 0) {
    throw new TsonInternalError('expected a non-empty array');
  }
  return items as unknown as readonly [T, ...T[]];
}

/**
 * Maps `items`, returning the exact original array when every element came back identical. The
 * reference-equality check is what lets an unchanged subtree propagate "nothing changed" all the
 * way up rather than rebuilding every ancestor.
 */
function mapShared<T>(items: readonly T[], rewrite: (item: T) => T): readonly T[] {
  let out: T[] | undefined;
  for (const [i, item] of items.entries()) {
    const mapped = rewrite(item);
    if (mapped !== item) {
      out ??= items.slice();
    }
    if (out !== undefined) {
      out[i] = mapped;
    }
  }
  return out ?? items;
}
