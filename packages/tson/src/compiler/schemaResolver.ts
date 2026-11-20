/**
 * Resolves a whole {@link SchemaDocument} into a {@link Schema}: `!!id`/`!!import` handling, merging every
 * import's entries into the schema's one namespace before any local declaration resolves (Part 2 §2.2.3, §3.3),
 * driving `definitionResolver.ts` over every declaration on demand (dependency order, not source order, §3.4.1),
 * and the derived `@meta.application` and `@meta.completion` key annotations (§8.1, §8.2). A type position naming
 * an `alias` entry is left exactly as the author wrote it (§8.3).
 *
 * **One namespace per schema (§3.3).** Every name -- a construction head, a refinement source, a type position,
 * an annotation -- resolves in the document's own entries and its import closure's, from the root. A schema map
 * nested as an entry (`geo => !schema { ... }`) declares its members under their paths, and a map of one path
 * declared by several documents of one closure is the union of their members.
 *
 * **Nothing is lifted or minted (§4.2).** A sugar form is written in place where it stands, so the entries out
 * are the declarations in; an incomplete entry (§5.5) is among them, held so an import carries it, and written in
 * no resolved form.
 *
 * **This module does not fetch, link, or register anything.** It takes each import's already-resolved entries
 * ({@link SchemaResolverDeps.resolveImport}) and the readers a body is read through
 * ({@link SchemaResolverDeps.readers}) as caller-supplied dependencies. A caller with no loader omits
 * `resolveImport`; this module then reports {@link TsonNotImplementedError} the moment a document writes
 * `!!import`.
 *
 * **The kernel resolves through the same lookup (§3.4).** Every construction head in `meta.tn` names an entry
 * `meta.tn` declares, and a head is made ready, on demand, before an instance that applies it is read, so the
 * kernel needs no imported vocabulary and no special case beyond being handed no import.
 */
import {
  TsonBindMismatchError,
  TsonInternalError,
  TsonNameHygieneRefusedError,
  TsonNotImplementedError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import { diagnosticCodeForFetch, diagnosticCodeForMechanism } from '../core/diagnostic.js';
import type { Diagnostic, DiagnosticsReceiver } from '../core/diagnostic.js';
import type { Position } from '../core/position.js';
import type { Declaration, SchemaDocument } from '../ast/schema/document.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { FieldNameType } from '../link/fieldNames.js';
import { NO_FIELDS } from '../schema/meta/bodies.js';
import type { Annotations, EntryFacts, Top } from '../schema/meta/typedef.js';
import {
  APPLICATION_ANNOTATION,
  COMPLETION_ANNOTATION,
  chainOf,
  isParametric,
  typeParameters,
  isType,
  typeChain,
  withChain,
  withCompletion,
} from '../schema/meta/typedef.js';
import { isNestedMap, syncedEntries } from '../schema/meta/schemaPaths.js';
import { DEFAULT_MAX_WAIT_DEPTH, waitDepthLimitRefusal } from '../core/limits.js';
import {
  createDefinitionResolver,
  type DefinitionResolver,
  type DefinitionResolverDeps,
} from './definitionResolver.js';
import type {
  AnnotationValueReader,
  DefinitionGetter,
  DefinitionMetaReader,
  DefinitionValueReader,
  EntryFactsTable,
  SourceBodyEncoder,
} from './resolverTypes.js';
import { checkParameterBounds } from './parameterBounds.js';
import { applicationsOf } from '../schema/meta/typeInline.js';
import { desugar, typeParamsOf, type DesugarFailureReporter } from './desugar.js';
import { looseAnnotationValue } from './looseAnnotation.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * A resolved schema (Part 2 §8): a value of the kernel's `meta.schema`, the namespace type `{type_name =>
 * declared}` (§4.1) -- an entry is its value (§8.1) -- plus the header directives the document carried
 * (`!!id`/`!!import*`, §2.2). `entries` holds this schema's own entries only, at every depth and keyed by
 * path (`geo.address`), a nested map's own entry derived from its members (`schema/meta/schemaPaths.ts`);
 * insertion order is preserved, matching `SchemaMap.declarations`'s own ordering guarantee.
 *
 * `facts` holds what an entry's value cannot (§8.1's {@link EntryFacts}): where it was declared, the
 * annotations written on its value, the constructor its tag names -- present only for an entry with any to
 * record. `keyAnnotations` are the key's: those written before the name, and the resolver-attached
 * `@meta.application` and `@meta.completion` (§8.1, §8.2).
 *
 * `id` is a plain `string`, not optional -- the grammar itself marks `!!id` optional (a raw parsed
 * {@link SchemaDocument} can genuinely lack one), but a *resolved* schema always needs a real identity;
 * {@link resolveSchema} enforces this before ever constructing one.
 *
 * `bootstrap` is `true` only for a schema `bootstrap.ts`'s `bootstrapKernel` itself produced (§3.4: the
 * kernel is pre-loaded, never resolved from a document, and nothing else is allowed to claim it).
 *
 * **`entries`/`keyAnnotations` are two parallel maps, not one `AnnotatedMap`.** `annotations/index.ts`
 * declares an `AnnotatedMap<K, V>` with exactly this shape, but its own `Annotations` is the *wire* carrier
 * -- a different, incompatible type from `schema/meta/typedef.ts`'s own local stand-in that every other
 * annotation-carrying field in this module already uses.
 */
