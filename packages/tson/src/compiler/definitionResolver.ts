/**
 * Resolves declarations from a `SchemaMap` (the grammar-layer AST, `ast/schema/`) into
 * entry values (`schema/meta`'s `Top`, Part 2 §4, §8) — an incremental, deliberately narrow resolver, not the full
 * two-pass resolver of §3.4.1. Ported from the reference implementation's `DefinitionResolver`
 * (`tson-compiler/.../resolver/DefinitionResolver.java`); see that file's own module doc for the
 * exhaustive list of which eight constructs are handled and which are explicitly out of scope
 * (reported as `TsonNotImplementedError` rather than silently mis-resolved).
 *
 * **The one structural divergence from the Java, worth restating here.** §5.6's atom-refinement
 * merge (`mergeWithSource` below) must run on the *wire record* before binding — the Java achieves
 * that by holding a `TsonObjectWriter`, which is why the writers cannot leave `tson-compiler`.
 * This port does not reproduce that: a caller supplies {@link SourceBodyEncoder}
 * (`resolverTypes.ts`), a plain `(body: Top) => CoreValue` function assembled from
 * `bind/encode.ts`'s `toCoreValue` and `schema/bindings.ts`'s `topBinding` — from a place that can
 * see both `bind/` and `schema/meta/`, which `compiler/` itself may not (`eslint.config.js`'s
 * `compiler-must-not-import-bind` zone). No text round trip, no writer dependency inside this
 * module.
 *
 * **Two namespaces, both required constructor parameters (§3.3.1).** `namespaceDefinitions` is
 * the type-name namespace (entries already resolved earlier in the same schema map — a
 * caller-owned, growing map; this module never populates it, only reads through the
 * {@link DefinitionGetter} function a caller supplies). `metaDefinitions` is the structure
 * namespace (the governing meta-schema's own entries, one hop via `!!meta`, consulted only for a
 * constructor-application target). Either may be a lookup that always returns `undefined`, for a
 * caller that never needs it (e.g. a bootstrap pass that never reaches `resolveInstance`).
 *
 * **Kind determination (§4.1)** checks the transitive supertype chain for the literal,
 * kernel-fixed names `atom`/`product`/`sum`/`data` — not "inherit the nearest ancestor's own
 * kind" (`atom` the entry is itself `kind: PRODUCT`, since its own chain is just `[top]`). Zero
 * found → `PRODUCT`; exactly one → that kind; two or more → a resolver error.
 *
 * **Applicability is IS-A `top` (§3.3.1, §4.2), never a marker.** `!C value` and `<...> !C
 * value` both resolve `C` against the structure namespace and require {@link isConstructor}
 * (IS-A `top`, derived from `supertypes`) — the kernel's `reference` included, applied like any
 * other constructor (`!reference { target: X }` denotes the alias `X`). Composition and
 * refinement carry the placement consequence themselves: an ordinary declaration that composes
 * or refines a constructor thereby IS-A `top` too (`supertypes` says so), so there is exactly one
 * rule to check applicability against, never a second "is this really meant to be a constructor"
 * guard beside it. `~` plays no part in any of this — it has left the type-def head entirely
 * (`schemaParser.ts`); a source document that writes one there fails in the parser.
 *
 * **Atom refinement's own test is on the body, and on nothing else (§5.5)** — see
 * {@link resolveAtomRefinement}'s own note for why neither IS-A nor kind can stand in for it.
 *
 * **Field groups (§5.11) flatten**: each member becomes an ordinary `RecordField` in source
 * position with `optional: true` regardless of the group's own `optional` (a group that must be
 * chosen still leaves each *member* individually omittable — one option is chosen, not which); the
 * group itself is recorded separately as a `FieldGroup`: its options, the members marked `?`
 * within them, and whether the group as a whole may be left out. A group that must be chosen
 * admits exactly one option, an optional one at most one, and the `+` form any non-empty subset
 * of its members. A composed supertype's groups are inherited
 * whole, in supertype order, ahead of the body's own.
 *
 * **`subtypes` is never populated** — the reverse index over a whole resolved schema is a global
 * pass, not a per-declaration concern; deliberately deferred to a later work package (linking).
 *
 * **`parameters` (§5.10) threads straight through** from a fresh record's or composition's own
 * type-parameter list, with no substitution into field types and no validation that a parameter
 * is actually used — substitution is materialisation's own, later, whole-schema pass.
 */
import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import {
  TsonBindMismatchError,
  TsonMissingBindingError,
  TsonReadError,
  TsonNameHygieneRefusedError,
  TsonRefusedError,
} from '../core/errors.js';
import { DEFAULT_MAX_SUPERTYPE_CHAIN, supertypeChainLimitRefusal } from '../core/limits.js';
import type { DataValue, RecordValue, ScopedValue } from '../ast/value.js';
import { asciiLowercase } from '../unicode/normalization.js';
import type { Annotation as WrittenAnnotation } from '../ast/value.js';
import type { Declaration } from '../ast/schema/document.js';
import type { ConstructionDef, RefinedDef, TypeDef } from '../ast/schema/typedef.js';
import type {
  AtomRefinement,
  FieldDef,
  GroupDef,
  GroupMember,
  Instance,
  RecordEntry,
  RemovalSet,
} from '../ast/schema/fields.js';
import type { GenericRef, TypeArg, TypeRef as AstTypeRef } from '../ast/schema/typeref.js';
import type { SourcePosition } from '../schema/meta/position.js';
import type {
  Annotation,
  Annotations,
  EntryFacts,
  EntryKind,
  Reference,
  Scoped,
  Top,
  TypeArgument,
  TypeRef,
} from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  subtypesOf,
  supertypesOf,
  typeChain,
  withChain,
  withoutChain,
} from '../schema/meta/typedef.js';
import { groupMembers, lowerGroup } from './groupLowering.js';
import {
  spellGroup,
  fieldMapOf,
  fieldOmission,
  isGroupMember,
  namedFields,
  TYPE_KIND,
  type FieldGroup,
  type FieldOmission,
  type NamedField,
  type RecordBody,
  type RecordExtensionType,
  type TemplateParam,
} from '../schema/meta/bodies.js';
import type { Token } from '../schema/meta/typedef.js';
import { tryParseNumber } from '../base/numberGrammar.js';
import { toExactDecimal, toExactInteger } from '../base/numberNarrowing.js';
import { toNfc } from '../unicode/nfc.js';
import type { TsonDecimal } from '../value/types.js';
import type {
  AnnotationValueReader,
  ApplicationChecker,
  ApplicationCloser,
  DeclaredApplicationCloser,
  DefinitionGetter,
  DefinitionMetaReader,
  EntryFactsTable,
  SourceBodyEncoder,
} from './resolverTypes.js';
import { createHeldBody, heldOf } from './heldBody.js';
import {
  DISCRIMINATORS,
  EXTENSION,
  field as wireField,
  nameField,
  refValue,
  scoped,
} from './wireForm.js';
import { substitute } from './templateSubstitution.js';
import { resolveFieldMarks } from './fieldModifiers.js';
import { checkAtomCoherence, checkAtomNarrows, isAtom } from './atomChecks.js';
import { terminal, terminalDefinition } from '../link/referenceChain.js';
import { metaFormOfLexer } from './tokenForms.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * Every dependency `resolve`/`annotationsFor` need beyond the declaration in hand — see
 * `resolverTypes.ts` for what each function type is for and why it is a caller-supplied
 * dependency rather than something this module reaches for itself.
 *
 * `facts` is the table each declaration's {@link EntryFacts} are recorded in as it resolves --
 * shared with the caller, which assembles the resolved schema from it, and holding imported
 * entries' facts too, so an atom refinement finds the constructor its source was built with.
 * Omitted, the resolver keeps a table of its own.
 */
export interface DefinitionResolverDeps {
  readonly definitionMetaReader: DefinitionMetaReader;
  readonly annotationValueReader?: AnnotationValueReader;
  readonly metaDefinitions: DefinitionGetter;
  readonly namespaceDefinitions: DefinitionGetter;
  readonly facts?: EntryFactsTable;
  readonly applicationCloser?: ApplicationCloser;
  readonly applicationChecker?: ApplicationChecker;
  readonly declaredApplicationCloser?: DeclaredApplicationCloser;
  readonly encodeSourceBody?: SourceBodyEncoder;
}

export interface DefinitionResolver {
  /**
   * Resolves a single declaration against this resolver's own type-name/structure namespaces to
   * the value its entry holds (§8.1: an entry is its value) -- the sole entry point; every other
   * function in this module is a private dispatch target reached from here. The entry's facts --
   * `position` when given, the annotations written after `=>`, the constructor its value's tag
   * names -- are recorded in the facts table rather than on the value, since none of them is a
   * field of any constructor.
   */
  resolve(declaration: Declaration, position?: SourcePosition): Top;

  /** `name`'s facts as resolution has recorded them so far. */
  factsOf(name: string): EntryFacts;

  /**
   * A declaration's own annotations — the ones written *after* `=>`, which §6 says annotate the
   * definition (not the ones before the name, which annotate the key; §6: "does not hoist
   * annotations from key to value"). Exposed for a caller (the eventual `SchemaResolver`) that
   * needs the identical annotation-resolution rule for a schema document's own header position.
   */
  annotationsFor(name: string, written: readonly WrittenAnnotation[]): Annotations;

  /**
   * The type a declaration's parameter list wrote after `parameter` (`<T: text>`, §5.10), as a
   * resolved type-ref. A written type names a type or an application of one; a container sugar
   * form is not lifted at this position, so it has no entry to name and is refused here in those
   * terms.
   */
  parameterType(parameter: string, written: AstTypeRef): TypeRef;
}

export function createDefinitionResolver(given: DefinitionResolverDeps): DefinitionResolver {
  const facts: EntryFactsTable = given.facts ?? new Map<string, EntryFacts>();
  const deps: DefinitionResolverDeps = { ...given, facts };
  return {
    resolve(declaration: Declaration, position?: SourcePosition): Top {
      const resolved = resolveTypeDef(
        deps,
        declaration.name,
        declaration.typeDef,
        declaration.mark,
      );
      const annotations = annotationsOf(deps, declaration.name, declaration.typeDefAnnotations);
      const known = facts.get(declaration.name) ?? {};
      const recordedPosition = position ?? known.position;
      const head = resolved.head ?? known.head;
      facts.set(declaration.name, {
        ...(recordedPosition === undefined ? {} : { position: recordedPosition }),
        ...(annotations.length > 0 ? { annotations } : {}),
        ...(head === undefined ? {} : { head }),
      });
      return resolved.value;
    },
    factsOf(name: string): EntryFacts {
      return facts.get(name) ?? {};
    },
    annotationsFor(name: string, written: readonly WrittenAnnotation[]): Annotations {
      return annotationsOf(deps, name, written);
    },
    parameterType(parameter: string, written: AstTypeRef): TypeRef {
      if (written.kind !== 'simpleRef' && written.kind !== 'genericRef') {
        throw new TsonSchemaValidationError(
          `parameter '${parameter}' is written with ${written.kind === 'arrayRef' ? 'an array' : written.kind === 'mapRef' ? 'a map' : written.kind === 'tupleRef' ? 'a tuple' : 'a choice'} ` +
            "type, and a parameter's written type names a declared type or an application of one " +
            '(§5.10); declare the form under a name and write that name',
        );
      }
      return resolveTypeRef(deps, written);
    },
  };
}

/**
 * One declaration resolved: the value its entry holds, and the constructor the value's tag names
 * where resolution knows it -- the one fact a value's shape cannot always carry ({@link
 * EntryFacts.head}).
 */
interface Resolved {
  readonly value: Top;
  readonly head?: string;
}

/** `name`'s facts as the shared table holds them -- an imported entry's included. */
function factsOf(deps: DefinitionResolverDeps, name: string): EntryFacts {
  return deps.facts?.get(name) ?? {};
}

/**
 * The constructor `name`'s value was built with: the one its facts record, and otherwise the one
 * its shape is the body of ({@link constructorOf}).
 */
function headOf(deps: DefinitionResolverDeps, name: string, value: Top): string {
  return factsOf(deps, name).head ?? constructorOf(value);
}

/**
 * §5.2's definition mark (`abstract`/`final`), lowered into `RecordBody.extension`. On a record
 * template the record's own `extension` is each application's (§5.10), so a mark written there
 * (`outcome => abstract <T> { code: T }`) travels to every instantiation, while the template
 * itself is ABSTRACT by construction whatever it states.
 *
 * Also carries §5.2's `final`-beside-a-selector refusal and, for a template specifically, the
 * refusal of `final` outright (a template's applications are subtypes by construction and can
 * never be FINAL, §5.10).
 *
 * @throws TsonSchemaValidationError per §5.2's two refusals above.
 */
