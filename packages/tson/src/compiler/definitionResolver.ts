/**
 * Resolves declarations from a `SchemaMap` (the grammar-layer AST, `ast/schema/`) into
 * `TypeDefinition`s (Part 2 §4, §8) — an incremental, deliberately narrow resolver, not the full
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
 * **Field groups (§5.11) flatten**: each member becomes an ordinary `RecordField` in source
 * position, state `OPTIONAL` regardless of the group's own state (a REQUIRED group still means
 * each *member* is individually optional — at most one is guaranteed, not which); the group
 * itself is recorded separately as a `FieldGroup`. A composed supertype's groups are inherited
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
import { TsonBindMismatchError, TsonMissingBindingError, TsonReadError } from '../core/errors.js';
import type { DataValue, RecordValue } from '../ast/value.js';
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
  Reference,
  Top,
  TypeArgument,
  TypeDefinition,
  TypeKind,
  TypeRef,
} from '../schema/meta/typedef.js';
import type {
  ElementState,
  FieldGroup,
  FieldState,
  RecordBody,
  RecordField,
} from '../schema/meta/bodies.js';
import type {
  AnnotationValueReader,
  ApplicationCloser,
  DefinitionGetter,
  DefinitionMetaReader,
  SourceBodyEncoder,
} from './resolverTypes.js';
import { createHeldBody, type HeldBody } from './heldBody.js';
import {
  defaultAnnotationValueEncoder as defaultHeldAnnotationEncoder,
  heldEmptyRecord,
  heldRecord,
} from './wireForm.js';
import { substitute } from './templateSubstitution.js';
import { resolveFieldModifiers } from './fieldModifiers.js';
import { checkAtomCoherence, checkAtomNarrows, isAtom } from './atomChecks.js';
import { metaFormOfLexer } from './tokenForms.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * Every dependency `resolve`/`annotationsFor` need beyond the declaration in hand — see
 * `resolverTypes.ts` for what each function type is for and why it is a caller-supplied
 * dependency rather than something this module reaches for itself.
 */
export interface DefinitionResolverDeps {
  readonly definitionMetaReader: DefinitionMetaReader;
  readonly annotationValueReader?: AnnotationValueReader;
  readonly metaDefinitions: DefinitionGetter;
  readonly namespaceDefinitions: DefinitionGetter;
  readonly applicationCloser?: ApplicationCloser;
  readonly encodeSourceBody?: SourceBodyEncoder;
}

export interface DefinitionResolver {
  /**
   * Resolves a single declaration against this resolver's own type-name/structure namespaces —
   * the sole entry point; every other function in this module is a private dispatch target
   * reached from here. `position`, when given, is attached to the result's own `position` —
   * "where was this declared" is a property of the declaration itself, so it is attached
   * uniformly here regardless of which internal path actually built the result.
   */
  resolve(declaration: Declaration, position?: SourcePosition): TypeDefinition;

  /**
   * A declaration's own annotations — the ones written *after* `=>`, which §6 says annotate the
   * definition (not the ones before the name, which annotate the key; §6: "does not hoist
   * annotations from key to value"). Exposed for a caller (the eventual `SchemaResolver`) that
   * needs the identical annotation-resolution rule for a schema document's own header position.
   */
  annotationsFor(name: string, written: readonly WrittenAnnotation[]): Annotations;
}