export interface Schema {
  readonly id: string;
  readonly imports: readonly string[];
  /** Every resolved entry's value, local-only (imported entries are visible during resolution but never part of this). */
  readonly entries: ReadonlyMap<string, Top>;
  /** `entries.get(name)`'s own key-position annotations (§6, §8.1, §8.2) -- present only for a name that carries at least one. */
  readonly keyAnnotations: ReadonlyMap<string, Annotations>;
  /** `entries.get(name)`'s facts beyond its value (§8.1) -- present only for a name with any recorded. */
  readonly facts: ReadonlyMap<string, EntryFacts>;
  readonly bootstrap: boolean;
}

/** One `!!import`'s own resolved namespace, and where each of its entries was originally declared. */
export interface ImportedSchema {
  /** Every entry this import contributes -- its own whole, transitively-merged namespace, keyed by path. */
  readonly entries: ReadonlyMap<string, Top>;
  /** Each contributed entry's facts, where its schema recorded any. Absent means none. */
  readonly facts?: ReadonlyMap<string, EntryFacts>;
  /** Each contributed entry's key annotations, where its schema recorded any. Absent means none. */
  readonly keyAnnotations?: ReadonlyMap<string, Annotations>;
  /**
   * `name`'s origin schema id, for the identity-based collision rule §2.2.3 states: one schema reached by
   * several `!!import` routes unifies (same origin, kept once), two different schemas declaring one name is
   * an error (different origins). Called only for a name `entries` holds.
   */
  readonly originOf: (name: string) => string;
  /**
   * Reads an annotation value through the type `name` of this import's entries, as its own compiled schema
   * reads it. Absent means this import offers none.
   */
  readonly annotationReader?: AnnotationValueReader;
  /** Each enum among `entries` that matches in a form other than `NONE`, by name -- `LinkedSchema.enumForms`. Absent means none. */
  readonly enumForms?: ReadonlyMap<string, Normalization>;
  /** Each record among `entries` that states a `name_type`, with its identifier family -- `LinkedSchema.nameTypes`. Absent means none. */
  readonly nameTypes?: ReadonlyMap<string, FieldNameType>;
}

/** Resolves one `!!import` directive's URI to the namespace it contributes. */
export type ImportResolver = (importUri: string) => ImportedSchema;

/** The readers a schema's bodies are read through, over the lookup that finds a name's entry. */
export interface ResolverReaders {
  /** Reads `!C { ... }` against constructor `C`'s own bindings (§5.5). */
  readonly meta: DefinitionMetaReader;
  /** Reads a value entry's payload against the ordinary type its tag names (§4.1). */
  readonly value?: DefinitionValueReader;
  /** Reads an annotation's value through the type its name refers to (§6). */
  readonly annotation?: AnnotationValueReader;
}