function applyRecordExtensionMark(
  name: string,
  body: RecordBody,
  mark: 'abstract' | 'final' | undefined,
  parameters: readonly string[],
): RecordBody {
  if (parameters.length > 0 && mark === 'final') {
    throw new TsonSchemaValidationError(
      `'${name}' writes 'final' on a template -- a template's applications are subtypes by ` +
        "construction, so a template can never be FINAL; only 'abstract' asserts what a " +
        'record-bodied template already is (§5.10)',
    );
  }
  // §5.2: "`final` beside one [a selector] is refused, the members it selects being subtypes
  // that could then never exist" -- FINAL admits no subtype and a selector's whole point is that
  // the record has members, so the two are mutually exclusive whatever the author intended.
  if (mark === 'final' && body.discriminators !== undefined) {
    throw new TsonSchemaValidationError(
      `'${name}' writes 'final' beside a selector ('=?') -- a selector says this record's members ` +
        'pin it, and FINAL admits no subtype, so the members a selector implies could never exist ' +
        '(§5.2)',
    );
  }
  let extension: RecordExtensionType = body.discriminators !== undefined ? 'ABSTRACT' : 'OPEN';
  if (mark === 'abstract') extension = 'ABSTRACT';
  if (mark === 'final') extension = 'FINAL';
  return extension === body.extension ? body : { ...body, extension };
}

/**
 * The selectors a record template's members are dispatched by (§5.10): a field written `=?`, or,
 * in a *fresh* record template, a field pinned to a value parameter. `undefined` for a template
 * that composes onto a meta-level base kind (`supertypes.includes('top')`, a constructor template in
 * a meta-schema): no value is ever read against a position typed by a constructor the way one is
 * typed by a family base, so it derives none.
 *
 * `isFreshRecordTemplate` gates the second source: composition and refinement templates contribute
 * only `=?`-marked selectors (already in `record.discriminators`).
 */
function familyDiscriminators(
  name: string,
  record: RecordBody,
  parameters: readonly string[],
  supertypes: readonly string[],
  isFreshRecordTemplate: boolean,
): readonly string[] | undefined {
  if (parameters.length === 0 || supertypes.includes('top')) {
    return undefined;
  }
  const candidates = new Set(record.discriminators ?? []);
  const fields = namedFields(record);
  if (isFreshRecordTemplate) {
    for (const field of fields) {
      if (
        field.role === 'FIXED' &&
        !field.optional &&
        field.value?.form === 'UNQUOTED' &&
        parameters.includes(field.value.text)
      ) {
        candidates.add(field.name);
      }
    }
  }
  const discriminators: string[] = [];
  for (const field of fields) {
    if (!candidates.has(field.name)) continue;
    if (typeRefMentionsParameter(field.type, parameters)) {
      throw new TsonSchemaValidationError(
        `'${name}': the selector '${field.name}' is typed '${field.type.name}', which mentions a ` +
          "type parameter -- a selector's declared type MUST contain no type parameter, since a " +
          'decoder parses the selectors before it knows the member and their pins are exactly what ' +
          'the parameters supply (§5.10)',
      );
    }
    discriminators.push(field.name);
  }
  return discriminators;
}

/** Whether `ref` mentions any of `parameters`, at any depth -- {@link familyDiscriminators}' own selector-erasure condition. */
function typeRefMentionsParameter(ref: TypeRef, parameters: readonly string[]): boolean {
  if (parameters.includes(ref.name)) return true;
  return ref.arguments.some(
    (arg) => arg.kind === 'ref' && typeRefMentionsParameter(arg.ref, parameters),
  );
}

/** A parameter whose type is not yet derived: a type parameter until `parameterTypes.ts` says otherwise (§5.10). */
function undecidedParameter(name: string): TemplateParam {
  return { name, type: { name: TYPE_KIND, arguments: [], annotations: [] } };
}

/**
 * A record draft as the value its entry holds: the record with its chain, and -- for a record
 * template (§5.10) -- its `parameters` and the selectors its family is dispatched by. A record
 * template is not held: it is the record it is, its fields naming its parameters as written, and
 * its chain keeps the parents as written, one of which may be an application. A closed record's
 * chain keeps none.
 */
function recordValue(
  name: string,
  draft: Draft,
  record: RecordBody,
  isFreshRecordTemplate: boolean,
): Resolved {
  const parameters = draft.parameters;
  let body: RecordBody = record;
  if (parameters.length > 0) {
    const discriminators = familyDiscriminators(
      name,
      record,
      parameters,
      draft.supertypes,
      isFreshRecordTemplate,
    );
    const { discriminators: _written, ...rest } = record;
    void _written;
    body = {
      ...rest,
      ...(discriminators === undefined
        ? record.discriminators === undefined
          ? {}
          : { discriminators: record.discriminators }
        : discriminators.length > 0
          ? { discriminators }
          : {}),
      parameters: parameters.map(undecidedParameter),
    };
  }
  const chain = typeChain(draft.supertypes, parameters.length > 0 ? draft.parents : []);
  return {
    value: withChain(body, chain),
    ...(draft.head === undefined ? {} : { head: draft.head }),
  };
}

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Indexed access with a runtime backstop instead of a non-null assertion (`eslint.config.js`
 * forbids `!`) -- every call site below is safe by construction (a loop bound to the array's own
 * length, an index already checked in range), so the throw is a defensive invariant check, never
 * a real possibility.
 */
function at<T>(items: readonly T[], index: number, context: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new TsonInternalError(
      `${context}: index ${String(index)} out of bounds for length ${String(items.length)}`,
    );
  }
  return value;
}

/** The {@link at} twin for a `Map` lookup already known to hit, by the same construction argument. */
function requiredGet<K, V>(map: ReadonlyMap<K, V>, key: K, context: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new TsonInternalError(`${context}: missing expected key '${String(key)}'`);
  }
  return value;
}

/**
 * A reference whose target is a bare or applied name (§8.3). **`parameters` empty** produces the
 * closed alias directly (`!reference { target }`), REFERENCE-kind by derivation. **Non-empty** —
 * a partial application, `uuid_pair => <B> pair<uuid, B>` (§5.10) — holds the same `!reference {
 * target }` as *text* instead: "every open entry [is] written as a constructor application,
 * `<params> !C core-value`, this one included" (meta-kernel's own `reference` doc).
 */
function referenceDefinition(target: TypeRef, parameters: readonly string[]): Resolved {
  if (parameters.length === 0) {
    const value: Reference = { kind: 'reference', target };
    return { value };
  }
  const application = {
    annotations: [],
    typeRef: REFERENCE_HEAD,
    coreValue: {
      kind: 'record' as const,
      fields: [{ name: 'target', value: scoped(refValue(target)) }],
    },
  };
  return { value: createHeldBody(application, parameters) };
}

function isRecordBody(body: Top | undefined): body is RecordBody {
  return body !== undefined && (body as { readonly kind?: unknown }).kind === 'record';
}

/**
 * §8.1: "`template` is resolver vocabulary: nothing is ever typed by it, and a source declaration
 * applying it directly is a resolver error" -- checked at the end of the head's own reference chain
 * (`resolveConstructorTarget` already walked it), since `template` composes with `top` directly and
 * would otherwise pass every other structural check `resolveInstance`/`resolveInstanceTemplate`
 * make of an ordinary constructor. The open spelling (`<U> !template { ... }`) is refused on the
 * same terms: a parameter list on the declaration does not make a hand-written held body a derived
 * one (§5.10's own `<...>` is the authored spelling of an open entry, not a licence to spell one by
 * hand).
 */
function refuseTemplateAppliedDirectly(name: string, terminalHead: string): void {
  if (terminalHead === 'template') {
    throw new TsonSchemaValidationError(
      `'${name}': '!template' is resolver vocabulary -- an open entry's own body, derived from a ` +
        "declaration's parameter list -- and a source declaration applying it directly is a " +
        "resolver error (§8.1); '<...>' is the authored spelling of an open entry (§5.10)",
    );
  }
}

/**
 * A composition's or refinement's record before it becomes its entry's value: the type
 * parameters the declaration carries, the closed chain its parents reach, the parents as written
 * (kept only where the declaration is a template, §5.10), and the record itself. A private,
 * module-internal shape: every return path builds the value through {@link recordValue}.
 */
interface Draft {
  readonly parameters: readonly string[];
  readonly supertypes: readonly string[];
  readonly parents: readonly TypeRef[];
  readonly body: RecordBody;
  readonly head?: string;
}

function typeArgumentEquals(a: TypeArgument, b: TypeArgument): boolean {
  if (a.kind === 'ref' && b.kind === 'ref') return typeRefEquals(a.ref, b.ref);
  if (a.kind === 'value' && b.kind === 'value') {
    return a.value.text === b.value.text && a.value.form === b.value.form;
  }
  return false;
}

/** `TypeRef` equality per its own contract note: name and arguments, `annotations` excluded (identity is where a reference points, not where it came from). */
function typeRefEquals(a: TypeRef, b: TypeRef): boolean {
  if (a.name !== b.name || a.arguments.length !== b.arguments.length) return false;
  return a.arguments.every((arg, i) =>
    typeArgumentEquals(arg, at(b.arguments, i, 'typeRefEquals')),
  );
}

// ── Top-level dispatch (§5, §8) ──────────────────────────────────────────────────────────────

function resolveTypeDef(
  deps: DefinitionResolverDeps,
  name: string,
  typeDef: TypeDef,
  mark: 'abstract' | 'final' | undefined,
): Resolved {
  // §5.2's mark is refused outright on every shape but a record and a *record-bodied* template --
  // the latter reached below either as `structuralTypeDef`'s own `recordDef` (a non-parameterised
  // fresh record, or a composition/refinement template, which the desugarer cannot flatten to an
  // `instance` in advance) or, for a record TEMPLATE specifically, as `instance` with
  // `typeParams.length > 0` (`desugar.ts`'s own `structuralTypeDefPass` rewrites a parameterised
  // `recordDef` to `!record { fields: { ... } }` ahead of resolution, §5.2's canonical form). Both
  // branches below carry their own, narrower validation; this refuses every other shape.
  const isRecordShaped =
    typeDef.kind === 'structuralTypeDef' ||
    (typeDef.kind === 'instance' && typeDef.typeParams.length > 0);
  if (!isRecordShaped && mark !== undefined) {
    throw new TsonSchemaValidationError(
      `'${name}' writes the definition mark '${mark}', but its body is not a record -- only a ` +
        'record states how it may be realised (§5.2)',
    );
  }
  if (typeDef.kind === 'structuralTypeDef') {
    // No marker to read here (§4.2): a fresh record, composition or refinement is a constructor
    // only by actually composing or refining IS-A `top` below -- `resolveComposition`/
    // `resolveRefinement` build the chain from what the declaration's own body names, and
    // {@link isConstructor} reads it off the result. A bare record body never does, whatever an
    // author might have intended.
    const parameters = typeDef.typeParams;
    const body = typeDef.body;
    if (body.kind === 'recordDef') {
      const recordBody = applyRecordExtensionMark(
        name,
        resolveRecordBody(deps, body.entries, parameters),
        mark,
        parameters,
      );
      return recordValue(
        name,
        { parameters, supertypes: [], parents: [], body: recordBody },
        recordBody,
        true,
      );
    }
    if (body.kind === 'constructionDef') {
      const draft = resolveComposition(deps, name, body, parameters);
      const recordBody = applyRecordExtensionMark(name, draft.body, mark, parameters);
      return recordValue(name, { ...draft, body: recordBody }, recordBody, false);
    }
    const draft = resolveRefinement(deps, name, body, parameters);
    const recordBody = applyRecordExtensionMark(name, draft.body, mark, parameters);
    return recordValue(name, { ...draft, body: recordBody }, recordBody, false);
  }
  if (typeDef.kind === 'referenceTypeDef') {
    const parameters = typeDef.typeParams;
    if (typeDef.ref.kind === 'simpleRef') {
      return referenceDefinition(
        { name: typeDef.ref.name, arguments: [], annotations: [] },
        parameters,
      );
    }
    if (typeDef.ref.kind === 'genericRef') {
      return resolveTemplateApplication(deps, name, typeDef.ref, parameters);
    }
    // Every declaration-level container form is rewritten by the desugarer before resolution
    // (§5.3). One reaching here means either the desugar phase was skipped, or a position inside
    // it is itself an application with no entry to name until materialisation runs.
    throw new TsonNotImplementedError(
      'a container sugar form must be lifted to an entry before resolution (§5.3); this one was ' +
        'not, which means either the desugar phase was skipped or a position inside it is an ' +
        'application, which has no entry to name until it is materialised',
    );
  }
  if (typeDef.kind === 'instance') {
    return typeDef.typeParams.length === 0
      ? resolveInstance(deps, name, typeDef)
      : resolveInstanceTemplate(deps, name, typeDef, mark);
  }
  return resolveAtomRefinement(deps, name, typeDef);
}

// ── Constructor application (§5.5, §5.6) ────────────────────────────────────────────────────

function requireTypeRef(value: DataValue, context: string): string {
  if (value.typeRef === undefined) {
    throw new TsonInternalError(
      `${context}: normalized value has no type-ref naming its own constructor`,
    );
  }
  return value.typeRef;
}

/** `!C value` (constructor application, no `^`) — produces a fresh instance filled with `value`. */
function resolveInstance(deps: DefinitionResolverDeps, name: string, instance: Instance): Resolved {
  const target = requireTypeRef(instance.value, `'${name}'`);
  const head = resolveConstructorTarget(deps, name, target);
  refuseTemplateAppliedDirectly(name, head.name);
  if (!isConstructor(head.definition, head.name)) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' does not resolve to a constructor (§3.3.1) -- did you mean atom refinement ` +
        `('!${target} ^ { ... }')?`,
    );
  }
  if (!isRecordBody(head.definition)) {
    throw new TsonInternalError(
      `'${name}': constructor '${target}' has a non-record body; a constructor is record-shaped (§7.2) and ` +
        'cannot be declared otherwise',
    );
  }
  refuseAbstractConstructor(deps, name, target, head.definition);
  refuseWrittenChain(name, instance.value);
  const value = bindAtomInstance(deps, name, readAsConstructor(instance.value, head.name));
  return { value, head: target };
}