export function createDefinitionResolver(deps: DefinitionResolverDeps): DefinitionResolver {
  return {
    resolve(declaration: Declaration, position?: SourcePosition): TypeDefinition {
      let resolved = resolveTypeDef(deps, declaration.name, declaration.typeDef);
      if (position !== undefined) {
        resolved = { ...resolved, position };
      }
      const annotations = annotationsOf(deps, declaration.name, declaration.typeDefAnnotations);
      return annotations.length > 0 ? { ...resolved, annotations } : resolved;
    },
    annotationsFor(name: string, written: readonly WrittenAnnotation[]): Annotations {
      return annotationsOf(deps, name, written);
    },
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

/** A reference definition whose target is a bare or applied name (§8.3) — `TypeDefinition.reference` in the Java original. */
function referenceDefinition(target: TypeRef, parameters: readonly string[]): TypeDefinition {
  const body: Reference = { kind: 'reference', target };
  return {
    source: target,
    kind: 'REFERENCE',
    parameters,
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

function isRecordBody(body: Top): body is RecordBody {
  return (body as { readonly kind?: unknown }).kind === 'record';
}

function isHeldBody(body: Top): body is HeldBody {
  return 'application' in body;
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
): TypeDefinition {
  if (typeDef.kind === 'structuralTypeDef') {
    const parameters = typeDef.typeParams;
    const constructorFlag = typeDef.constructor;
    const body = typeDef.body;
    if (body.kind === 'recordDef') {
      const recordBody = resolveRecordBody(deps, body.entries, parameters);
      return holdIfOpen(name, {
        kind: 'PRODUCT',
        parameters,
        constructor: constructorFlag,
        supertypes: [],
        subtypes: [],
        body: recordBody,
        annotations: [],
      });
    }
    if (body.kind === 'constructionDef') {
      return holdIfOpen(name, resolveComposition(deps, name, body, constructorFlag, parameters));
    }
    return holdIfOpen(name, resolveRefinement(deps, name, body, constructorFlag, parameters));
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
      : resolveInstanceTemplate(deps, name, typeDef);
  }
  return resolveAtomRefinement(deps, name, typeDef);
}

/**
 * A composition or refinement template's body, held like every other open body — so that one
 * process closes them all. See `heldBody.ts`'s own module doc for why these two are held here
 * (a plain record template is instead rewritten by the desugarer, before resolution runs).
 */
function holdIfOpen(name: string, resolved: TypeDefinition): TypeDefinition {
  if (resolved.parameters.length === 0 || !isRecordBody(resolved.body)) {
    return resolved;
  }
  const record = resolved.body;
  if (record.fields.length === 0 && record.groups.length === 0 && record.supertypes.length === 0) {
    return { ...resolved, body: createHeldBody(heldEmptyRecord()) };
  }
  return {
    ...resolved,
    body: createHeldBody(
      heldRecord(record, (value) => {
        try {
          return defaultHeldAnnotationEncoder(value);
        } catch (e) {
          throw new TsonNotImplementedError(
            `'${name}': failed to re-serialize an annotation value while holding the template's body: ${errorMessage(e)}`,
            { cause: e },
          );
        }
      }),
    ),
  };
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
function resolveInstance(
  deps: DefinitionResolverDeps,
  name: string,
  instance: Instance,
): TypeDefinition {
  const target = requireTypeRef(instance.value, `'${name}'`);
  const constructorDef = resolveConstructorTarget(deps, name, target);
  if (!constructorDef.constructor) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' does not resolve to a constructor (§3.3.1) -- did you mean atom refinement ` +
        `('!${target} ^ { ... }')?`,
    );
  }
  if (!isRecordBody(constructorDef.body)) {
    throw new TsonInternalError(
      `'${name}': constructor '${target}' has a non-record body; a constructor is record-shaped (§7.2) and ` +
        'cannot be declared otherwise',
    );
  }
  const body = bindAtomInstance(deps, name, instance.value);
  return {
    source: { name: target, arguments: [], annotations: [] },
    kind: constructorDef.kind,
    parameters: [],
    constructor: false,
    supertypes: [],
    subtypes: [],
    body,
    annotations: [],
  };
}

const REFERENCE_HEAD = 'reference';

/**
 * `<T, N> !C { ... }` — the open counterpart of {@link resolveInstance}. The payload is held
 * rather than read through the constructor's reader (§5.10) — only the two structural questions
 * that don't depend on the parameters are checked here ({@link checkTemplateBindings}); the rest
 * waits for materialisation.
 */
function resolveInstanceTemplate(
  deps: DefinitionResolverDeps,
  name: string,
  template: Instance,
): TypeDefinition {
  const target = requireTypeRef(template.value, `'${name}'`);
  const constructorDef = resolveConstructorTarget(deps, name, target);
  // `reference` is the one head whose kind cannot come from its supertype chain and whose
  // eligibility cannot come from a `~`: §4.1 gives an alias `kind: REFERENCE`, and the kernel
  // deliberately leaves `reference` unmarked because it describes no value.
  const alias = target === REFERENCE_HEAD;
  if (!alias && !constructorDef.constructor) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${target}' does not resolve to a constructor (§3.3.1), so there is nothing for ` +
        `'<...> !${target} { ... }' to build`,
    );
  }
  if (!isRecordBody(constructorDef.body)) {
    throw new TsonInternalError(
      `'${name}': constructor '${target}' has a non-record body; a constructor is record-shaped (§7.2) and ` +
        'cannot be declared otherwise',
    );
  }
  if (template.value.coreValue.kind === 'record') {
    checkTemplateBindings(name, target, constructorDef.body, template.value.coreValue);
  }
  return {
    source: { name: target, arguments: [], annotations: [] },
    kind: alias ? 'REFERENCE' : constructorDef.kind,
    parameters: template.typeParams,
    constructor: false,
    supertypes: [],
    subtypes: [],
    body: createHeldBody(template.value),
    annotations: [],
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
    if (!vocabulary.fields.some((field) => field.name === binding.name)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${target}' has no field '${binding.name}' to bind (§7.2) -- its fields are ` +
          `[${vocabulary.fields.map((f) => f.name).join(', ')}]`,
      );
    }
    bound.add(binding.name);
  }
  for (const field of vocabulary.fields) {
    if (field.state === 'REQUIRED' && field.value === undefined && !bound.has(field.name)) {
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
 * fields. `I` resolves against the type-name namespace only (§3.3.1) and MUST be a
 * non-constructor instance of an atom family. Merges with `I`'s own already-bound value rather
 * than replacing it ({@link mergeWithSource}), which is what makes a *chained* refinement carry
 * its ancestor's constraints forward.
 */
function resolveAtomRefinement(
  deps: DefinitionResolverDeps,
  name: string,
  refinement: AtomRefinement,
): TypeDefinition {
  const sourceName = refinement.target;
  const source = deps.namespaceDefinitions(sourceName);
  if (source === undefined) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${sourceName}' does not resolve against the type-name namespace (§3.3.1)`,
    );
  }
  if (source.constructor) {
    throw new TsonSchemaValidationError(
      `'${name}': '!${sourceName} ^ { ... }' refines a constructor, not an instance (§3.3.1) -- did you mean ` +
        `constructor application ('!${sourceName} { ... }')?`,
    );
  }
  if (source.kind !== 'ATOM') {
    throw new TsonSchemaValidationError(
      `'${name}': '!${sourceName}' is not an atom-family instance (§5.5), kind=${source.kind}`,
    );
  }
  const constructorRef = source.source;
  if (constructorRef === undefined) {
    throw new TsonInternalError(
      `'${name}': '!${sourceName}' has no recorded constructor to refine through`,
    );
  }
  const merged = mergeWithSource(deps, name, source.body, refinement.bindings, constructorRef.name);
  const body = bindAtomInstance(deps, name, merged);
  checkNarrows(name, sourceName, source.body, body);
  return {
    source: constructorRef,
    kind: source.kind,
    parameters: [],
    constructor: false,
    supertypes: [sourceName],
    subtypes: [],
    body,
    annotations: [],
  };
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
    throw new TsonSchemaValidationError(
      `'${name}': refinement of '!${sourceName}' widens rather than tightens it (§5.7): ${violations.join('; ')}`,
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
    for (const field of newBindings.coreValue.fields) merged.set(field.name, field);
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

/**
 * A constructor-application target (`!C value`) resolves against the structure namespace only —
 * never the type-name namespace (§3.3.1). A constructor is always meta-schema vocabulary,
 * declared in the *governing* meta-schema, one hop via `!!meta`.
 */
function resolveConstructorTarget(
  deps: DefinitionResolverDeps,
  name: string,
  target: string,
): TypeDefinition {
  const structural = deps.metaDefinitions(target);
  if (structural !== undefined) return structural;
  throw new TsonSchemaValidationError(
    `'${name}': '!${target}' does not resolve against the structure namespace (§3.3.1)`,
  );
}

/**
 * Shared by {@link resolveInstance}/{@link resolveAtomRefinement}/{@link openOperand} — reads a
 * type-ref-carrying value against its own constructor's compiled reader, then checks its own
 * internal coherence (§7.2: family coherence is a resolver question, not a data-validation one).
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

/** §7.2: family coherence between a constructor's own bindings is a resolver question, checked here rather than left to the atom parsers (which would surface it as a library-gap "not implemented", exactly the wrong classification for the author's own mistake). */
function checkCoherent(name: string, constructorName: string, body: Top): void {
  if (!isAtom(body)) return;
  const violations = checkAtomCoherence(body);
  if (violations.length > 0) {
    throw new TsonSchemaValidationError(
      `'${name}': the body's own '${constructorName}' constraints contradict each other: ${violations.join('; ')}`,
    );
  }
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
): TypeDefinition {
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
  return referenceDefinition({ name: generic.name, arguments: args, annotations: [] }, parameters);
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
  constructorFlag: boolean,
  parameters: readonly string[],
): TypeDefinition {
  const directSupertypes: string[] = [];
  const transitiveSupertypes: string[] = [];
  const seenTransitive = new Set<string>();
  const fields: RecordField[] = [];
  const groups: FieldGroup[] = [];
  const seenFieldNames = new Set<string>();
  const inheritedFieldIndex = new Map<string, number>();

  for (const rawSupertypeRef of construction.supertypes) {
    if (rawSupertypeRef.kind === 'genericRef' && namesOwnParameter(rawSupertypeRef, parameters)) {
      const operand = openOperand(deps, name, rawSupertypeRef, parameters, 'supertype');
      for (const ancestor of operand.ancestors)
        addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
      absorb(name, operand.body, fields, groups, seenFieldNames, inheritedFieldIndex);
      continue;
    }
    let supertypeRef: AstTypeRef = rawSupertypeRef;
    if (supertypeRef.kind === 'genericRef') {
      supertypeRef = {
        kind: 'simpleRef',
        name: closedApplication(deps, name, supertypeRef, 'supertype'),
      };
    }
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
    if (!isRecordBody(supertypeDef.body)) {
      throw new TsonSchemaValidationError(
        `'${name}': supertype '${supertypeName}' has no fields to contribute -- its body is a binding record, ` +
          "not a vocabulary, so there is nothing for '&' to compose with (§5.8, and §5.7's vocabulary-body " +
          'rule read across). Compose with the head it derives from',
      );
    }
    directSupertypes.push(supertypeName);
    addIfAbsent(transitiveSupertypes, seenTransitive, supertypeName);
    for (const ancestor of supertypeDef.supertypes)
      addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
    absorb(name, supertypeDef.body, fields, groups, seenFieldNames, inheritedFieldIndex);
  }

  if (construction.body !== undefined) {
    for (const entry of construction.body.entries) {
      resolveEntry(
        deps,
        name,
        entry,
        fields,
        groups,
        seenFieldNames,
        inheritedFieldIndex,
        parameters,
      );
    }
  }
  if (construction.removal !== undefined) {
    applyRemovals(name, construction.removal, bodyNames(construction), fields, groups);
  }
  checkGroupPresence(name, fields, groups);

  const kind = determineKind(name, transitiveSupertypes);
  const body: RecordBody = { kind: 'record', supertypes: directSupertypes, fields, groups };
  // §5.9: subtraction breaks IS-A. The contract index (supertypes) is emptied while the body
  // keeps `directSupertypes` as authorial lineage (record.supertypes) -- for EVERY supertype,
  // including one that contributed nothing to the removal (§5.9's own "the clause is head-level").
  const contract = construction.removal !== undefined ? [] : transitiveSupertypes;
  return {
    kind,
    parameters,
    constructor: constructorFlag,
    supertypes: contract,
    subtypes: [],
    body,
    annotations: [],
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
      for (const member of entry.members) names.add(member.name);
    }
  }
  return names;
}

/**
 * §5.9's removal clause, applied last. Two things are rejected: a name nowhere in the merged
 * field set (rule 2), and a name this declaration's own body mentions (rule 4) — checked first,
 * since a body-introduced field *is* in the merged set and the weaker "no such field" answer
 * would misdiagnose it. A group left with one surviving member dissolves into an ordinary field
 * taking the group's own state (§5.11).
 */
function applyRemovals(
  declarationName: string,
  removal: RemovalSet,
  bodyDeclared: ReadonlySet<string>,
  fields: RecordField[],
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
    const members = group.members.filter((m) => !removed.has(m));
    if (members.length === group.members.length) {
      surviving.push(group);
    } else if (members.length > 1) {
      surviving.push({ members, state: group.state });
    } else if (members.length === 1) {
      dissolveInto(fields, at(members, 0, 'applyRemovals'), group.state);
    }
  }
  groups.length = 0;
  groups.push(...surviving);

  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (removed.has(at(fields, i, 'applyRemovals').name)) fields.splice(i, 1);
  }
}