/**
 * Every dependency {@link resolveSchema} needs beyond the document in hand. `readers` is a factory because
 * the readers consult the namespace being built -- a constructor's own declaration supplies its fields'
 * defaults -- so they are made over the lookup this resolution runs.
 */
export interface SchemaResolverDeps {
  readonly readers: (lookup: DefinitionGetter) => ResolverReaders;
  readonly encodeSourceBody?: SourceBodyEncoder;
  /** Resolves an `!!import` URI's namespace. Omitted means "no loader": a document with no `!!import` is unaffected; one that writes any reports {@link TsonNotImplementedError}. */
  readonly resolveImport?: ImportResolver;
  /**
   * `max_wait_depth` ([TSON-SCHEMA] §11.5): the longest chain of waits resolving one schema may run, each entry
   * waiting on the next being ready. A chain past it refuses the entry at its head, whichever order it was
   * reached in. Defaults to {@link DEFAULT_MAX_WAIT_DEPTH}.
   */
  readonly maxWaitDepth?: number;
}

/** Options for {@link resolveSchema}. */
export interface ResolveSchemaOptions {
  /**
   * An identity-keyed source position for a declaration `document` carries, overriding that
   * declaration's own {@link Declaration.position} where both are present -- a caller tracking
   * positions out of band (across a rewrite this module does not itself see, say) can still name
   * one exactly. Mirrors `desugar.ts`'s own `DesugarOptions.positions` -- indeed the very same map,
   * threaded through both phases so a declaration desugaring rebuilds keeps its position.
   *
   * **Omitting this is not "no positions at all".** Every resolved entry's `position` fact
   * (§8.1's diagnostic addition) falls back to `declaration.position` -- the position
   * `compiler/schemaParser.ts` already stamps on every declaration it parses -- so a caller that
   * builds no side-table of its own (every caller today) still gets one, via {@link positionOf}.
   */
  readonly positions?: WeakMap<Declaration, Position>;
  /**
   * Where a failed declaration is reported, letting every other declaration still resolve
   * ([TSON-DATA] §8.1: "continue processing after an error to report multiple issues in a single
   * pass"). Omitted means fail-fast: the first {@link ReportableSchemaError} propagates instead,
   * and the caller sees the exact declaration that failed.
   *
   * **The result is only trustworthy when nothing was reported.** A schema that produced
   * diagnostics contains placeholder entries in place of every declaration that failed -- see
   * {@link unresolvedPlaceholder} -- and must not be linked, registered, or compiled.
   */
  readonly receiver?: DiagnosticsReceiver;
}

/**
 * `declaration`'s own source position for a diagnostic: `positions`' own side-table entry when
 * one is supplied and holds one, falling back to the position `compiler/schemaParser.ts` already
 * stamped onto every declaration it parses ({@link Declaration.position}). Every call site in this
 * module reads a declaration's position through this helper rather than `positions?.get(declaration)`
 * directly, so a caller supplying no side-table of its own -- every caller today -- still gets a
 * position rather than `undefined` on every diagnostic and every resolved entry.
 */
function positionOf(
  declaration: Declaration,
  positions: WeakMap<Declaration, Position> | undefined,
): Position | undefined {
  return positions?.get(declaration) ?? declaration.position;
}