/**
 * A type's `chain` is the resolver's (§4.1): computed from composition and refinement, inverted by
 * the linker, and written by no declaration -- as `choice.disjoint` is not. A construction or an
 * atom refinement binding it states a claim no declaration makes; `n => base & { ... }` and
 * `!int32 ^ { ... }` are the declarations that mean one.
 */
function refuseWrittenChain(name: string, value: DataValue): void {
  if (value.coreValue.kind !== 'record') return;
  if (!value.coreValue.fields.some((field) => field.name === CHAIN_FIELD)) return;
  throw new TsonSchemaValidationError(
    `'${name}' writes 'chain', which is the resolver's: a type's IS-A chain is computed from its ` +
      'composition and refinement and inverted by the linker, and no declaration writes it (§4.1, ' +
      "§5.7, §5.8). Compose or refine to state an IS-A edge ('n => base & { ... }', " +
      "'!int32 ^ { ... }')",
  );
}

/** The one field `type` declares, every type body's chain (§4.1). */
const CHAIN_FIELD = 'chain';

/**
 * §5.2: an ABSTRACT record has no instances of its own, and the kernel's `top`, `type`, `atom`,
 * `product`, `sum` and `namespace` are abstract (§4.1) -- so `!atom {}` is refused as any
 * abstract record's direct application is, naming the constructors below it that would answer:
 * only the instantiable ones, an abstract subtype being no answer.
 */
function refuseAbstractConstructor(
  deps: DefinitionResolverDeps,
  name: string,
  target: string,
  constructor: RecordBody,
): void {
  if (constructor.extension !== 'ABSTRACT') return;
  const instantiable = subtypesOf(constructor).filter((subtype) => {
    const value = deps.metaDefinitions(subtype);
    return value !== undefined && !(isRecordBody(value) && value.extension === 'ABSTRACT');
  });
  throw new TsonSchemaValidationError(
    `'${name}': '!${target}' is abstract and has no instances of its own (§4.1, §5.2) -- ` +
      (instantiable.length === 0
        ? 'nothing below it is instantiable either'
        : `apply one of the constructors below it instead: ${instantiable.join(', ')}`),
  );
}

const REFERENCE_HEAD = 'reference';

/**
 * `<T, N> !C { ... }` — the open counterpart of {@link resolveInstance}. A record template
 * (`C` is `record`) is the record it is (§5.10): its payload is read through the `record`
 * constructor with its parameters standing in field types and values as written, and it becomes
 * a family base. Every other payload is held rather than read through the constructor's reader —
 * only the two structural questions that don't depend on the parameters are checked here
 * ({@link checkTemplateBindings}); the rest waits for materialisation.
 */
function resolveInstanceTemplate(
  deps: DefinitionResolverDeps,
  name: string,
  template: Instance,
  mark: 'abstract' | 'final' | undefined,
): Resolved {
  const target = requireTypeRef(template.value, `'${name}'`);
  const head = resolveConstructorTarget(deps, name, target);
  refuseTemplateAppliedDirectly(name, head.name);
  // `reference => top & { target: type_ref }` composes with `top` directly (§4.1), so it is
  // `isConstructor`-eligible on the same terms as every other constructor and needs no carve-out
  // here: §5.5 says the kernel's `reference` "is applicable like any other".
  if (!isConstructor(head.definition, head.name)) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' does not resolve to a constructor (§3.3.1), so there is nothing for ` +
        `'<...> !${target} { ... }' to build`,
    );
  }
  if (!isRecordBody(head.definition)) {
    throw new TsonInternalError(
      `'${name}': constructor '${target}' has a non-record body; a constructor is record-shaped (§7.2) and ` +
        'cannot be declared otherwise',
    );
  }
  refuseAbstractConstructor(deps, name, target, head.definition);
  refuseWrittenChain(name, template.value);
  // §5.10: only a record template (`head.name === 'record'`, applying the `record` constructor
  // itself, not merely something record-*shaped* like `record_field`) may be a family base, and
  // only `abstract` asserts it there (§5.2's other mark, `final`, is refused on any template: its
  // applications are subtypes by construction).
  const isRecordBodied = head.name === RECORD_CONSTRUCTOR;
  if (mark !== undefined && (mark === 'final' || !isRecordBodied)) {
    throw new TsonSchemaValidationError(
      `'${name}' writes the definition mark '${mark}' on a template -- only a record-bodied ` +
        "template may be a family base, and only 'abstract' asserts it there, since its " +
        'applications are subtypes by construction and never FINAL (§5.10)',
    );
  }
  if (template.value.coreValue.kind === 'record') {
    checkTemplateBindings(name, target, head.definition, template.value.coreValue);
  }
  if (!isRecordBodied) {
    return { value: createHeldBody(template.value, template.typeParams) };
  }
  const hasSelectors = writtenSelectors(template.value);
  const markedValue = markHeldRecordValue(name, template.value, mark, hasSelectors);
  const read = bindAtomInstance(deps, name, readAsConstructor(markedValue, head.name));
  if (!isRecordBody(read)) {
    throw new TsonInternalError(`'${name}': a '!record' payload read as something else`);
  }
  return recordValue(
    name,
    { parameters: template.typeParams, supertypes: [], parents: [], body: read, head: target },
    read,
    true,
  );
}

/** The kernel's own constructor name for a record body (§4.2, §5.2) -- the terminal a record template's head resolves to. */
const RECORD_CONSTRUCTOR = 'record';

/** Whether a written `!record { ... }` payload states `discriminators` -- §5.2's `=?`, already lowered by the desugarer. */
function writtenSelectors(value: DataValue): boolean {
  if (value.coreValue.kind !== 'record') return false;
  const discriminators = wireField(value.coreValue, DISCRIMINATORS);
  return discriminators?.kind === 'array' && discriminators.elements.length > 0;
}

/**
 * `value` with §5.2's mark baked in as the wire `extension` field -- the counterpart of {@link
 * applyRecordExtensionMark} over an already-desugared `!record { fields: { ... } }` wire value,
 * §5.2's canonical form a record *template* reaches through `desugar.ts`'s own
 * `structuralTypeDefPass` ahead of this module ever seeing it.
 *
 * @throws TsonSchemaValidationError per §5.2's `final`-beside-a-selector refusal.
 */
function markHeldRecordValue(
  name: string,
  value: DataValue,
  mark: 'abstract' | 'final' | undefined,
  hasDiscriminators: boolean,
): DataValue {
  if (mark === 'final' && hasDiscriminators) {
    throw new TsonSchemaValidationError(
      `'${name}' writes 'final' beside a selector ('=?') -- a selector says this record's members ` +
        'pin it, and FINAL admits no subtype, so the members a selector implies could never exist ' +
        '(§5.2)',
    );
  }
  let extension: RecordExtensionType = hasDiscriminators ? 'ABSTRACT' : 'OPEN';
  if (mark === 'abstract') extension = 'ABSTRACT';
  if (mark === 'final') extension = 'FINAL';
  if (extension === 'OPEN' || value.coreValue.kind !== 'record') {
    return value;
  }
  return {
    ...value,
    coreValue: {
      kind: 'record',
      fields: [
        ...value.coreValue.fields.filter((field) => field.name !== EXTENSION),
        nameField(EXTENSION, extension),
      ],
    },
  };
}

/** §5.10's two declaration-time questions about a held binding record. */
function checkTemplateBindings(
  name: string,
  target: string,
  vocabulary: RecordBody,
  bindings: RecordValue,
): void {
  const bound = new Set<string>();
  for (const binding of bindings.fields) {
    if (!vocabulary.fields.entries.has(binding.name)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${target}' has no field '${binding.name}' to bind (§7.2) -- its fields are ` +
          `[${[...vocabulary.fields.entries.keys()].join(', ')}]`,
      );
    }
    bound.add(binding.name);
  }
  for (const field of namedFields(vocabulary)) {
    const memberOfGroup = isGroupMember(vocabulary.groups, field.name);
    if (fieldOmission(field, memberOfGroup) === 'MISSING' && !bound.has(field.name)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${target}' requires a '${field.name}', and nothing binds it (§7.2), so no application of ` +
          'this template could build one',
      );
    }
  }
}

// ── Atom refinement (§5.5, §5.7) ─────────────────────────────────────────────────────────────

/**
 * `!I ^ { values }` — refines an atom-family instance by tightening its constructor's constraint
 * fields. `I` resolves against the type-name namespace only (§3.3.1) and MUST be an atom-family
 * **instance** — an entry whose body *is* an atom application (`integer` carries
 * `!integer_type {}`), not the constructor whose body is the vocabulary record *describing* one
 * (`integer_type` carries `!record { ... }`). Merges with `I`'s own already-bound value rather
 * than replacing it ({@link mergeWithSource}), which is what makes a *chained* refinement carry
 * its ancestor's constraints forward.
 *
 * **The test is on the body, and on nothing else (§3.3.1, §5.5).** Neither IS-A nor kind
 * separates a constructor from its own instances, so {@link isAtom} answers the one question that
 * does: is the source's value itself a member of the {@link Atom} union, which is true of
 * `integer` (`kind === 'integer_type'`) and false of `integer_type` (`kind === 'record'`, the
 * vocabulary record `integer_type` composes for its own instances to fill).
 *
 * The refinement is written under the constructor its source was built with (the source's own
 * {@link EntryFacts.head}), and IS-A its source and everything the source IS-A (§5.7, §5.8).
 */
function resolveAtomRefinement(
  deps: DefinitionResolverDeps,
  name: string,
  refinement: AtomRefinement,
): Resolved {
  const sourceName = refinement.target;
  const declared = deps.namespaceDefinitions(sourceName);
  if (declared === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${sourceName}' does not resolve against the type-name namespace (§3.3.1)`,
    );
  }
  // §5.5 asks whether the source resolves to an atom-family INSTANCE, and §5.7's identity table
  // makes `user_id => uuid` "the same type, under another name" -- so the question is asked of the
  // chain terminal (§8.3), not of the alias's own `!reference` body.
  const terminalName = terminal(sourceName, deps.namespaceDefinitions);
  const source = vocabularyOf(deps, sourceName) ?? declared;
  if (!isAtom(source)) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${sourceName}' is not an atom-family instance (§5.5) -- its body is not an atom ` +
        `application, so there is nothing here to tighten. A constructor's own body is its vocabulary ` +
        `record, not an atom application ('!${sourceName} ^ { ... }' would refine an instance like ` +
        `'integer', not the vocabulary record 'integer_type' describes) -- did you mean constructor ` +
        `application ('!${sourceName} { ... }')?`,
    );
  }
  refuseWrittenChain(name, refinement.bindings);
  const constructorName = headOf(deps, terminalName, source);
  const merged = mergeWithSource(
    deps,
    name,
    withoutChain(source),
    refinement.bindings,
    constructorName,
  );
  const body = bindAtomInstance(deps, name, merged);
  checkNarrows(name, sourceName, source, body);
  return {
    value: withChain(body, typeChain(ofParent(deps, sourceName))),
    head: constructorName,
  };
}

/**
 * What a closed parent contributes to an IS-A chain (§5.8): itself, the end of its reference
 * chain (§8.3: the terminal is the same type under another name, so IS-A reaches it), and that
 * entry's own chain -- the one rule every closed declaration's chain is built by.
 */
function ofParent(deps: DefinitionResolverDeps, parent: string): string[] {
  const names = [parent];
  const end = terminal(parent, deps.namespaceDefinitions);
  if (end !== parent) names.push(end);
  names.push(...supertypesOf(deps.namespaceDefinitions(end)));
  return names;
}

/**
 * §5.7's tightening rule, enforced: a refinement narrows its source's constraints, so a body that
 * *loosens* one is a resolver error rather than a silently accepted override. `refinedBody` is
 * the fully merged result (see {@link mergeWithSource}), not the refinement body alone, so a
 * facet the body never mentioned compares equal to the source's own and tightens vacuously.
 */
function checkNarrows(name: string, sourceName: string, sourceBody: Top, refinedBody: Top): void {
  if (!isAtom(sourceBody) || !isAtom(refinedBody)) return;
  const violations = checkAtomNarrows(sourceBody, refinedBody);
  if (violations.length > 0) {
    // A facet fixed at construction is not widened by a move; it is not movable at all, and the
    // message says which of the two the author did.
    const fixed = violations.every((violation) => violation.includes('is fixed where'));
    throw new TsonSchemaValidationError(
      `'${name}': refinement of '!${sourceName}' ` +
        (fixed
          ? `moves a facet that is fixed at construction (§5.5, §5.7): ${violations.join('; ')}`
          : `widens rather than tightens it (§5.7): ${violations.join('; ')}`),
    );
  }
}

/**
 * §5.7's "Body materialisation" rule, applied to atom refinement (§5.6's chained-refinement
 * merge): `newBindings` merged *over* `sourceBody`'s own already-bound fields, not replacing
 * them. `sourceBody` is converted back to wire form via {@link DefinitionResolverDeps.encodeSourceBody}
 * (this port's replacement for the Java original's `TsonObjectWriter` round trip — see this
 * module's own doc) and merged at the `RecordValue` field level: `newBindings`'s own fields win;
 * anything only `sourceBody` had survives untouched.
 *
 * **Merging before binding, not after, is required.** Binding `newBindings` on its own and
 * merging the two constraint objects afterwards would fail for any constructor with a REQUIRED
 * field carrying no schema default, since the refinement body has no reason to restate a facet
 * its source already fixed. Merging first means the record that reaches the reader is always
 * complete.
 */