/** §5.11: the last member of a dissolved group becomes a plain field carrying the group's own state. */
function dissolveInto(fields: RecordField[], member: string, groupState: ElementState): void {
  const state: FieldState = groupState === 'OPTIONAL' ? 'OPTIONAL' : 'REQUIRED';
  const index = fields.findIndex((f) => f.name === member);
  if (index >= 0) {
    fields[index] = { ...at(fields, index, 'dissolveInto'), state };
  }
}

function addIfAbsent(list: string[], seen: Set<string>, name: string): void {
  if (!seen.has(name)) {
    seen.add(name);
    list.push(name);
  }
}

/** §4.1: literal, kernel-fixed base-kind names in the transitive chain — never "inherit the nearest ancestor's own kind". */
function determineKind(name: string, transitiveSupertypes: readonly string[]): TypeKind {
  const baseKindsFound = transitiveSupertypes.filter(
    (s) => s === 'atom' || s === 'product' || s === 'sum' || s === 'data',
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
    case 'data':
      return 'DATA';
    default:
      throw new TsonInternalError(`unreachable base kind '${String(baseKindsFound[0])}'`);
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
  constructorFlag: boolean,
  parameters: readonly string[],
): TypeDefinition {
  if (refined.target.kind === 'genericRef' && namesOwnParameter(refined.target, parameters)) {
    const operand = openOperand(deps, name, refined.target, parameters, 'refinement source');
    return refineOnto(
      deps,
      name,
      refined,
      constructorFlag,
      parameters,
      undefined,
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
  if (!isRecordBody(sourceDef.body)) {
    throw new TsonSchemaValidationError(
      `'${name}': refinement source '${sourceName}' has no vocabulary to tighten -- its body is a binding ` +
        "record, so it is finished and '^' on it is a resolver error (§5.7). Refine the head it derives from, " +
        `or, for an atom instance, use atom refinement ('!${sourceName} ^ { ... }', §5.5)`,
    );
  }
  const transitiveSupertypes: string[] = [];
  const seenTransitive = new Set<string>();
  addIfAbsent(transitiveSupertypes, seenTransitive, sourceName);
  for (const ancestor of sourceDef.supertypes)
    addIfAbsent(transitiveSupertypes, seenTransitive, ancestor);
  return refineOnto(
    deps,
    name,
    refined,
    constructorFlag,
    parameters,
    sourceRef,
    transitiveSupertypes,
    sourceDef.body,
  );
}

/** §5.7's tightening, over a field set already obtained — shared by a closed source (which heads the supertype chain and becomes `source`) and an open operand (neither, since it names no entry). */
function refineOnto(
  deps: DefinitionResolverDeps,
  name: string,
  refined: RefinedDef,
  constructorFlag: boolean,
  parameters: readonly string[],
  source: TypeRef | undefined,
  transitiveSupertypes: readonly string[],
  sourceBody: RecordBody,
): TypeDefinition {
  const fields: RecordField[] = [...sourceBody.fields];
  const groups: FieldGroup[] = [...sourceBody.groups];
  const inheritedFieldIndex = new Map<string, number>();
  fields.forEach((f, i) => inheritedFieldIndex.set(f.name, i));

  for (const entry of refined.body.entries) {
    if (entry.kind === 'groupDef') {
      if (!restatesInheritedGroup(deps, name, entry, fields, groups, inheritedFieldIndex)) {
        throw new TsonSchemaValidationError(
          `'${name}': the group (${memberNames(entry).join(' | ')}) names no inherited group -- a refinement ` +
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
    );
  }
  checkGroupPresence(name, fields, groups);

  const kind = determineKind(name, transitiveSupertypes);
  const body: RecordBody = { kind: 'record', supertypes: [], fields, groups };
  return {
    ...(source === undefined ? {} : { source }),
    kind,
    parameters,
    constructor: constructorFlag,
    supertypes: transitiveSupertypes,
    subtypes: [],
    body,
    annotations: [],
  };
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
  fields: RecordField[],
  groups: FieldGroup[],
  seenFieldNames: Set<string>,
  inheritedFieldIndex: Map<string, number>,
): void {
  for (const field of source.fields) {
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
 * What an operand still open (applied to this declaration's own parameter) contributes to the
 * declaration absorbing it: a field set, and the operand's own ancestors. Not the operand
 * itself — a template is no type (§5.10), so nothing can be IS-A one; its ancestors are types,
 * and its fields arrive with them via {@link substitute}.
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
  if (!isHeldBody(template.body)) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' declares no type parameters, so it cannot be applied to ` +
        `'${typeParams.join(', ')}' (§5.10)`,
    );
  }
  if (template.parameters.length !== application.args.length) {
    throw new TsonSchemaValidationError(
      `'${name}': ${position} '${head}' declares ${String(template.parameters.length)} type parameter(s) and ` +
        `is applied to ${String(application.args.length)} (§5.10)`,
    );
  }
  const bindings = new Map<string, TypeArgument>();
  template.parameters.forEach((parameter, i) => {
    bindings.set(parameter, typeArgument(deps, at(application.args, i, 'openOperand')));
  });
  const held = template.body;
  const substituted = substitute(held.application.coreValue, head, template.parameters, bindings);
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
  return { ancestors: template.supertypes, body: absorbed };
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
  const fields: RecordField[] = [];
  const groups: FieldGroup[] = [];
  const seenFieldNames = new Set<string>();
  const inheritedFieldIndex = new Map<string, number>();
  for (const entry of entries) {
    resolveEntry(
      deps,
      undefined,
      entry,
      fields,
      groups,
      seenFieldNames,
      inheritedFieldIndex,
      parameters,
    );
  }
  return { kind: 'record', supertypes: [], fields, groups };
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
  fields: RecordField[],
  groups: FieldGroup[],
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
      );
    } else {
      requireFieldNameNotSeen(declarationName, entry.name, seenFieldNames, 'BODY_FIELD');
      const field = resolveField(deps, entry, parameters, undefined);
      seenFieldNames.add(field.name);
      fields.push(field);
    }
    return;
  }
  if (restatesInheritedGroup(deps, declarationName, entry, fields, groups, inheritedFieldIndex))
    return;
  const members: string[] = [];
  for (const member of entry.members) {
    requireFieldNameNotSeen(declarationName, member.name, seenFieldNames, 'GROUP_MEMBER');
    const field = resolveGroupMember(deps, member);
    seenFieldNames.add(field.name);
    fields.push(field);
    members.push(field.name);
  }
  groups.push({ members, state: entry.optional ? 'OPTIONAL' : 'REQUIRED' });
}

/** §5.7's refinement/tightening rules, applied to one composition-body field that names an already-inherited field. */
function resolveTighteningField(
  deps: DefinitionResolverDeps,
  declarationName: string | undefined,
  fieldDef: FieldDef,
  inherited: RecordField,
  parameters: readonly string[],
): RecordField {
  const tightened = resolveField(deps, fieldDef, parameters, inherited);
  if (!isValidTighteningTransition(inherited.state, tightened.state)) {
    throw new TsonSchemaValidationError(
      `${declarationName === undefined ? '' : `'${declarationName}': `}tightening '${fieldDef.name}' from ` +
        `${inherited.state} to ${tightened.state} is not a permitted state transition -- a refinement can ` +
        'only restrict, never expand (§5.7)',
    );
  }
  return tightened;
}

/** §5.7's refinement state-transition table: FIXED states are terminal, OPTIONAL→REQUIRED is the only direction, never back. */
function isValidTighteningTransition(from: FieldState, to: FieldState): boolean {
  switch (from) {
    case 'REQUIRED':
      return to === 'REQUIRED' || to === 'REQUIRED_DEFAULT' || to === 'REQUIRED_FIXED';
    case 'OPTIONAL':
      return true;
    case 'REQUIRED_DEFAULT':
      return to === 'REQUIRED_DEFAULT' || to === 'REQUIRED_FIXED';
    case 'REQUIRED_FIXED':
      return to === 'REQUIRED_FIXED';
    case 'OPTIONAL_FIXED':
      return to === 'OPTIONAL_FIXED';
  }
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

function resolveField(
  deps: DefinitionResolverDeps,
  field: FieldDef,
  parameters: readonly string[],
  inherited: RecordField | undefined,
): RecordField {
  const base = resolveFieldEntry(deps, field, parameters, inherited);
  const annotations = annotationsOf(deps, field.name, field.annotations);
  return { ...base, annotations };
}

function resolveFieldEntry(
  deps: DefinitionResolverDeps,
  field: FieldDef,
  parameters: readonly string[],
  inherited: RecordField | undefined,
): RecordField {
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
  const optional =
    field.type !== undefined
      ? field.type.optional
      : inherited !== undefined
        ? isOptionalState(inherited.state)
        : false;

  const resolved = resolveFieldModifiers(field.name, optional, field.modifier, parameters);
  return {
    name: field.name,
    type,
    state: resolved.state,
    ...(resolved.value === undefined
      ? {}
      : { value: { text: resolved.value.text, form: metaFormOfLexer(resolved.value.form) } }),
    annotations: [],
  };
}

/** §5.2's presence axis: the two states under which a conforming value may leave the field out. */
function isOptionalState(state: FieldState): boolean {
  return state === 'OPTIONAL' || state === 'OPTIONAL_FIXED';
}

/**
 * §5.11's presence rule: a group under which two members are always present (both in a
 * REQUIRED-family state) is a resolver error -- a group means at most one member is present, so
 * two that must always be there is a contract nothing can satisfy. Run for composition bodies
 * too, not only refinement (§5.7's tightening rules govern both).
 */
function checkGroupPresence(
  declarationName: string | undefined,
  fields: readonly RecordField[],
  groups: readonly FieldGroup[],
): void {
  for (const group of groups) {
    const alwaysPresent = group.members.filter((member) =>
      isAlwaysPresent(stateOf(fields, member)),
    );
    if (alwaysPresent.length > 1) {
      throw new TsonSchemaValidationError(
        `${declarationName === undefined ? '' : `'${declarationName}': `}members ${alwaysPresent.join(' and ')} ` +
          `of the group (${group.members.join(' | ')}) are both always present, but at most one member of a ` +
          'group may be (§5.11) -- no value could satisfy this type. Leave all but one in an OPTIONAL state, ' +
          "or fix the others to absent ('= _')",
      );
    }
  }
}

function isAlwaysPresent(state: FieldState): boolean {
  return state === 'REQUIRED' || state === 'REQUIRED_DEFAULT' || state === 'REQUIRED_FIXED';
}

function stateOf(fields: readonly RecordField[], name: string): FieldState {
  const field = fields.find((f) => f.name === name);
  if (field === undefined) {
    throw new TsonInternalError(
      `group member '${name}' has no field -- a group's members are flattened into the field list as they are resolved`,
    );
  }
  return field.state;
}

function memberNames(groupDef: GroupDef): string[] {
  return groupDef.members.map((m) => m.name);
}

/**
 * §5.11's group restatement, shared by a refinement body and a composition body: a restated group
 * MUST have the same member labels in the same order (member type-refs restated verbatim), and
 * may tighten state OPTIONAL→REQUIRED; REQUIRED→OPTIONAL or changing membership is a resolver
 * error. Returns `false` (having applied nothing) when this group names nothing inherited and so
 * is genuinely new -- which a composition body appends and a refinement body rejects, each at its
 * own call site.
 */
function restatesInheritedGroup(
  deps: DefinitionResolverDeps,
  declarationName: string | undefined,
  groupDef: GroupDef,
  fields: RecordField[],
  groups: FieldGroup[],
  inheritedFieldIndex: ReadonlyMap<string, number>,
): boolean {
  const restated = memberNames(groupDef);
  const inheritedMembers = restated.filter((m) => inheritedFieldIndex.has(m));
  if (inheritedMembers.length === 0) return false;
  const prefix = `${declarationName === undefined ? '' : `'${declarationName}': `}the restated group (${restated.join(' | ')}) `;
  if (inheritedMembers.length !== restated.length) {
    throw new TsonSchemaValidationError(
      `${prefix}adds a member the source does not declare -- changing membership is a resolver error (§5.11)`,
    );
  }

  const index = groups.findIndex((g) =>
    g.members.includes(at(restated, 0, 'restatesInheritedGroup')),
  );
  if (index < 0) {
    throw new TsonSchemaValidationError(
      `${prefix}names inherited fields that are not a group -- a group can only restate one the source declares as a group (§5.11)`,
    );
  }
  const inherited = at(groups, index, 'restatesInheritedGroup');
  const sameOrder =
    inherited.members.length === restated.length &&
    inherited.members.every((m, i) => m === restated[i]);
  if (!sameOrder) {
    throw new TsonSchemaValidationError(
      `${prefix}does not match the inherited group (${inherited.members.join(' | ')}) -- a restatement MUST ` +
        'have the same member labels in the same order, and changing membership is a resolver error (§5.11)',
    );
  }
  for (const member of groupDef.members) {
    const restatedType = resolveTypeRef(deps, member.typeRef);
    const inheritedIndex = requiredGet(inheritedFieldIndex, member.name, 'restatesInheritedGroup');
    const inheritedType = at(fields, inheritedIndex, 'restatesInheritedGroup').type;
    if (!typeRefEquals(restatedType, inheritedType)) {
      throw new TsonSchemaValidationError(
        `${prefix}gives member '${member.name}' the type '${restatedType.name}' where the source declares ` +
          `'${inheritedType.name}' -- member type-refs are restated verbatim (§5.11); narrowing a member's ` +
          'type is done by naming it as an ordinary field',
      );
    }
  }

  const state: ElementState = groupDef.optional ? 'OPTIONAL' : 'REQUIRED';
  if (inherited.state === 'REQUIRED' && state === 'OPTIONAL') {
    throw new TsonSchemaValidationError(
      `${prefix}loosens a REQUIRED group to OPTIONAL -- a restatement may only tighten OPTIONAL→REQUIRED (§5.11)`,
    );
  }
  groups[index] = { members: inherited.members, state };
  return true;
}

function resolveGroupMember(deps: DefinitionResolverDeps, member: GroupMember): RecordField {
  return {
    name: member.name,
    type: resolveTypeRef(deps, member.typeRef),
    state: 'OPTIONAL',
    annotations: [],
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
    const boundValue =
      annotation.value === undefined
        ? undefined
        : bindAnnotationValue(deps, name, annotation.name, annotation.value);
    annotations.push({
      name: annotation.name,
      ...(boundValue === undefined ? {} : { value: boundValue }),
    });
  }
  return annotations;
}

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