export function resolveSchema(
  document: SchemaDocument,
  deps: SchemaResolverDeps,
  options: ResolveSchemaOptions = {},
): Schema {
  const id = document.id;
  if (id === undefined) {
    throw new TsonSchemaValidationError(
      '!!id is required to resolve this schema, but is absent -- an id-less schema is a development ' +
        'artifact (§2.2.1, §10.1), and this schema has no name to be registered under',
    );
  }
  const { positions, receiver } = options;

  // Every entry's facts -- an import's as its schema recorded them, a local one's as resolution learns
  // them. Shared with the definition resolver, which records each declaration's here.
  const facts: EntryFactsTable = new Map<string, EntryFacts>();
  // Which schema declared each imported entry, and the readers its annotation values come through.
  const origins = new Map<string, string>();
  const annotationReaders = new Map<string, AnnotationValueReader>();
  const namespace = mergeImports(document, deps, facts, origins, annotationReaders);

  const reporter: DesugarFailureReporter | undefined =
    receiver === undefined
      ? undefined
      : {
          reportFailedDeclaration(declaration, error): void {
            receiver.report(
              schemaProblem(id, declaration.name, error, positionOf(declaration, positions)),
            );
          },
        };
  const desugared = desugar(document, {
    ...(reporter === undefined ? {} : { reporter }),
    ...(positions === undefined ? {} : { positions }),
  });
  const declarations = desugared.body.declarations;

  // Local-vs-import collisions, up front (local names are already unique -- SchemaMap dedupes them). A
  // schema map of one path is open: this document's contribution to an imported one is no collision, its
  // members colliding by path as any name does (§2.2.3).
  for (const [name, declaration] of declarations) {
    const nested = declaration.typeDef.kind === 'schemaMapDef';
    if (namespace.has(name) && !(nested && isNestedMap(namespace.get(name)))) {
      throw new TsonSchemaValidationError(
        `'${name}' collides with an entry of the same name brought in by !!import`,
      );
    }
    if (nested) {
      // This document's own map is resolved here, holding its own members; the imports' members stay
      // keyed under their paths.
      namespace.delete(name);
      origins.delete(name);
      facts.delete(name);
    }
  }

  // The names the imports bring in, which a parametric record's parameter may not be spelled like (§5.10).
  const imported = new Set(namespace.keys());

  /**
   * §5.10: within a parametric record a parameter's name is read before the schema's, so a parameter spelled like
   * an entry the schema's namespace holds makes that entry unreachable there, and is a resolver error at the
   * declaration rather than a silent capture. Judged by the name alone, before anything resolves.
   */
  const refuseShadowingParameters = (name: string, parameters: readonly string[]): void => {
    for (const parameter of parameters) {
      if (declarations.has(parameter) || imported.has(parameter)) {
        throw new TsonSchemaValidationError(
          `'${name}': parameter '${parameter}' shadows the entry '${parameter}' this schema's ` +
            "namespace holds -- inside a parametric record a parameter's name is read before the schema's, " +
            'so the entry would be unreachable there (§5.10). Rename the parameter',
        );
      }
    }
  };

  // Resolve on demand, following dependencies rather than source order (§3.4.1). `resolving` catches a cycle
  // through a wait; ordinary recursion through field references never enters it. `resolverBox` breaks the
  // construction cycle between this getter and the `DefinitionResolver` that needs it.
  const resolving = new Set<string>();
  const resolverBox: { current?: DefinitionResolver } = {};
  const maxWaitDepth = deps.maxWaitDepth ?? DEFAULT_MAX_WAIT_DEPTH;
  // For each entry being made ready, the declarations of this document it has waited on so far, and each ready
  // declaration's wait depth: none for an entry that waits on nothing of this document, one more than the
  // deepest entry it waits on otherwise. An import is ready before the resolution starts, so a wait ends at one.
  const waits = new Map<string, Set<string>>();
  const depths = new Map<string, number>();

  /** Records that the entry being made ready waits on `name`, one of this document's declarations. */
  const waited = (name: string): void => {
    const waiting = [...resolving].at(-1);
    if (waiting !== undefined && waiting !== name && declarations.has(name)) {
      waits.get(waiting)?.add(name);
    }
  };

  /** `name`'s wait depth, from the depths of the entries it waited on, refused past the limit. */
  const measure = (name: string): void => {
    let depth = 0;
    for (const on of waits.get(name) ?? []) {
      depth = Math.max(depth, (depths.get(on) ?? 0) + 1);
    }
    if (depth > maxWaitDepth) throw waitDepthLimitRefusal(maxWaitDepth, name);
    depths.set(name, depth);
  };

  const namespaceGetter: DefinitionGetter = (name) => {
    const already = namespace.get(name);
    if (already !== undefined) {
      waited(name);
      return already;
    }
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return undefined; // not a local entry -- an as-yet-unverified reference a later phase validates
    }
    if (resolving.has(name)) {
      // An entry reached again while it is being made ready waits on itself: the cycle, from its first wait.
      const chain = [...resolving];
      const cycle = [...chain.slice(chain.indexOf(name)), name];
      throw new TsonSchemaValidationError(
        `${cycle.map((entry) => `'${entry}'`).join(' waits on ')}: entries waiting on each other are never ` +
          "ready -- an entry's declaration is read against its head, the types of its annotations, its " +
          "refinement source and its '&' operands, and every type a part of it is read against, each of " +
          'which must be ready first ([TSON-SCHEMA] §3.4.1). A name at a type position orders nothing: ' +
          'type a field by the entry instead of reading a value against it',
      );
    }
    waited(name);
    if (resolving.size > maxWaitDepth) {
      // The entries being made ready are a chain of waits, and this one lengthens it past the limit: refused at
      // its head, which no order can make shallower, before the recursion runs any deeper.
      throw waitDepthLimitRefusal(maxWaitDepth, [...resolving][0] ?? name);
    }
    resolving.add(name);
    waits.set(name, new Set());
    try {
      const resolver = resolverBox.current;
      if (resolver === undefined) {
        throw new TsonInternalError(
          'namespaceGetter was invoked before its own DefinitionResolver was assigned',
        );
      }
      const position = positionOf(declaration, positions);
      refuseShadowingParameters(name, typeParamsOf(declaration.typeDef));
      const resolved = resolver.resolve(declaration, position);
      refuseHeadAbstraction(name, resolved);
      measure(name);
      namespace.set(name, resolved);
      return resolved;
    } catch (e: unknown) {
      if (!isReportable(e)) {
        throw e;
      }
      if (receiver === undefined) {
        throw e;
      }
      const position = positionOf(declaration, positions);
      receiver.report(schemaProblem(id, name, e, position));
      const placeholder = unresolvedPlaceholder(typeParamsOf(declaration.typeDef));
      if (position !== undefined) facts.set(name, { position });
      namespace.set(name, placeholder);
      depths.set(name, 0);
      return placeholder;
    } finally {
      resolving.delete(name);
      waits.delete(name);
    }
  };

  /**
   * Whether `head`, past its alias hops, is a parametric record, asked without making it ready: a parametric
   * record's application orders nothing (§3.4.1). A declaration of this document answers by its parameter list.
   */
  const opens = (head: string): boolean => {
    let current = head;
    for (let hop = 0; hop < 64; hop++) {
      const ready = namespace.get(current);
      if (ready !== undefined) {
        if (ready.kind !== 'alias') return isParametric(ready);
        current = ready.target.name;
        continue;
      }
      const declaration = declarations.get(current);
      if (declaration === undefined) return false;
      if (typeParamsOf(declaration.typeDef).length > 0) return true;
      const typeDef = declaration.typeDef;
      if (typeDef.kind === 'typeExprDef' && typeDef.ref.kind === 'nameRef') {
        current = typeDef.ref.name;
        continue;
      }
      return false;
    }
    return false;
  };

  // Where a construction head and an annotation type resolve: the whole namespace, each entry made ready on
  // demand, in dependency order. The kernel resolves through the same lookup: every head it applies is one of
  // its own entries, ready before the instance that applies it is read (§3.4).
  const heads: DefinitionGetter = namespaceGetter;
  const readers = deps.readers(heads);
  // An annotation's value is read through the compiled readers of the import that declared its type, else
  // through the resolution's own; a type this document declares itself has no compiled reader yet, so its
  // value is read with no type to read it against (`looseAnnotation.ts`).
  const annotationValueReader: AnnotationValueReader = (type, value) => {
    const own = annotationReaders.get(type);
    if (own !== undefined) return own(type, value);
    return readers.annotation !== undefined
      ? readers.annotation(type, value)
      : looseAnnotationValue(value);
  };

  resolverBox.current = createDefinitionResolver({
    definitionMetaReader: readers.meta,
    ...(readers.value === undefined ? {} : { definitionValueReader: readers.value }),
    metaDefinitions: heads,
    namespaceDefinitions: namespaceGetter,
    facts,
    annotationValueReader,
    opens,
    ...(deps.encodeSourceBody === undefined ? {} : { encodeSourceBody: deps.encodeSourceBody }),
  } satisfies DefinitionResolverDeps);
  const resolver: DefinitionResolver = resolverBox.current;

  for (const name of declarations.keys()) {
    namespaceGetter(name);
  }

  // §5.10's written bounds, each declaration once, now that every callee's bound is ready: that a bound names a
  // type, and that a parameter passed to a bounded parameter is written with a bound IS-A it.
  checkParameterBounds(namespace, new Set(declarations.keys()), heads, (name, error) => {
    if (receiver === undefined) throw error;
    const declaration = requiredGet(declarations, name, 'resolveSchema');
    receiver.report(schemaProblem(id, name, error, positionOf(declaration, positions)));
  });

  // Every chain closed transitively, now that every entry is ready, and a closed type's written parents dropped
  // (§4.1, §5.8).
  const resolvedLocals = new Map<string, Top>();
  for (const name of declarations.keys()) {
    resolvedLocals.set(name, requiredGet(namespace, name, 'resolveSchema'));
  }
  closeChains(namespace, resolvedLocals);

  // §6: a declaration's own name-annotations bind to the *name*, never hoisted onto the definition -- so they,
  // and the derived `@meta.completion`, land on the entry's key, not its value.
  const entries = new Map<string, Top>();
  const keyAnnotations = new Map<string, Annotations>();
  const localFacts = new Map<string, EntryFacts>();
  for (const [name, value] of resolvedLocals) {
    let nameAnnotations: Annotations;
    const declaration = requiredGet(declarations, name, 'resolveSchema');
    try {
      refuseDerivedAnnotation(name, declaration);
      nameAnnotations = resolver.annotationsFor(name, declaration.nameAnnotations);
    } catch (e: unknown) {
      if (!isReportable(e)) {
        throw e;
      }
      if (receiver === undefined) {
        throw e;
      }
      receiver.report(schemaProblem(id, name, e, positionOf(declaration, positions)));
      nameAnnotations = [];
    }
    entries.set(name, value);
    const recorded = facts.get(name);
    if (recorded !== undefined && Object.keys(recorded).length > 0) localFacts.set(name, recorded);
    const completion = resolver.completionOf(name);
    const annotated =
      completion === undefined ? nameAnnotations : withCompletion(nameAnnotations, completion);
    if (annotated.length > 0) keyAnnotations.set(name, annotated);
  }

  // A nested map's own entry is derived from the members' paths, so the two never disagree (§2.2.3).
  const synced = syncedEntries({ entries, keyAnnotations });
  return {
    id,
    imports: document.imports,
    entries: synced.entries,
    keyAnnotations: synced.keyAnnotations,
    facts: localFacts,
    bootstrap: false,
  };
}