function mergeWithSource(
  deps: DefinitionResolverDeps,
  name: string,
  sourceBody: Top,
  newBindings: DataValue,
  constructorName: string,
): DataValue {
  if (deps.encodeSourceBody === undefined) {
    throw new TsonNotImplementedError(
      `'${name}': merging an atom refinement's source needs a SourceBodyEncoder, and this resolver was built ` +
        'without one',
    );
  }
  const merged = new Map<
    string,
    { readonly name: string; readonly value: RecordValue['fields'][number]['value'] }
  >();
  const sourceEncoded = deps.encodeSourceBody(sourceBody);
  if (sourceEncoded.kind === 'record') {
    for (const field of sourceEncoded.fields) merged.set(field.name, field);
  }
  if (newBindings.coreValue.kind === 'record') {
    for (const field of newBindings.coreValue.fields) {
      merged.set(field.name, inheritOrder(field, merged.get(field.name)));
    }
  } else if (newBindings.coreValue.kind !== 'empty-brace') {
    // The author's error, not a gap: §12.1's `atom-refinement` takes a `record-def`, so this
    // verdict does not change as this library improves.
    throw new TsonSchemaValidationError(
      `'${name}': expected a braced record of constraint bindings (§5.5), found ${newBindings.coreValue.kind}`,
    );
  }
  const mergedRecord: RecordValue = { kind: 'record', fields: [...merged.values()] };
  return {
    annotations: newBindings.annotations,
    typeRef: constructorName,
    coreValue: mergedRecord,
  };
}

/** The member-set facets whose surviving members keep their inherited order (§7.5). */
const ORDERED_BY_INHERITANCE: ReadonlySet<string> = new Set(['members', 'schemes', 'within']);

/**
 * A refinement that shrinks a member set keeps the surviving members in their inherited order
 * (§7.5): `[https http ftp]` refined to `[FTP https]` is `[https ftp]`, whatever order the
 * refinement wrote them in. Members the source does not hold keep their written order after the
 * inherited ones; they are refused by the narrowing check, not reordered away. `schemes` compare
 * with ASCII case folded (§5.5), every other set by its text.
 */
function inheritOrder<F extends { readonly name: string; readonly value: ScopedValue }>(
  written: F,
  inherited: F | undefined,
): F {
  if (inherited === undefined || !ORDERED_BY_INHERITANCE.has(written.name)) return written;
  const was = inherited.value.value.coreValue;
  const now = written.value.value.coreValue;
  if (was.kind !== 'array' || now.kind !== 'array') return written;
  const key = (element: ScopedValue): string | undefined => {
    const core = element.value.coreValue;
    if (core.kind !== 'token') return undefined;
    return written.name === 'schemes' ? asciiLowercase(core.text) : core.text;
  };
  const rank = (element: ScopedValue): number => {
    const wanted = key(element);
    const at = was.elements.findIndex((candidate) => key(candidate) === wanted);
    return at < 0 ? was.elements.length : at;
  };
  const ordered = now.elements
    .map((element, index) => ({ element, index, rank: rank(element) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.element);
  return {
    ...written,
    value: {
      ...written.value,
      value: { ...written.value.value, coreValue: { ...now, elements: ordered } },
    },
  };
}

/** A constructor-application target (`!C value`), resolved through §8.3's chain: the name a compiled reader is keyed by, and the entry it names -- {@link resolveConstructorTarget}'s own result. */
interface ConstructorHead {
  readonly name: string;
  readonly definition: Top;
}

/**
 * A constructor-application target (`!C value`) resolves against the structure namespace only —
 * never the type-name namespace (§3.3.1) — **after following its reference chain** (§8.3): `C`
 * may itself be an alias (`alias_array => array`), and every question this resolver asks of the
 * head from here on — is it a template, is it applicable, whose vocabulary reads the payload — is
 * a question about the entry at the end of the chain, not about the hop. A constructor is always
 * meta-schema vocabulary, declared in the *governing* meta-schema, one hop via `!!meta`.
 *
 * The author's own spelling survives where it is visible: {@link resolveInstance}/
 * {@link resolveInstanceTemplate} record `target` (not {@link ConstructorHead.name}) in the
 * result's own `source`, so the chain stays walkable from resolved output.
 */
function resolveConstructorTarget(
  deps: DefinitionResolverDeps,
  name: string,
  target: string,
): ConstructorHead {
  if (deps.metaDefinitions(target) === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' does not resolve against the structure namespace (§3.3.1)`,
    );
  }
  const terminalName = terminal(target, deps.metaDefinitions);
  const atEnd = deps.metaDefinitions(terminalName);
  if (atEnd === undefined) {
    // The walk stopped at a name the structure namespace does not declare -- a broken hop, which
    // is the alias's own problem and not this declaration's, but this is where it becomes visible.
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' is an alias whose chain ends at '${terminalName}', which the ` +
        'structure namespace does not declare (§8.3)',
    );
  }
  return { name: terminalName, definition: atEnd };
}

/**
 * `value` re-typed to the name its payload is read against — the terminal of the head's own
 * chain (§8.3), where the author may have written an alias. A no-op for the ordinary case, where
 * they are the same name; the meta-schema's reader table is keyed by the constructor's own name,
 * so an alias reaches one only by asking under it.
 */
function readAsConstructor(value: DataValue, constructorName: string): DataValue {
  return value.typeRef === constructorName ? value : { ...value, typeRef: constructorName };
}

/**
 * Shared by {@link resolveInstance}/{@link resolveAtomRefinement}/{@link openOperand} — reads a
 * type-ref-carrying value against its own constructor's compiled reader, then checks its own
 * internal coherence (§7.4: family coherence is a resolver question, not a data-validation one).
 */
function bindAtomInstance(deps: DefinitionResolverDeps, name: string, value: DataValue): Top {
  const constructorName = requireTypeRef(value, `'${name}'`);
  let body: Top;
  try {
    body = deps.definitionMetaReader(constructorName, value);
  } catch (e) {
    if (e instanceof TsonReadError) {
      throw bodyIsNotValidData(name, constructorName, e);
    }
    if (e instanceof TsonMissingBindingError) {
      throw new TsonMissingBindingError(`'${name}': ${e.message}`, { cause: e });
    }
    if (e instanceof TsonBindMismatchError) {
      throw new TsonBindMismatchError(`'${name}': ${e.message}`, { cause: e });
    }
    throw new TsonNotImplementedError(
      `'${name}': failed to bind '${constructorName}' via the compiled meta-schema reader: ${errorMessage(e)}`,
      { cause: e },
    );
  }
  checkCoherent(name, constructorName, body);
  return body;
}

/** §7.4's "Coherence of a body's facets": family coherence between a constructor's own bindings is a resolver question, checked here rather than left to the atom parsers (which would surface it as a library-gap "not implemented", exactly the wrong classification for the author's own mistake). */
function checkCoherent(name: string, constructorName: string, body: Top): void {
  const violations = isAtom(body)
    ? checkAtomCoherence(body)
    : isScopedBody(body)
      ? scopedCoherence(body)
      : [];
  if (violations.length > 0) {
    throw new TsonSchemaValidationError(
      `'${name}': the body's own '${constructorName}' constraints contradict each other: ${violations.join('; ')}`,
    );
  }
}

function isScopedBody(body: Top): body is Scoped {
  return 'kind' in body && body.kind === 'scoped';
}

/**
 * `scoped`'s own coherence rule (§7.8), stated once in `meta.tn`'s own `@doc`: "One coherence
 * rule, of the family a resolver already runs over `min_items`/`max_items`: `schemas` requires
 * EXTERN in `scope`."
 *
 * `schemas` narrows which *foreign* schemas a value may be drawn from, so a body naming them
 * without admitting EXTERN narrows a namespace it never opens -- the same shape as a bound pair
 * admitting nothing, and reachable the same way, by editing one of the two and not the other.
 *
 * The other state §7.8 could refuse is unspellable rather than checked: `min_items: 1` on both
 * collections means an empty `scope` and an empty `schemas` have no spelling to begin with.
 */
function scopedCoherence(body: Scoped): string[] {
  if (body.schemas === undefined || body.schemas.size === 0) return [];
  return body.scope.includes('EXTERN')
    ? []
    : [
        "'schemas' names the foreign schemas a value may come from, but 'scope' does not admit " +
          "EXTERN, so no value here can come from one (§7.8) -- add EXTERN to 'scope', or drop " +
          "'schemas'",
      ];
}

/** A body the constructor's own vocabulary rejects is the author's error (§7.2), not a coverage gap. */
function bodyIsNotValidData(
  name: string,
  constructorName: string,
  cause: TsonReadError,
): TsonSchemaValidationError {
  return new TsonSchemaValidationError(
    `'${name}': the body is not valid data for '${constructorName}', the constructor's own constraint ` +
      `vocabulary -- ${cause.message}`,
    { cause },
  );
}

// ── Top-level constructor application / template alias (§5.6, §5.10) ───────────────────────

/**
 * A declaration whose body is an application the desugarer did not rewrite — in practice a
 * *template* application (every constructor application is turned into a `!C value` instance
 * before resolution). Resolves to a `REFERENCE`-kind entry naming the application as written;
 * closing it is a whole-schema materialiser's own, later pass.
 */
function resolveTemplateApplication(
  deps: DefinitionResolverDeps,
  name: string,
  generic: GenericRef,
  parameters: readonly string[],
): Resolved {
  const args: TypeArgument[] = [];
  for (const arg of generic.args) {
    try {
      args.push(typeArgument(deps, arg));
    } catch (e) {
      if (e instanceof TsonNotImplementedError) {
        throw new TsonNotImplementedError(`'${name}': ${e.message}`, { cause: e });
      }
      throw e;
    }
  }
  const application: TypeRef = { name: generic.name, arguments: args, annotations: [] };
  // §5.10, §8.2: a declaration whose own body is a *fully-bound* application (this declaration
  // itself takes no parameters) IS that application's entry -- no minted twin, no `!reference`
  // hop. `declaredApplicationCloser` returns `undefined` for every case it does not own (the head
  // is not a template, the arity disagrees, or the template is reference-headed and composes away
  // instead of minting anything), and the ordinary, lazy alias path below still covers those.
  if (parameters.length === 0 && deps.declaredApplicationCloser !== undefined) {
    const closed = deps.declaredApplicationCloser(name, application);
    if (closed !== undefined) {
      return { value: closed };
    }
  }
  return referenceDefinition(application, parameters);
}

/** One argument of an application as the `type_argument` it denotes — a literal keeps its own token form, a reference resolves through {@link resolveTypeRef} (so an argument may itself be an application). */
function typeArgument(deps: DefinitionResolverDeps, arg: TypeArg): TypeArgument {
  if (arg.kind === 'value') {
    return {
      kind: 'value',
      value: { text: arg.value.text, form: metaFormOfLexer(arg.value.form) },
    };
  }
  return { kind: 'ref', ref: resolveTypeRef(deps, arg.ref) };
}

/**
 * A field/group-member/argument's type-ref: a bare simple reference, or a generic application
 * (each argument resolved the same way a refinement source's own arguments are). The inline
 * array-sugar branch is structurally unreachable through the ordinary pipeline — the desugarer
 * materialises an entry for every application first — and is refused here with a diagnostic
 * naming why, rather than silently mis-resolving.
 */
function resolveTypeRef(deps: DefinitionResolverDeps, ref: AstTypeRef): TypeRef {
  switch (ref.kind) {
    case 'simpleRef':
      return { name: ref.name, arguments: [], annotations: [] };
    case 'genericRef':
      return {
        name: ref.name,
        arguments: ref.args.map((a) => typeArgument(deps, a)),
        annotations: [],
      };
    case 'arrayRef':
    case 'mapRef':
    case 'tupleRef':
    case 'choiceRef':
      throw new TsonNotImplementedError(
        'a container sugar form must be lifted to an entry before resolution (§5.3); this one was not, ' +
          'which means either the desugar phase was skipped or a position inside it is an application, which ' +
          'has no entry to name until it is materialised',
      );
  }
}

// ── Composition (§5.8) and subtraction (§5.9) ───────────────────────────────────────────────

/**
 * `A & B & { ... }`: each supertype's fields and groups are copied into the result, left to
 * right; the trailing body's own entries then resolve against `inheritedFieldIndex` — a body
 * field naming an inherited field tightens it in place (§5.7), a field naming nothing inherited
 * is genuinely new and is appended. `supertypes` (this declaration's own transitive chain)
 * accumulates by induction: `direct + parent.supertypes()` for every direct supertype,
 * deduplicated, since each parent's own `supertypes()` is already its full transitive chain.
 */
function resolveComposition(
  deps: DefinitionResolverDeps,
  name: string,
  construction: ConstructionDef,
  parameters: readonly string[],
): Draft {
  const directSupertypes: TypeRef[] = [];
  const transitiveSupertypes: string[] = [];
  const seenTransitive = new Set<string>();
  const fields: NamedField[] = [];
  const groups: FieldGroup[] = [];
  const discriminators: string[] = [];
  const seenFieldNames = new Set<string>();
  const inheritedFieldIndex = new Map<string, number>();
  // §5.2, §5.8: a record's name type is set where it is declared, the kernel's default included,
  // and a composition takes its supertypes' one type: supertypes that disagree compose names of
  // two types, and choosing either would re-judge the other's names by a type they were never
  // declared under.
  let nameType: string | undefined;
  let nameTypeFrom: string | undefined;
  const takeNameType = (from: string, stated: string | undefined): void => {
    if (nameTypeFrom === undefined) {
      nameType = stated;
      nameTypeFrom = from;
    } else {
      requireOneNameType(deps, name, nameTypeFrom, nameType, from, stated);
    }
  };

  for (const rawSupertypeRef of construction.supertypes) {
    if (rawSupertypeRef.kind === 'genericRef') {
      const head = rawSupertypeRef.name;
      const operand = openOperand(deps, name, rawSupertypeRef, parameters, 'supertype');
      if (operand.body.extension === 'FINAL' && construction.removal === undefined) {
        throw new TsonSchemaValidationError(
          `'${name}': supertype '${head}<...>' is FINAL -- it admits no subtype, and composition ` +
            "('&') mints one, in the declaring schema and in any importing schema (§5.2)",
        );
      }
      if (namesOwnParameter(rawSupertypeRef, parameters)) {
        // §5.8, §5.9: `record.supertypes` holds `type_ref`, not a bare name, precisely so a parent
        // still open inside this held template body (`ok => <T> result<T> & { ... }`) is carried
        // through with its own arguments -- on the reference channel it is substituted and closed
        // with the rest of the held body once this template applies (§5.10, `templates.ts`'s own
        // `closeHeld`/`closeApplications`), reaching an IS-A edge to the instantiation its own
        // arguments name rather than to a head name that would hold of every instantiation at once.
        // §5.9 rule 10: a removal drops the open application from the lineage it keeps for names,
        // rather than carrying it forward to close into a live edge one pass later.
        if (construction.removal === undefined) {
          directSupertypes.push({
            name: head,
            arguments: rawSupertypeRef.args.map((a) => typeArgument(deps, a)),
            annotations: [],
          });
        }
      } else {
        // §5.8's last sentence: a fully-bound application standing at a composition operand is
        // "subsumed where it stands" -- its arguments are the member's own contribution, exactly
        // as if the author had written the template's name and the substituted fields by hand --
        // one IS-A edge to the template itself, and it mints no instantiation entry.
        directSupertypes.push({ name: head, arguments: [], annotations: [] });
        addIfAbsent(transitiveSupertypes, seenTransitive, head);
      }
      for (const ancestor of operand.ancestors)
        addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
      absorb(name, operand.body, fields, groups, seenFieldNames, inheritedFieldIndex);
      // An applied template is a supertype like any other, so its name type is one of theirs.
      takeNameType(head, operand.body.nameType);
      continue;
    }
    const supertypeRef: AstTypeRef = rawSupertypeRef;
    if (supertypeRef.kind !== 'simpleRef') {
      throw new TsonSchemaValidationError(
        `'${name}': a ${supertypeRef.kind === 'choiceRef' ? 'choice' : 'bracketed array/tuple'} cannot be a ` +
          `supertype -- '&' composes record types, and this form has ` +
          `${supertypeRef.kind === 'choiceRef' ? 'variants' : 'elements'}, not fields (§5.8)`,
      );
    }
    const supertypeName = supertypeRef.name;
    const supertypeDef = deps.namespaceDefinitions(supertypeName);
    if (supertypeDef === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' names no type this schema declares or imports`,
      );
    }
    // §4.3: "every operand of a composition or subtraction MUST, after following its reference
    // chain (§8.3), be a definition whose body is a `!record`". See `resolveRefinement` for why
    // the composed vocabulary is the terminal's while the recorded name is the author's.
    const supertypeVocabulary = vocabularyOf(deps, supertypeName) ?? supertypeDef;
    if (!isRecordBody(supertypeVocabulary)) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' has no fields to contribute -- its body is a binding record, ` +
          "not a vocabulary, so there is nothing for '&' to compose with (§5.8, and §5.7's vocabulary-body " +
          'rule read across). Compose with the head it derives from',
      );
    }
    // §5.2, §5.9 rule 9: composition mints an IS-A edge, which FINAL refuses outright -- in the
    // declaring schema and in any schema that imports it, since this check runs identically
    // wherever `&` is resolved. Subtraction is exempt (`construction.removal !== undefined`):
    // §5.9 empties `supertypes` for the WHOLE result when a removal clause is present, so no
    // edge to ANY supertype survives, FINAL's one constraint, and there is nothing left to refuse.
    if (supertypeVocabulary.extension === 'FINAL' && construction.removal === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' is FINAL -- it admits no subtype, and composition ` +
          "('&') mints one, in the declaring schema and in any importing schema (§5.2). Subtraction " +
          `stays admissible ('${supertypeName} - { ... }'), since it mints no IS-A edge (§5.9)`,
      );
    }
    directSupertypes.push({ name: supertypeName, arguments: [], annotations: [] });
    for (const ancestor of ofParent(deps, supertypeName))
      addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
    absorb(name, supertypeVocabulary, fields, groups, seenFieldNames, inheritedFieldIndex);
    takeNameType(supertypeName, supertypeVocabulary.nameType);
  }

  if (construction.body !== undefined) {
    // Every type constructor composes the kernel's `type`, and so already has the field `chain`,
    // the IS-A chain the resolver computes (§4.1): one declaring a field of that name is refused
    // where it is declared, rather than when an instance first uses it.
    if (transitiveSupertypes.includes('type') && bodyNames(construction).has(CHAIN_FIELD)) {
      throw new TsonSchemaValidationError(
        `'${name}' composes 'type', so it already has the field 'chain' -- the IS-A chain the ` +
          'resolver computes and no declaration writes (§4.1). Name the field something else',
      );
    }
    for (const entry of construction.body.entries) {
      resolveEntry(
        deps,
        name,
        entry,
        fields,
        groups,
        discriminators,
        seenFieldNames,
        inheritedFieldIndex,
        parameters,
      );
    }
  }
  if (construction.removal !== undefined) {
    applyRemovals(name, construction.removal, bodyNames(construction), fields, groups);
  }
  checkSupertypeChainLimit(name, transitiveSupertypes);

  // §4.1: at most one base kind may be reachable through the supertype chain -- kind is derived
  // rather than stored, so this call is validation-only (its own diagnostic is the point); see
  // `determineKind`'s own doc.
  determineKind(name, transitiveSupertypes);
  const body: RecordBody = {
    kind: 'record',
    fields: fieldMapOf(fields),
    groups,
    extension: 'OPEN',
    ...(discriminators.length > 0 ? { discriminators } : {}),
    ...(nameType !== undefined ? { nameType } : {}),
  };
  // §5.9 rule 8: subtraction breaks IS-A, and a subtracted record keeps no lineage -- its chain is
  // empty whatever its parents were, including one that contributed nothing to the removal (§5.9's
  // own "the clause is head-level").
  const subtracted = construction.removal !== undefined;
  return {
    parameters,
    supertypes: subtracted ? [] : transitiveSupertypes,
    parents: subtracted ? [] : directSupertypes,
    body,
  };
}

/** Every field name this declaration's own body mentions, whether it introduces or tightens it — both are what §5.9 rule 4 forbids a removal from naming. */
function bodyNames(construction: ConstructionDef): Set<string> {
  const names = new Set<string>();
  if (construction.body === undefined) return names;
  for (const entry of construction.body.entries) {
    if (entry.kind === 'fieldDef') {
      names.add(entry.name);
    } else {
      for (const member of groupMembers(entry)) names.add(member.name);
    }
  }
  return names;
}

/**
 * §5.9's removal clause, applied last. Two things are rejected: a name nowhere in the merged
 * field set (rule 2), and a name this declaration's own body mentions (rule 4) — checked first,
 * since a body-introduced field *is* in the merged set and the weaker "no such field" answer
 * would misdiagnose it. A removed member leaves its option and an emptied option leaves the
 * group; a group left with one option that no schema could write dissolves into the plain fields
 * it equals, and removing every member drops the group with them (§5.11).
 */
function applyRemovals(
  declarationName: string,
  removal: RemovalSet,
  bodyDeclared: ReadonlySet<string>,
  fields: NamedField[],
  groups: FieldGroup[],
): void {
  const removed = new Set<string>();
  for (const fieldName of removal.fieldNames) {
    if (bodyDeclared.has(fieldName)) {
      throw new TsonSchemaValidationError(
        `'${declarationName}': removal names '${fieldName}', which this declaration's own body also declares ` +
          '-- a declaration cannot both state a field and remove it (§5.9 rule 4)',
      );
    }
    if (!fields.some((f) => f.name === fieldName)) {
      throw new TsonSchemaValidationError(
        `'${declarationName}': removal names '${fieldName}', which is not a field of the composed type -- ` +
          'only an inherited field can be removed (§5.9 rule 2)',
      );
    }
    removed.add(fieldName);
  }

  const surviving: FieldGroup[] = [];
  for (const group of groups) {
    if (!group.members.flat().some((member) => removed.has(member))) {
      surviving.push(group);
      continue;
    }
    const options = group.members
      .map((option) => option.filter((member) => !removed.has(member)))
      .filter((option) => option.length > 0);
    // A member left alone in its option is present exactly when the option is chosen, so its mark goes.
    const optionalMembers = (group.optionalMembers ?? []).filter((member) =>
      options.some((option) => option.length > 1 && option.includes(member)),
    );
    const first = options[0];
    if (
      options.length > 1 ||
      (first !== undefined && keepsOneOption(first, optionalMembers, group.optional))
    ) {
      surviving.push({
        members: options,
        ...(optionalMembers.length > 0 ? { optionalMembers } : {}),
        optional: group.optional,
      });
    } else if (first !== undefined) {
      dissolveInto(fields, first, optionalMembers, group.optional);
    }
  }
  groups.length = 0;
  groups.push(...surviving);

  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (removed.has(at(fields, i, 'applyRemovals').name)) fields.splice(i, 1);
  }
}

/**
 * Whether a group reduced to one option is still one a schema could write (§5.11): not optional
 * with at least two members, every one marked — the `+` group — or optional with at least two
 * members, one unmarked. Any other one option is plain fields.
 */
function keepsOneOption(
  option: readonly string[],
  optionalMembers: readonly string[],
  optionalGroup: boolean,
): boolean {
  if (option.length < 2) return false;
  const anyUnmarked = option.some((member) => !optionalMembers.includes(member));
  return optionalGroup ? anyUnmarked : !anyUnmarked;
}

/**
 * §5.11: a group reduced to one option it may not keep becomes the plain fields it equals. In a
 * group that is not optional the option is always chosen, so its unmarked members are required and
 * its marked ones optional; in an optional group every member is optional. A sole member takes the
 * group's own `optional` as its own: an unmarked name where the group had to be chosen, `?` on the
 * name where it was optional. The field's own voidability is unchanged.
 */
function dissolveInto(
  fields: NamedField[],
  option: readonly string[],
  optionalMembers: readonly string[],
  optionalGroup: boolean,
): void {
  fields.forEach((field, index) => {
    if (!option.includes(field.name)) return;
    const omittable = optionalGroup || optionalMembers.includes(field.name);
    fields[index] = {
      ...field,
      optional: omittable,
      role: 'FREE',
    };
  });
}

function addIfAbsent(list: string[], seen: Set<string>, name: string): void {
  if (!seen.has(name)) {
    seen.add(name);
    list.push(name);
  }
}

/**
 * §4.1: literal, kernel-fixed base-kind names in the transitive chain — never "inherit the
 * nearest ancestor's own kind". The base kinds are `atom`, `product` and `sum`, and `namespace`
 * beside them; `top` and `type` never count. Called for its validation alone (an entry's kind is
 * derived, never stored, §8.1): a consumer that needs an entry's kind derives it with
 * `entryKind` (`schema/meta/typedef.ts`), which reaches the identical answer from the value.
 */
function determineKind(name: string, transitiveSupertypes: readonly string[]): EntryKind {
  const baseKindsFound = transitiveSupertypes.filter(
    (s) => s === 'atom' || s === 'product' || s === 'sum' || s === 'namespace',
  );
  if (baseKindsFound.length === 0) return 'PRODUCT';
  if (baseKindsFound.length > 1) {
    throw new TsonSchemaValidationError(
      `'${name}' reaches ${String(baseKindsFound.length)} base kinds through its supertypes ` +
        `(${baseKindsFound.join(', ')}) -- §4.1 gives a type exactly one, so nothing can be both. Compose or ` +
        'refine from sources that agree on their base kind',
    );
  }
  switch (baseKindsFound[0]) {
    case 'atom':
      return 'ATOM';
    case 'product':
      return 'PRODUCT';
    case 'sum':
      return 'SUM';
    case 'namespace':
      return 'NAMESPACE';
    default:
      throw new TsonInternalError(`unreachable base kind '${String(baseKindsFound[0])}'`);
  }
}