/**
 * §5.10 admits no head abstraction: a parameter stands for a type, never for a parametric record, so `<T> { v: T<text>
 * }` is no form. Refused as the declaration resolves, over every application the parametric record writes, while the
 * author's own spelling is still what fails -- closing substitutes the parameter away.
 */
function refuseHeadAbstraction(name: string, resolved: Top): void {
  if (!isParametric(resolved)) return;
  const parameters = typeParameters(resolved);
  for (const application of applicationsOf(resolved)) {
    const head = application.head.name;
    if (!parameters.includes(head)) continue;
    throw new TsonSchemaValidationError(
      `'${name}': '${head}' is a type parameter applied to arguments -- a parameter stands for a type, never for ` +
        `a parametric record, and §5.10 admits no head abstraction, so '${head}<...>' is no form. Take the ` +
        'applied type as the parameter instead',
    );
  }
}

/**
 * Refuses an author writing a derived key annotation (§8.1, §8.2): `@meta.application` states the application an
 * entry closes and `@meta.completion` the incomplete entries a completion closed, and a declaration never writes
 * either, as it never writes `chain`.
 */
function refuseDerivedAnnotation(name: string, declaration: Declaration): void {
  for (const derived of [APPLICATION_ANNOTATION, COMPLETION_ANNOTATION]) {
    if (declaration.nameAnnotations.some((annotation) => annotation.name === derived)) {
      throw new TsonSchemaValidationError(
        `'${name}' writes '@${derived}' on its key, which the resolver attaches and no declaration writes ` +
          (derived === APPLICATION_ANNOTATION
            ? "(§8.2) -- declare the entry as the application itself ('name => head<args>')"
            : "(§8.1) -- declare the entry as the completion itself ('name => !incomplete { ... }')"),
      );
    }
  }
}