/**
 * [TSON-SCHEMA] §11.5's "supertype chain" limit: `name`'s own transitive `supertypes` (§8.1) MUST
 * NOT grow past {@link DEFAULT_MAX_SUPERTYPE_CHAIN} entries. `transitiveSupertypes` is already the
 * fully-accumulated chain by the time either caller reaches this -- each direct supertype's own
 * chain folded in by induction (`resolveComposition`'s own top note) -- so the count taken here is
 * exactly what §11.5 names, whether or not a later step (§5.9 subtraction) discards it from the
 * entry's own stored `supertypes`: the walk that built it is the resource spent, regardless of
 * what survives.
 *
 * A limit refusal, not a resolver error: the chain may be entirely well-formed, and the next
 * processor along may simply be configured to walk further.
 */
function checkSupertypeChainLimit(name: string, transitiveSupertypes: readonly string[]): void {
  if (transitiveSupertypes.length > DEFAULT_MAX_SUPERTYPE_CHAIN) {
    throw supertypeChainLimitRefusal(DEFAULT_MAX_SUPERTYPE_CHAIN, name);
  }
}

// ── Refinement (§5.7): T ^ { ... } ───────────────────────────────────────────────────────────

/**
 * `source ^ { ... }`: copies the *entire* inherited field set and any groups from the source's
 * own `RecordBody` — unlike composition, refinement never adds fields, so every body entry MUST
 * tighten one of them. `source` is recorded verbatim as the result's own `source` (unlike
 * composition, which never sets it); `supertypes` accumulates as `[sourceName] +
 * source.supertypes()`.
 */
function resolveRefinement(
  deps: DefinitionResolverDeps,
  name: string,
  refined: RefinedDef,
  parameters: readonly string[],
): Draft {
  if (refined.target.kind === 'genericRef' && namesOwnParameter(refined.target, parameters)) {
    const operand = openOperand(deps, name, refined.target, parameters, 'refinement source');
    const written: TypeRef = {
      name: refined.target.name,
      arguments: refined.target.args.map((a) => typeArgument(deps, a)),
      annotations: [],
    };
    return refineOnto(
      deps,
      name,
      refined,
      parameters,
      written,
      [...operand.ancestors],
      operand.body,
    );
  }
  const sourceRef = resolveRefinementSource(deps, name, refined.target);
  const sourceName = sourceRef.name;
  const sourceDef = deps.namespaceDefinitions(sourceName);
  if (sourceDef === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': refinement source '${sourceName}' names no type this schema declares or imports`,
    );
  }
  // §4.3, §5.7: the operand's body is judged **after following its reference chain** (§8.3), so an
  // alias to a record is an admissible source and an alias to a binding record is not -- "an alias
  // resolving to either is *finished*". The vocabulary tightened is the terminal's; the name
  // recorded in `supertypes` stays the one the author wrote, since §8.3 states the chain as written.
  const sourceVocabulary = vocabularyOf(deps, sourceName) ?? sourceDef;
  if (!isRecordBody(sourceVocabulary)) {
    throw new TsonSchemaValidationError(
      `'${name}': refinement source '${sourceName}' has no vocabulary to tighten -- its body is a binding ` +
        "record, so it is finished and '^' on it is a resolver error (§5.7). Refine the head it derives from, " +
        `or, for an atom instance, use atom refinement ('!${sourceName} ^ { ... }', §5.5)`,
    );
  }
  // §5.2, §5.7: refinement always mints an IS-A edge (a refinement head admits no removal
  // clause, §5.9), so FINAL refuses it unconditionally -- in the declaring schema and in any
  // importing one, on the same terms as composition just above.
  if (sourceVocabulary.extension === 'FINAL') {
    throw new TsonSchemaValidationError(
      `'${name}': refinement source '${sourceName}' is FINAL -- it admits no subtype, and ` +
        "refinement ('^') mints one as surely as composition does, in the declaring schema and in " +
        'any importing schema (§5.2, §5.7)',
    );
  }
  const transitiveSupertypes: string[] = [];
  const seenTransitive = new Set<string>();
  for (const ancestor of ofParent(deps, sourceName))
    addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
  return refineOnto(
    deps,
    name,
    refined,
    parameters,
    sourceRef,
    transitiveSupertypes,
    sourceVocabulary,
  );
}

/**
 * The entry `name`'s reference chain ends at (§8.3), or `undefined` where the walk reaches no
 * entry at all -- an undeclared name, an argument-bearing target, or a cycle.
 *
 * §4.3 states the rule every caller here needs in one line: the source of a refinement and every
 * operand of a composition or subtraction MUST, **after following its reference chain**, be a
 * definition whose body is a `!record`. So an alias to a record is an admissible operand and an
 * alias to a binding record is not -- "an alias resolving to either is *finished*". §5.5 asks the
 * same question of an atom refinement's source.
 *
 * The walk decides only what the operand *is*. What the resolved entry records stays the name the
 * author wrote, because §8.3 states a chain as written and collapses it nowhere.
 */
function vocabularyOf(deps: DefinitionResolverDeps, name: string): Top | undefined {
  return terminalDefinition(name, deps.namespaceDefinitions);
}

/** §5.7's tightening, over a field set already obtained — shared by a closed source (which heads the supertype chain) and an open operand (which names no entry, its template's ancestors standing in the chain instead). `written` is the source as the author wrote it, a template's one parent. */
function refineOnto(
  deps: DefinitionResolverDeps,
  name: string,
  refined: RefinedDef,
  parameters: readonly string[],
  written: TypeRef,
  transitiveSupertypes: readonly string[],
  sourceBody: RecordBody,
): Draft {
  const fields: NamedField[] = [...namedFields(sourceBody)];
  const groups: FieldGroup[] = [...sourceBody.groups];
  const inheritedFieldIndex = new Map<string, number>();
  fields.forEach((f, i) => inheritedFieldIndex.set(f.name, i));

  for (const entry of refined.body.entries) {
    if (entry.kind === 'groupDef') {
      if (!restatesInheritedGroup(deps, name, entry, fields, groups, inheritedFieldIndex)) {
        throw new TsonSchemaValidationError(
          `'${name}': the group ${spellGroup(lowerGroup(entry))} names no inherited group -- a refinement ` +
            "copies its source's whole field set and admits no new fields or groups; composition ('&') is " +
            'what adds one (§5.7, §5.11)',
        );
      }
      continue;
    }
    const index = inheritedFieldIndex.get(entry.name);
    if (index === undefined) {
      throw new TsonSchemaValidationError(
        `'${name}': refinement body field '${entry.name}' names no inherited field -- a refinement copies its ` +
          "source's whole field set and admits no new fields; composition ('&') is what adds one (§5.7)",
      );
    }
    fields[index] = resolveTighteningField(
      deps,
      name,
      entry,
      at(fields, index, 'refineOnto'),
      parameters,
      groups,
    );
  }
  checkSupertypeChainLimit(name, transitiveSupertypes);

  // Validation only -- see `resolveComposition`'s own identical call for why.
  determineKind(name, transitiveSupertypes);
  // §5.2: "the member is never inherited" -- `dog` is OPEN whether `pet` is ABSTRACT or OPEN, and
  // the same holds refining as composing (the rule is stated over the whole record, not the `&`
  // spelling alone). A refinement never introduces a fresh `=?` (`resolveTighteningField` refuses
  // one outright), so `discriminators` is always empty here too; `applyDefinitionMark` (the
  // caller's caller) applies this declaration's own mark, if any, on top of these OPEN defaults,
  // exactly as it does for a composed body.
  const body: RecordBody = {
    kind: 'record',
    fields: fieldMapOf(fields),
    groups,
    extension: 'OPEN',
    // A refinement copies its source's whole vocabulary, the name its fields are values of included.
    ...(sourceBody.nameType !== undefined ? { nameType: sourceBody.nameType } : {}),
  };
  return {
    parameters,
    supertypes: transitiveSupertypes,
    parents: [written],
    body,
  };
}

/** The kernel's default field name type (§5.2), the name an absent `name_type` stands for. */
const FIELD_NAME = 'field_name';

/** §5.8's one name type over a subtype's supertypes: `a` from `aFrom` and `b` from `bFrom`. */
function requireOneNameType(
  deps: DefinitionResolverDeps,
  name: string,
  aFrom: string,
  a: string | undefined,
  bFrom: string,
  b: string | undefined,
): void {
  if (sameNameType(deps, a, b)) return;
  throw new TsonSchemaValidationError(
    `'${name}': supertypes '${aFrom}' and '${bFrom}' have different name types, ` +
      `'${a ?? FIELD_NAME}' and '${b ?? FIELD_NAME}' -- a record's name type is set where it is ` +
      'declared, the default included, and a subtype cannot change it; declare both over one name ' +
      'type (§5.8)',
  );
}

/**
 * Whether two records' name types are one type: the same entry at the end of each one's reference
 * chain (§8.3), not the same spelling, so `jn => json_name` is `json_name` and the kernel's
 * `field_name` is `identifier`. A stated one resolves in the schema's own namespace first, the
 * absent default in the structure; two that resolve to nothing are compared as written, the linker
 * refusing each on its own.
 */
function sameNameType(
  deps: DefinitionResolverDeps,
  a: string | undefined,
  b: string | undefined,
): boolean {
  const ka = nameTypeIdentity(deps, a);
  const kb = nameTypeIdentity(deps, b);
  return ka !== undefined && kb !== undefined ? ka === kb : a === b;
}

/** `nameType`'s terminal entry, qualified by the namespace it is in, or `undefined` where it is in none. */
function nameTypeIdentity(
  deps: DefinitionResolverDeps,
  nameType: string | undefined,
): string | undefined {
  let written = nameType ?? FIELD_NAME;
  if (nameType !== undefined && deps.namespaceDefinitions(written) !== undefined) {
    const end = terminal(written, deps.namespaceDefinitions);
    if (deps.namespaceDefinitions(end) !== undefined) return `schema:${end}`;
    written = end; // an alias of a structure entry, which the walk below continues
  }
  if (deps.metaDefinitions(written) === undefined) return undefined;
  return `structure:${terminal(written, deps.metaDefinitions)}`;
}

/** A refinement's source is always a simple or generic type-ref by grammar. */
function resolveRefinementSource(
  deps: DefinitionResolverDeps,
  name: string,
  target: AstTypeRef,
): TypeRef {
  if (target.kind === 'simpleRef') {
    return { name: target.name, arguments: [], annotations: [] };
  }
  if (target.kind === 'genericRef') {
    return {
      name: closedApplication(deps, name, target, 'refinement source'),
      arguments: [],
      annotations: [],
    };
  }
  throw new TsonInternalError(
    `'${name}': a refinement source is always a simple or generic type-ref by grammar, got '${target.kind}'`,
  );
}

// ── Shared composition/refinement machinery ─────────────────────────────────────────────────

/** One source's fields and groups copied into the record being built — shared by a closed supertype's own `RecordBody` and an open operand's substituted one. */
function absorb(
  name: string,
  source: RecordBody,
  fields: NamedField[],
  groups: FieldGroup[],
  seenFieldNames: Set<string>,
  inheritedFieldIndex: Map<string, number>,
): void {
  for (const field of namedFields(source)) {
    requireFieldNameNotSeen(name, field.name, seenFieldNames, 'SUPERTYPE');
    seenFieldNames.add(field.name);
    inheritedFieldIndex.set(field.name, fields.length);
    fields.push(field);
  }
  groups.push(...source.groups);
}

/** Whether an application is applied to a parameter of the declaration that writes it, and so still open — through nesting (`box<inner<T>>` is as open as `box<T>`). */
function namesOwnParameter(application: GenericRef, typeParams: readonly string[]): boolean {
  return application.args.some((arg) => {
    if (arg.kind !== 'ref') return false;
    if (arg.ref.kind === 'simpleRef') return typeParams.includes(arg.ref.name);
    if (arg.ref.kind === 'genericRef') return namesOwnParameter(arg.ref, typeParams);
    return false;
  });
}

interface OpenOperand {
  readonly ancestors: readonly string[];
  readonly body: RecordBody;
}

/**
 * What an operand — an application at a composition or refinement source, whether it still names
 * this declaration's own parameter or is fully bound and "subsumed where it stands" (§5.8) —
 * contributes to the declaration absorbing it: a field set, and the operand's own ancestors. Not
 * the operand itself — a template is no type (§5.10), so nothing can be IS-A one; its ancestors
 * are types, and its fields arrive with them via {@link substitute}.
 *
 * `held.parameters` (the *named template's own* parameters, `pet`'s `N`/`T`, never `name`'s) are
 * bound the moment this runs, whether or not `name` itself stays open. A parametric modifier takes
 * the name mark its literal spelling takes (§5.7), so substitution leaves each absorbed field with
 * the `optional` and `role` its declaration wrote and nothing is left to fix when the value
 * becomes concrete.
 */
function openOperand(
  deps: DefinitionResolverDeps,
  name: string,
  application: GenericRef,
  typeParams: readonly string[],
  position: string,
): OpenOperand {
  const head = application.name;
  const template = deps.namespaceDefinitions(head);
  if (template === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' names no type this schema declares or imports`,
    );
  }
  const held = heldOf(template);
  if (held === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' declares no type parameters, so it cannot be applied to ` +
        `'${typeParams.join(', ')}' (§5.10)`,
    );
  }
  if (held.parameterNames.length !== application.args.length) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' declares ${String(held.parameterNames.length)} type parameter(s) and ` +
        `is applied to ${String(application.args.length)} (§5.10)`,
    );
  }
  const bindings = new Map<string, TypeArgument>();
  held.parameterNames.forEach((parameter, i) => {
    bindings.set(parameter, typeArgument(deps, at(application.args, i, 'openOperand')));
  });
  if (deps.applicationChecker !== undefined && !namesOwnParameter(application, typeParams)) {
    deps.applicationChecker({ name: head, arguments: [...bindings.values()], annotations: [] });
  }
  const substituted = substitute(held.application.coreValue, head, held.parameterNames, bindings);
  const absorbedValue: DataValue = {
    annotations: held.application.annotations,
    ...(held.application.typeRef === undefined ? {} : { typeRef: held.application.typeRef }),
    coreValue: substituted,
  };
  const absorbed = bindAtomInstance(deps, name, absorbedValue);
  if (!isRecordBody(absorbed)) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}<...>' has no fields to contribute -- it is a binding record, not a ` +
        "vocabulary, so there is nothing to compose with (§5.8, and §5.7's vocabulary-body rule read across)",
    );
  }
  return { ancestors: supertypesOf(template), body: absorbed };
}

/** A fully-bound application at one of the two field-absorbing positions, closed to the entry it denotes. */
function closedApplication(
  deps: DefinitionResolverDeps,
  name: string,
  application: GenericRef,
  position: string,
): string {
  if (deps.applicationCloser === undefined) {
    throw new TsonNotImplementedError(
      `'${name}': closing the ${position} '${application.name}<...>' needs a whole-schema materialiser, and ` +
        'this resolver was built without one',
    );
  }
  const resolved: TypeRef = {
    name: application.name,
    arguments: application.args.map((a) => typeArgument(deps, a)),
    annotations: [],
  };
  return deps.applicationCloser(resolved);
}

// ── Record bodies, fields, and field groups (§5.2, §5.11) ──────────────────────────────────

function resolveRecordBody(
  deps: DefinitionResolverDeps,
  entries: readonly RecordEntry[],
  parameters: readonly string[],
): RecordBody {
  const fields: NamedField[] = [];
  const groups: FieldGroup[] = [];
  const discriminators: string[] = [];
  const seenFieldNames = new Set<string>();
  const inheritedFieldIndex = new Map<string, number>();
  for (const entry of entries) {
    resolveEntry(
      deps,
      undefined,
      entry,
      fields,
      groups,
      discriminators,
      seenFieldNames,
      inheritedFieldIndex,
      parameters,
    );
  }
  return {
    kind: 'record',
    fields: fieldMapOf(fields),
    groups,
    extension: 'OPEN',
    ...(discriminators.length > 0 ? { discriminators } : {}),
  };
}

/**
 * `declarationName` is only used to word error messages -- `undefined` for a fresh record, where
 * `inheritedFieldIndex` is always empty. A `FieldDef` whose name is a key of `inheritedFieldIndex`
 * is a *tightening* entry (§5.7): resolved against, and replacing in place, the already-inherited
 * field at that index, rather than being appended as new.
 */
function resolveEntry(
  deps: DefinitionResolverDeps,
  declarationName: string | undefined,
  entry: RecordEntry,
  fields: NamedField[],
  groups: FieldGroup[],
  discriminators: string[],
  seenFieldNames: Set<string>,
  inheritedFieldIndex: Map<string, number>,
  parameters: readonly string[],
): void {
  if (entry.kind === 'fieldDef') {
    const index = inheritedFieldIndex.get(entry.name);
    if (index !== undefined) {
      fields[index] = resolveTighteningField(
        deps,
        declarationName,
        entry,
        at(fields, index, 'resolveEntry'),
        parameters,
        groups,
      );
    } else {
      requireFieldNameNotSeen(declarationName, entry.name, seenFieldNames, 'BODY_FIELD');
      const { field, selector } = resolveField(deps, entry, parameters, undefined);
      seenFieldNames.add(field.name);
      fields.push(field);
      // §5.2: `=?` lowers into `record.discriminators`, the base's own statement of which fields
      // its members are selected by, in declaration order -- the marked field itself stays FREE,
      // unmarked and unpinned (above). Only a *fresh* field can introduce a selector; a tightening
      // entry narrows an inherited field and never mints a new discriminator --
      // {@link resolveTighteningField} refuses `=?` outright, rather than silently discarding it.
      if (selector) discriminators.push(field.name);
    }
    return;
  }
  if (restatesInheritedGroup(deps, declarationName, entry, fields, groups, inheritedFieldIndex))
    return;
  for (const member of groupMembers(entry)) {
    requireFieldNameNotSeen(declarationName, member.name, seenFieldNames, 'GROUP_MEMBER');
    const field = resolveGroupMember(deps, member);
    seenFieldNames.add(field.name);
    fields.push(field);
  }
  groups.push(lowerGroup(entry));
}

/**
 * §5.7's refinement/tightening rules, applied to one composition- or refinement-body field that
 * names an already-inherited field. `isGroupMember` says whether that inherited field is a
 * field-group member (`groups` already lists it) -- §5.11's own two rules over a restated member,
 * both refused here rather than left to {@link checkFieldRefinementOrder}'s general three orders:
 * **its name mark may be dropped and never added**, since the `?` speaks for the member's option
 * ({@link restateMemberMark}); and **`~ v` stays refused**, a default being a value only omission
 * reaches and omission being the group's. A member's `=` pin is admitted (checked when written,
 * never injected, §5.11) and its type slot may still narrow or tighten voidable true → false, "as
 * at any field" -- both flow through {@link resolveField} exactly as a non-member's do. `=?` is
 * refused for every tightening entry alike, member or not: a discriminator is declared once, at
 * the base (§5.2), and a restatement narrows an inherited field rather than minting a new one.
 */
function resolveTighteningField(
  deps: DefinitionResolverDeps,
  declarationName: string | undefined,
  fieldDef: FieldDef,
  inherited: NamedField,
  parameters: readonly string[],
  groups: FieldGroup[],
): NamedField {
  const prefix = declarationName === undefined ? '' : `'${declarationName}': `;
  const isMember = isGroupMember(groups, fieldDef.name);
  if (fieldDef.modifier?.kind === 'selector') {
    throw new TsonSchemaValidationError(
      `${prefix}'${fieldDef.name}' acquires the selector '=?' by refinement -- a discriminator is ` +
        'declared once, at the base, and every subtype instead restates it pinned FIXED (§5.2, ' +
        `§5.7)${isMember ? '; a member reachable by refinement may not acquire a selector (§5.11)' : ''}`,
    );
  }
  if (isMember) {
    // The default is refused first: it is the more basic fault, and the name mark a member written
    // beside it is then not also reported as loosening its option.
    if (fieldDef.modifier?.kind === 'default') {
      throw new TsonSchemaValidationError(
        `${prefix}the restated group member '${fieldDef.name}' takes a default ('~') -- a default ` +
          "is a value only omission reaches, and omission is the group's, not one member's (§5.11)",
      );
    }
    restateMemberMark(declarationName, fieldDef, groups);
  }
  const { field } = resolveField(deps, fieldDef, parameters, inherited);
  // §5.11: a member is never anything but optional as a field -- its own omission question is its
  // option's and the group's, whatever this restatement's modifier resolved `optional` to.
  const tightened: NamedField = isMember ? { ...field, optional: true } : field;
  checkFieldRefinementOrder(declarationName, fieldDef.name, inherited, tightened, isMember);
  return tightened;
}

/**
 * A restated member's name `?` (§5.11) speaks for its option, not the record: it keeps the member
 * optional once its option is chosen, and leaving it off makes the member required there — the
 * name's `?` is never inherited, at a member as at any field. It may be dropped and never added,
 * since adding one loosens the option. The `+` group, the one group of a single option that may
 * not be left out, is the exception: its members were written without a `?`, so they are restated
 * that way and keep their mark.
 */
function restateMemberMark(
  declarationName: string | undefined,
  fieldDef: FieldDef,
  groups: FieldGroup[],
): void {
  const prefix = declarationName === undefined ? '' : `'${declarationName}': `;
  const index = groups.findIndex((group) =>
    group.members.some((option) => option.includes(fieldDef.name)),
  );
  const group = groups[index];
  if (group === undefined) return;
  const atLeastOne = group.members.length === 1 && !group.optional;
  const marked = (group.optionalMembers ?? []).includes(fieldDef.name);
  if (fieldDef.optional && (atLeastOne || !marked)) {
    throw new TsonSchemaValidationError(
      `${prefix}'${fieldDef.name}' is a member of a field group ${
        atLeastOne
          ? "written with '+', whose members take no '?' -- restate it as written there"
          : "without a '?' on its name, and adding one loosens its option"
      } (§5.11)`,
    );
  }
  if (!fieldDef.optional && marked && !atLeastOne) {
    const optionalMembers = (group.optionalMembers ?? []).filter(
      (member) => member !== fieldDef.name,
    );
    groups[index] = {
      members: group.members,
      ...(optionalMembers.length > 0 ? { optionalMembers } : {}),
      optional: group.optional,
    };
  }
}

/**
 * §5.7's refinement as three independent orders, none of which may move backwards: **omission**
 * (absent → required → injected), **voidable** (true → false), **role** (`FREE` → `DEFAULT` →
 * `FIXED`). Checking the three separately is what lets `a?: T?` tighten to `a: T = v` in one
 * restatement (voidable true→false and role FREE→FIXED both moving forward at once) while still
 * refusing either one alone moving back. `isGroupMember` routes the omission rank through
 * {@link fieldOmission}'s own group carve-out (§5.11): a member's omission is always `'ABSENT'`
 * on both sides, so the axis never fires for one, whatever its role restates to.
 *
 * **Identity.** A restatement may change a **default** value freely but MUST NOT change a
 * **pin** -- the one thing "restated as itself" polices beyond the three orders. Two pins compare
 * as the *values* they denote (§5.5, §5.7: `= 255` and `= 0xFF` collide), not as spelled text.
 */
function checkFieldRefinementOrder(
  declarationName: string | undefined,
  fieldName: string,
  inherited: NamedField,
  tightened: NamedField,
  isGroupMember: boolean,
): void {
  const prefix = declarationName === undefined ? '' : `'${declarationName}': `;
  const OMISSION_RANK: Record<FieldOmission, number> = { ABSENT: 0, MISSING: 1, INJECTED: 2 };
  const omissionRank = (f: NamedField): number => OMISSION_RANK[fieldOmission(f, isGroupMember)];
  if (omissionRank(tightened) < omissionRank(inherited)) {
    throw new TsonSchemaValidationError(
      `${prefix}tightening '${fieldName}' moves its omission question backwards -- a refinement ` +
        'may only move forward through absent, required, injected, never back (§5.7)',
    );
  }
  const voidableRank = (f: NamedField): number => (f.voidable ? 0 : 1);
  if (voidableRank(tightened) < voidableRank(inherited)) {
    throw new TsonSchemaValidationError(
      `${prefix}tightening '${fieldName}' makes a non-voidable field voidable -- voidable may only ` +
        'move true → false under refinement, never back (§5.7)',
    );
  }
  const roleRank = (f: NamedField): number =>
    f.role === 'FREE' ? 0 : f.role === 'DEFAULT' ? 1 : 2;
  if (roleRank(tightened) < roleRank(inherited)) {
    throw new TsonSchemaValidationError(
      `${prefix}tightening '${fieldName}' moves its role backwards -- a refinement may only move ` +
        'forward through FREE, DEFAULT, FIXED, never back (§5.7)',
    );
  }
  if (inherited.role === 'FIXED' && tightened.role === 'FIXED') {
    const before = inherited.value;
    const after = tightened.value;
    if (before !== undefined && after !== undefined && !pinTokensEqual(before, after)) {
      throw new TsonSchemaValidationError(
        `${prefix}restates the pinned field '${fieldName}' with a different value -- a restatement ` +
          'may change a default but MUST NOT change a pin (§5.7)',
      );
    }
  }
}

/**
 * Two `TsonDecimal`s (`unscaled * 10^exponent`) denoting the same magnitude regardless of scale
 * (§5.7: `= 1` and `= 1.0` collide) -- normalises the one with the coarser exponent up to the
 * other's before comparing the unscaled magnitudes.
 */
function decimalEquals(a: TsonDecimal, b: TsonDecimal): boolean {
  if (a.exponent === b.exponent) return a.unscaled === b.unscaled;
  const [lo, hi] = a.exponent < b.exponent ? [a, b] : [b, a];
  return hi.unscaled * 10n ** BigInt(hi.exponent - lo.exponent) === lo.unscaled;
}

/** `text` as the exact numeric value it denotes, when it matches the `number` production at all (§4.3) -- `undefined` for every other token, numeric or not (a special value like `nan`, or an ordinary identifier/boolean spelling). */
function numericTokenValue(text: string): TsonDecimal | undefined {
  const form = tryParseNumber(text);
  if (form === undefined) return undefined;
  if (form.kind === 'integer' || form.kind === 'based-integer') {
    return { unscaled: toExactInteger(form), exponent: 0 };
  }
  if (form.kind === 'float') {
    return toExactDecimal(form);
  }
  return undefined;
}

/**
 * Whether two FIXED-field tokens denote the same value (§5.7: "`= 255` and `= 0xFF` collide, `= 1`
 * and `= 1.0` collide, text pins compare NFC-normalised") -- the two cases this resolver can
 * decide without a type-directed read of the field's own declared type: two unquoted numeric
 * literals compare by exact magnitude regardless of base, digit grouping or scale, and two quoted
 * text tokens (already escape-decoded, §7.2.2–§7.2.3) compare NFC-normalised ([TSON-DATA] §7.1).
 * Everything else -- an identifier spelling, a boolean, an enum member, or either token failing to
 * parse as a number -- falls back to exact text, which is the right answer for every atom family
 * whose value identity is its own spelling.
 */