// ── Applied parents (§5.8) ───────────────────────────────────────────────────────────────────

/**
 * Every local chain closed transitively -- an entry IS-A every entry its supertypes are IS-A -- and a closed type's
 * written parents dropped: a closed type's parents are not part of it (§4.1). A parametric record keeps its written
 * parents, which may name its own parameters.
 */
function closeChains(namespace: Map<string, Top>, locals: Map<string, Top>): void {
  const bound = locals.size + 1;
  for (let round = 0; round <= bound; round++) {
    let changed = false;
    for (const [name, definition] of locals) {
      if (!isType(definition)) continue;
      const chain = chainOf(definition);
      const names = new Set(chain.supertypes);
      for (const member of chain.supertypes) {
        const ancestor = namespace.get(member);
        for (const further of ancestor === undefined ? [] : chainOf(ancestor).supertypes) {
          names.add(further);
        }
      }
      const parents = isParametric(definition) ? chain.parents : [];
      if (names.size === chain.supertypes.length && parents.length === chain.parents.length)
        continue;
      const closed = withChain(definition, typeChain([...names], parents, chain.subtypes));
      locals.set(name, closed);
      namespace.set(name, closed);
      changed = true;
    }
    if (!changed) return;
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

/**
 * The exception types a failed declaration is ever reported under. Every case is a positive
 * classification ({@link schemaProblemCode}); anything else -- {@link TsonInternalError} above
 * all -- is not reportable and propagates as itself, a fault in this library rather than a
 * verdict on the document.
 */
type ReportableSchemaError =
  | TsonSchemaValidationError
  | TsonNotImplementedError
  | TsonBindMismatchError
  | TsonSchemaFetchError
  | TsonNameHygieneRefusedError;

function isReportable(e: unknown): e is ReportableSchemaError {
  return (
    e instanceof TsonSchemaValidationError ||
    e instanceof TsonNotImplementedError ||
    e instanceof TsonBindMismatchError ||
    e instanceof TsonSchemaFetchError ||
    e instanceof TsonNameHygieneRefusedError
  );
}

/**
 * Stage 1 of {@link resolveSchema} -- every `!!import`'s whole namespace, in declaration order, merged as-is (never
 * re-resolved against the importer). A route repeating one already-merged URI is skipped, and a name two
 * *different* origins both declare is a {@link TsonSchemaValidationError} (§2.2.3).
 */
function mergeImports(
  document: SchemaDocument,
  deps: SchemaResolverDeps,
  facts: EntryFactsTable,
  origins: Map<string, string>,
  annotationReaders: Map<string, AnnotationValueReader>,
): Map<string, Top> {
  const merged = new Map<string, Top>();
  const alreadyImported = new Set<string>();
  for (const importUri of document.imports) {
    if (alreadyImported.has(importUri)) {
      continue;
    }
    alreadyImported.add(importUri);
    if (deps.resolveImport === undefined) {
      throw new TsonNotImplementedError(
        `'!!import:"${importUri}"' needs a schema loader to resolve, and this resolver was built without one`,
      );
    }
    const imported = deps.resolveImport(importUri);
    for (const [name, definition] of imported.entries) {
      const origin = imported.originOf(name);
      const incumbent = origins.get(name);
      // A schema map of one path declared by several documents is one map, the union of their members,
      // each merged under its path; the map's entry is derived from them (§2.2.3).
      if (incumbent !== undefined && isNestedMap(merged.get(name)) && isNestedMap(definition)) {
        continue;
      }
      if (incumbent !== undefined) {
        if (incumbent !== origin) {
          throw new TsonSchemaValidationError(
            `'${name}' is declared by two different schemas reached through !!import ('${incumbent}' and ` +
              `'${origin}') -- distinct types cannot share one name in the one namespace; import one of them, ` +
              `or a version of each that agrees on where '${name}' is declared`,
          );
        }
        continue;
      }
      merged.set(name, definition);
      origins.set(name, origin);
      if (imported.annotationReader !== undefined) {
        annotationReaders.set(name, imported.annotationReader);
      }
      const recorded = imported.facts?.get(name);
      if (recorded !== undefined) facts.set(name, recorded);
    }
  }
  // Each nested map holds the union of the members its closure declares.
  return new Map(syncedEntries({ entries: merged, keyAnnotations: new Map() }).entries);
}

/**
 * The placeholder a declaration that failed to resolve leaves behind, so declarations that reference it still
 * resolve instead of collapsing into a cascade of consequences of one original error: an empty record. It keeps
 * the failed declaration's own type parameters, so a downstream `bl<text>` is not told `bl` takes none.
 */
function unresolvedPlaceholder(parameters: readonly string[]): Top {
  return {
    kind: 'record',
    fields: NO_FIELDS,
    groups: [],
    extension: 'OPEN',
    ...(parameters.length === 0
      ? {}
      : { parameters: parameters.map((parameter) => ({ name: parameter })) }),
  };
}

/**
 * One declaration's failure as a {@link Diagnostic}, classified positively -- `BIND_MISMATCH` for
 * a {@link TsonBindMismatchError} (the reading application's own binding disagrees with the
 * schema, not an author mistake; subsumes {@link TsonMissingBindingError}), `NOT_IMPLEMENTED` for
 * a {@link TsonNotImplementedError} (a library gap), one of the five `SCHEMA_*` fetch codes (via
 * {@link diagnosticCodeForFetch}) for a {@link TsonSchemaFetchError} (no configured source would
 * supply a schema this declaration's own constructor is bound against -- not obtained, so never
 * judged), and `SCHEMA_ERROR` for a
 * {@link TsonSchemaValidationError} (the author's mistake), matching the classification
 * `definitionResolver.ts`'s own errors already carry. `schemaPointer` names the declaration by an
 * RFC 6901-shaped `/name` rather than embedding it in the message, since the message is already
 * this error's own -- most of `definitionResolver.ts`'s own throw sites already open with
 * `'name': ...`.
 */
function schemaProblem(
  schemaId: string,
  declarationName: string,
  error: ReportableSchemaError,
  position: Position | undefined,
): Diagnostic {
  return {
    code: schemaProblemCode(error),
    message: error.message,
    schemaId,
    schemaPointer: `/${declarationName}`,
    ...(position === undefined ? {} : { schemaPosition: position }),
  };
}

function schemaProblemCode(error: ReportableSchemaError): Diagnostic['code'] {
  if (error instanceof TsonNameHygieneRefusedError)
    return diagnosticCodeForMechanism(error.mechanism);
  if (error instanceof TsonBindMismatchError) return 'BIND_MISMATCH';
  if (error instanceof TsonNotImplementedError) return 'NOT_IMPLEMENTED';
  if (error instanceof TsonSchemaFetchError) return diagnosticCodeForFetch(error.reason);
  return 'SCHEMA_ERROR';
}

/** The {@link requiredGet} twin `definitionResolver.ts` also carries -- a runtime backstop instead of a non-null assertion (`eslint.config.js` forbids `!`), safe by construction at every call site here. */
function requiredGet<K, V>(map: ReadonlyMap<K, V>, key: K, context: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new TsonInternalError(`${context}: missing expected key '${String(key)}'`);
  }
  return value;
}