export function pinTokensEqual(before: Token, after: Token): boolean {
  if (before.form === after.form && before.text === after.text) return true;
  if (before.form === 'UNQUOTED' && after.form === 'UNQUOTED') {
    const a = numericTokenValue(before.text);
    const b = numericTokenValue(after.text);
    return a !== undefined && b !== undefined && decimalEquals(a, b);
  }
  if (before.form !== 'UNQUOTED' && after.form !== 'UNQUOTED') {
    return toNfc(before.text) === toNfc(after.text);
  }
  return false;
}

type FieldOrigin = 'SUPERTYPE' | 'BODY_FIELD' | 'GROUP_MEMBER';

const FIELD_ORIGIN_EXPLANATION: Record<FieldOrigin, string> = {
  SUPERTYPE:
    'two supertypes both contribute it -- supertypes MUST contribute disjoint field sets, including a diamond ' +
    'where both paths reach the same originating type (§5.8)',
  BODY_FIELD:
    "this body declares it twice (§5.11: a field name is unique across a record's plain fields and all its groups' members)",
  GROUP_MEMBER:
    "a group member repeats it -- member labels share the enclosing record's field namespace (§5.11)",
};

function requireFieldNameNotSeen(
  declarationName: string | undefined,
  fieldName: string,
  seenFieldNames: ReadonlySet<string>,
  origin: FieldOrigin,
): void {
  if (seenFieldNames.has(fieldName)) {
    throw new TsonSchemaValidationError(
      `${declarationName === undefined ? '' : `'${declarationName}': `}field '${fieldName}' is declared more ` +
        `than once -- ${FIELD_ORIGIN_EXPLANATION[origin]}`,
    );
  }
}

/**
 * A resolved field, plus whether its own modifier was the selector `=?` (§5.2) -- only a fresh
 * field's own answer is ever consulted (`resolveEntry`, collecting it into `discriminators`); a
 * tightening entry's is never even reached, {@link resolveTighteningField} refusing `=?` outright
 * before it calls this function.
 */
interface ResolvedField {
  readonly field: NamedField;
  readonly selector: boolean;
}

/**
 * §5.8's restated-field annotation merge, which a plain new field also passes through vacuously
 * (`inherited` `undefined` -- own annotations only): the restatement's own annotations, in source
 * order, followed by the inherited field's own (already-merged, so a chain accumulates leader
 * first at every link), in source order. Nothing is dropped and no name is a key -- an inherited
 * field restated twice down a chain carries both restatements' annotations plus the original's,
 * each restatement ahead of what it restates.
 */
function resolveField(
  deps: DefinitionResolverDeps,
  field: FieldDef,
  parameters: readonly string[],
  inherited: NamedField | undefined,
): ResolvedField {
  const base = resolveFieldEntry(deps, field, parameters, inherited);
  const own = annotationsOf(deps, field.name, field.annotations);
  const annotations = inherited === undefined ? own : [...own, ...inherited.annotations];
  return { field: { ...base.field, annotations }, selector: base.selector };
}

function resolveFieldEntry(
  deps: DefinitionResolverDeps,
  field: FieldDef,
  parameters: readonly string[],
  inherited: NamedField | undefined,
): ResolvedField {
  let type: TypeRef;
  if (field.type !== undefined) {
    type = resolveTypeRef(deps, field.type.typeRef);
  } else if (inherited !== undefined) {
    type = inherited.type;
  } else {
    throw new TsonSchemaValidationError(
      `field '${field.name}' states only a modifier and no type-ref, but names no inherited field to take a ` +
        'type from -- a modifier-only entry is always a tightening, so it is only meaningful in a refinement ' +
        'or composition body, against a field the source declares (§5.7)',
    );
  }
  const voidable = field.type !== undefined ? field.type.voidable : (inherited?.voidable ?? false);

  const resolved = resolveFieldMarks(field.name, field.optional, voidable, field.modifier);
  return {
    field: {
      name: field.name,
      type,
      optional: resolved.optional,
      voidable: resolved.voidable,
      role: resolved.role,
      ...(resolved.value === undefined
        ? {}
        : { value: { text: resolved.value.text, form: metaFormOfLexer(resolved.value.form) } }),
      annotations: [],
    },
    selector: resolved.selector,
  };
}

/**
 * §5.11's group restatement, shared by a refinement body and a composition body: a restated group
 * MUST have the same options, their members in the same order (member type-refs restated
 * verbatim), may drop a member's `?` or the group's, and never add one; changing membership is a
 * resolver error. Returns `false` (having applied nothing) when this group names nothing inherited
 * and so is genuinely new -- which a composition body appends and a refinement body rejects, each
 * at its own call site.
 */
function restatesInheritedGroup(
  deps: DefinitionResolverDeps,
  declarationName: string | undefined,
  groupDef: GroupDef,
  fields: NamedField[],
  groups: FieldGroup[],
  inheritedFieldIndex: ReadonlyMap<string, number>,
): boolean {
  const restatement = lowerGroup(groupDef);
  const restated = restatement.members.flat();
  const inheritedMembers = restated.filter((m) => inheritedFieldIndex.has(m));
  if (inheritedMembers.length === 0) return false;
  const prefix = `${declarationName === undefined ? '' : `'${declarationName}': `}the restated group ${spellGroup(restatement)} `;
  if (inheritedMembers.length !== restated.length) {
    throw new TsonSchemaValidationError(
      `${prefix}adds a member the source does not declare -- changing membership is a resolver error (§5.11)`,
    );
  }

  const index = groups.findIndex((g) =>
    g.members.some((option) => option.includes(at(restated, 0, 'restatesInheritedGroup'))),
  );
  if (index < 0) {
    throw new TsonSchemaValidationError(
      `${prefix}names inherited fields that are not a group -- a group can only restate one the source declares as a group (§5.11)`,
    );
  }
  const inherited = at(groups, index, 'restatesInheritedGroup');
  const sameOptions =
    inherited.members.length === restatement.members.length &&
    inherited.members.every(
      (option, i) =>
        option.length === restatement.members[i]?.length &&
        option.every((member, j) => member === restatement.members[i]?.[j]),
    );
  if (!sameOptions) {
    throw new TsonSchemaValidationError(
      `${prefix}does not match the inherited group ${spellGroup(inherited)} -- a restatement MUST ` +
        'have the same options, their members in the same order, and changing membership is a ' +
        'resolver error (§5.11)',
    );
  }
  const inheritedOptional = inherited.optionalMembers ?? [];
  const added = (restatement.optionalMembers ?? []).filter(
    (member) => !inheritedOptional.includes(member),
  );
  if (added.length > 0) {
    throw new TsonSchemaValidationError(
      `${prefix}marks ${added.join(', ')} '?' where the source does not -- a restatement may drop ` +
        "a member's '?' and never add one, which loosens its option (§5.11)",
    );
  }
  for (const member of groupMembers(groupDef)) {
    const restatedType = resolveTypeRef(deps, member.typeRef);
    const inheritedIndex = requiredGet(inheritedFieldIndex, member.name, 'restatesInheritedGroup');
    const inheritedField = at(fields, inheritedIndex, 'restatesInheritedGroup');
    if (!typeRefEquals(restatedType, inheritedField.type)) {
      throw new TsonSchemaValidationError(
        `${prefix}gives member '${member.name}' the type '${restatedType.name}' where the source declares ` +
          `'${inheritedField.type.name}' -- member type-refs are restated verbatim (§5.11); narrowing a ` +
          "member's type is done by naming it as an ordinary field",
      );
    }
    // §5.8's merge, applied to a group member the same way `resolveField` applies it to an
    // ordinary restated field: the restatement's own annotations in source order, then the
    // inherited field's own, in source order. Nothing is dropped and the restatement leads.
    const own = annotationsOf(deps, member.name, member.annotations);
    fields[inheritedIndex] = {
      ...inheritedField,
      annotations: [...own, ...inheritedField.annotations],
    };
  }

  if (!inherited.optional && restatement.optional) {
    throw new TsonSchemaValidationError(
      `${prefix}makes the group optional where the source's is not -- a restatement may drop a ` +
        "group's '?' and never add one (§5.11)",
    );
  }
  groups[index] = restatement;
  return true;
}

/** A fresh group's own member (§5.11, §12.1) -- `*annotation field-name ws ":" ws type-ref`. Bound through the same {@link annotationsOf} every field's own annotations bind through (§6); there is no inherited field to merge onto here, this being a brand-new group rather than a restatement (that merge is {@link restatesInheritedGroup}'s own). */
function resolveGroupMember(deps: DefinitionResolverDeps, member: GroupMember): NamedField {
  return {
    name: member.name,
    type: resolveTypeRef(deps, member.typeRef),
    optional: true,
    voidable: member.voidable,
    role: 'FREE',
    annotations: annotationsOf(deps, member.name, member.annotations),
  };
}

// ── Annotations (§6) ─────────────────────────────────────────────────────────────────────────

/**
 * A declaration's own annotations -- the ones written *after* `=>`. A value is bound through the
 * governing meta the same way §6 describes reading one: the annotation's name resolves one hop
 * against the structure namespace, and its value is read by that type's own compiled reader. A
 * name that does not resolve there is the author's error ({@link unresolvedAnnotation}) -- unless
 * this resolver was built with no {@link AnnotationValueReader} at all (the meta-kernel
 * bootstrap), in which case the check is skipped entirely and every name is kept with its value
 * dropped.
 */
function annotationsOf(
  deps: DefinitionResolverDeps,
  name: string,
  written: readonly WrittenAnnotation[],
): Annotations {
  if (written.length === 0) return [];
  const annotations: Annotation[] = [];
  for (const annotation of written) {
    if (
      deps.annotationValueReader !== undefined &&
      deps.metaDefinitions(annotation.name) === undefined
    ) {
      throw unresolvedAnnotation(deps, name, annotation.name);
    }
    // A bare `@T` is shorthand for `@T:_` (§6): it is read against `T` like a written value, so a
    // type that does not admit the void sentinel refuses the mark as it would refuse `_`. The bare
    // form keeps no value, whatever the read returned.
    const boundValue =
      annotation.value === undefined
        ? (bindAnnotationValue(deps, name, annotation.name, VOID_SENTINEL), undefined)
        : bindAnnotationValue(deps, name, annotation.name, annotation.value);
    annotations.push({
      name: annotation.name,
      ...(boundValue === undefined ? {} : { value: boundValue }),
    });
  }
  return annotations;
}

/** The `_` a bare annotation stands for (§6), read against the annotation's type like a written one. */
const VOID_SENTINEL: DataValue = { annotations: [], coreValue: { kind: 'void' } };

/** §3.3.3's one hop missed: `annotationName` is not an entry of the governing meta-schema's own namespace. */
function unresolvedAnnotation(
  deps: DefinitionResolverDeps,
  declaration: string,
  annotationName: string,
): TsonSchemaValidationError {
  const local = deps.namespaceDefinitions(annotationName) !== undefined;
  return new TsonSchemaValidationError(
    `'${declaration}': '@${annotationName}' does not name a type in the governing meta-schema's namespace, ` +
      'which is the whole annotation namespace of a schema document (one hop through !!meta, §3.3.3)' +
      (local
        ? ' -- the name is declared by this schema or brought in by !!import, which makes it usable by this ' +
          "schema's data documents but not within the schema document itself; declare the annotation type in " +
          'a meta-schema and point !!meta at that'
        : ''),
  );
}

/** An annotation's value through the type its name refers to, or `undefined` when that type is out of reach. */
function bindAnnotationValue(
  deps: DefinitionResolverDeps,
  declaration: string,
  annotationName: string,
  value: DataValue,
): unknown {
  if (deps.metaDefinitions(annotationName) === undefined) return undefined;
  try {
    return deps.annotationValueReader?.(annotationName, value);
  } catch (e) {
    // A refusal under §8.2's name-hygiene policy says this processor declined the value, not that
    // the schema is wrong: it reaches the caller as the fifth outcome, unwrapped.
    if (e instanceof TsonNameHygieneRefusedError && e.pointer === undefined) {
      throw new TsonNameHygieneRefusedError(e.message, {
        mechanism: e.mechanism,
        names: e.names,
        uts39Version: e.uts39Version,
        pointer: `/${declaration}`,
        cause: e,
      });
    }
    if (e instanceof TsonRefusedError) throw e;
    if (e instanceof TsonReadError) {
      throw new TsonSchemaValidationError(
        `'${declaration}': the value of annotation '@${annotationName}' is not valid data for the type ` +
          `'${annotationName}' names -- ${e.message}`,
        { cause: e },
      );
    }
    if (e instanceof TsonMissingBindingError) {
      throw new TsonMissingBindingError(`'${declaration}': ${e.message}`, { cause: e });
    }
    if (e instanceof TsonBindMismatchError) {
      throw new TsonBindMismatchError(`'${declaration}': ${e.message}`, { cause: e });
    }
    throw new TsonNotImplementedError(
      `'${declaration}': failed to bind the value of annotation '@${annotationName}' via the compiled ` +
        `meta-schema reader: ${errorMessage(e)}`,
      { cause: e },
    );
  }
}
