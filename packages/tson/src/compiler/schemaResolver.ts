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
  TsonReadError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import { diagnosticCodeForFetch, diagnosticCodeForMechanism } from '../core/diagnostic.js';
import type { Diagnostic, DiagnosticsReceiver } from '../core/diagnostic.js';
import type { Position } from '../core/position.js';
import type { Declaration, SchemaDocument } from '../ast/schema/document.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { FieldNameType } from '../link/fieldNames.js';
import type { ExternTarget } from '../link/externTarget.js';
import { NO_FIELDS } from '../schema/meta/bodies.js';
import type {
  Annotations,
  ApplyBody,
  EntryFacts,
  Restatement,
  Top,
  TypeExpr,
  TypeRef,
} from '../schema/meta/typedef.js';
import {
  APPLICATION_ANNOTATION,
  COMPLETION_ANNOTATION,
  applicationOf,
  chainOf,
  isParametric,
  parentsOf,
  typeParameters,
  isType,
  typeChain,
  withApplication,
  withChain,
  withCompletion,
} from '../schema/meta/typedef.js';
import { isNestedMap, syncedEntries } from '../schema/meta/schemaPaths.js';
import { DEFAULT_MAX_WAIT_DEPTH } from '../core/limits.js';
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
  MemberJoiners,
  SourceBodyEncoder,
} from './resolverTypes.js';
import { createWaitOrder } from './waitOrder.js';
import * as ParameterTypes from './parameterTypes.js';
import * as ParametricRegularity from './parametricRegularity.js';
import * as Ancestry from './ancestry.js';
import * as CanonicalApplication from './canonicalApplication.js';
import * as Substitution from './substitution.js';
import { createHeldRecursion } from './heldRecursion.js';
import { createParametricMaterialiser } from './parametricMaterialiser.js';
import { createRestatements } from './restatements.js';
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
  /**
   * The fields each local entry restates over a source its closed chain does not reach (§5.8, §5.9), for the linker
   * to judge -- present only for an entry with any. Absent means none.
   */
  readonly restatements?: ReadonlyMap<string, readonly Restatement[]>;
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
  /** Each contributed extern attached to the foreign entry it lands on (§5.13) -- `LinkedSchema.externs`. Absent means none. */
  readonly externs?: ReadonlyMap<string, ExternTarget>;
  /** Each contributed entry's restatements off its chain, settled when its schema resolved. Absent means none. */
  readonly restatements?: ReadonlyMap<string, readonly Restatement[]>;
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

/** A checkpoint of a resolution (§3.4.1): the imports and the entries ready so far, with their facts and origins. */
export interface Checkpoint {
  readonly id: string;
  readonly imports: readonly string[];
  readonly entries: ReadonlyMap<string, Top>;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  readonly origins: ReadonlyMap<string, string>;
}

/**
 * Every dependency {@link resolveSchema} needs beyond the document in hand. `readers` is a factory because
 * the readers consult the namespace being built -- a constructor's own declaration supplies its fields'
 * defaults -- so they are made over the lookup this resolution runs.
 */
export interface SchemaResolverDeps {
  readonly readers: (lookup: DefinitionGetter, joiners?: MemberJoiners) => ResolverReaders;
  /**
   * The annotation reader over a checkpoint of the document being resolved: its imports and the entries ready so
   * far, `id` its own identity. What an annotation's value of an imported type is read through where it reaches
   * past the declaring import's closure -- a member of an imported family this document declares (§3.4.1, §6).
   * Omitted, such a value is read through the declaring import's compile alone.
   */
  readonly checkpointAnnotations?: (checkpoint: Checkpoint) => AnnotationValueReader;
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
  // Which application each entry is the instantiation of (§8.2): an import's as its key states it, a local one's as
  // materialisation closes it. What the applied-parent fold keys on.
  const applications = new Map<string, ApplyBody>();
  const importedRestatements = new Map<string, readonly Restatement[]>();
  const namespace = mergeImports(
    document,
    deps,
    facts,
    origins,
    annotationReaders,
    applications,
    importedRestatements,
  );

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

  // Resolve on demand, following dependencies rather than source order (§3.4.1), through the wait order
  // (`waitOrder.ts`). `resolverBox` breaks the construction cycle between the order and the `DefinitionResolver`
  // that looks up through it.
  const resolverBox: { current?: DefinitionResolver } = {};
  const order = createWaitOrder(
    namespace,
    declarations,
    deps.maxWaitDepth ?? DEFAULT_MAX_WAIT_DEPTH,
  );
  // The declarations whose resolution failed and was reported: each has its verdict, and a later check is not a second.
  const failed = new Set<string>();
  order.readyWith({
    resolve(name, declaration): Top {
      const resolver = resolverBox.current;
      if (resolver === undefined) {
        throw new TsonInternalError(
          'the wait order was asked for an entry before its own DefinitionResolver was assigned',
        );
      }
      refuseShadowingParameters(name, typeParamsOf(declaration.typeDef));
      const resolved = resolver.resolve(declaration, positionOf(declaration, positions));
      refuseHeadAbstraction(name, resolved);
      return resolved;
    },
    failed(name, declaration, error): Top {
      if (!isReportable(error) || receiver === undefined) throw error;
      const position = positionOf(declaration, positions);
      failed.add(name);
      receiver.report(schemaProblem(id, name, error, position));
      if (position !== undefined) facts.set(name, { position });
      return unresolvedPlaceholder(typeParamsOf(declaration.typeDef));
    },
  });
  const namespaceGetter: DefinitionGetter = order.definition;
  const opens = order.opens;

  // Where a construction head and an annotation type resolve: the whole namespace, each entry made ready on
  // demand, in dependency order. The kernel resolves through the same lookup: every head it applies is one of
  // its own entries, ready before the instance that applies it is read (§3.4).
  const heads: DefinitionGetter = namespaceGetter;
  // A value placed by its pins waits on each declaration of this document that may be its member (§3.4.1).
  const readers = deps.readers(heads, order.joiners);
  // An annotation's value is read through the compiled readers of the import that declared its type, else
  // through the resolution's own; a type this document declares itself has no compiled reader yet, so its
  // value is read with no type to read it against (`looseAnnotation.ts`).
  const annotationValueReader: AnnotationValueReader = (type, value) => {
    const own = annotationReaders.get(type);
    if (own !== undefined) return readImported(own, type, value);
    return readers.annotation !== undefined
      ? readers.annotation(type, value)
      : looseAnnotationValue(value);
  };

  /**
   * An annotation's value of an imported type, read through the declaring import's compile, or -- where it reaches
   * past that closure -- at a checkpoint of this document (§6: a value is read in the namespace of the schema
   * writing it). The value is read first in this document's namespace, which makes ready what it reaches, a member
   * its pins select among them (§3.4.1); a refusal there is the import's verdict, kept as it gave it.
   */
  const readImported = (
    own: AnnotationValueReader,
    type: string,
    value: Parameters<AnnotationValueReader>[1],
  ): unknown => {
    try {
      return own(type, value);
    } catch (refusal) {
      if (!(refusal instanceof TsonReadError) || deps.checkpointAnnotations === undefined)
        throw refusal;
      if (readers.value === undefined) throw refusal;
      try {
        readers.value(type, value);
      } catch {
        throw refusal;
      }
      const localOrigins = new Map(origins);
      for (const name of namespace.keys()) if (!localOrigins.has(name)) localOrigins.set(name, id);
      try {
        return deps.checkpointAnnotations({
          id,
          imports: document.imports,
          entries: new Map(namespace),
          facts,
          origins: localOrigins,
        })(type, value);
      } catch (error) {
        if (error instanceof TsonReadError) throw refusal;
        throw error;
      }
    }
  };

  // One materialiser for the whole schema, created before the driving loop because resolution itself asks it for
  // applications on demand: a declaration naming an application closes into its own name as it resolves, and an
  // absorbed operand's arguments are checked against their bounds. Sharing the instance is what lets the batch pass
  // below see what those closings recorded.
  const heldRecursion = createHeldRecursion(namespaceGetter, (name) => declarations.has(name));
  const restatements = createRestatements(importedRestatements);
  const materialiser = createParametricMaterialiser({
    namespace: namespaceGetter,
    facts,
    applications,
    heldRecursion,
    resolving: () => order.current(),
    restatements,
    placeholder: unresolvedPlaceholder,
  });

  resolverBox.current = createDefinitionResolver({
    definitionMetaReader: readers.meta,
    ...(readers.value === undefined ? {} : { definitionValueReader: readers.value }),
    metaDefinitions: heads,
    namespaceDefinitions: namespaceGetter,
    facts,
    annotationValueReader,
    opens,
    applicationCloser: materialiser,
    restatements,
    ...(deps.encodeSourceBody === undefined ? {} : { encodeSourceBody: deps.encodeSourceBody }),
  } satisfies DefinitionResolverDeps);
  const resolver: DefinitionResolver = resolverBox.current;

  for (const name of declarations.keys()) {
    namespaceGetter(name);
  }

  /** Reports `error` against the declaration `name`, or throws it where nothing collects. */
  const report = (name: string, error: ReportableSchemaError): void => {
    if (receiver === undefined) throw error;
    const declaration = requiredGet(declarations, name, 'resolveSchema');
    receiver.report(schemaProblem(id, name, error, positionOf(declaration, positions)));
  };

  // Every entry is ready: the judgements that walk a name to what it names run now (§3.4.1's sixth rule).
  resolver.judgeDeferred((name, error) => {
    if (receiver === undefined) throw error;
    if (!failed.has(name)) report(name, error);
  });

  // §5.10 materialisation, after every declaration has resolved and before anything reads the result: closing an
  // application needs the parametric record's own resolved form, which only exists once the driving loop has run.
  // It adds no entry: an application closes in place, or into the declaration naming it.
  const resolvedLocals = new Map<string, Top>();
  for (const name of declarations.keys()) {
    resolvedLocals.set(name, requiredGet(namespace, name, 'resolveSchema'));
  }

  // §5.10.1's regularity boundary, before anything closes: a recursive application passes each parameter through
  // unchanged, judged at the declaration, so a parametric record refused for it is refused even if nobody applies it.
  const irregular = ParametricRegularity.check(
    resolvedLocals,
    receiver === undefined ? undefined : report,
  );
  condemn(irregular, resolvedLocals, namespace);
  // §5.10's written bounds, each declaration once, now that every callee's bound is ready: that a bound names a
  // type, and that a parameter passed to a bounded parameter is written with a bound IS-A it.
  const refusedParameters = ParameterTypes.check(
    namespace,
    new Set(declarations.keys()),
    heads,
    (name, error) => {
      report(name, new TsonSchemaValidationError(`'${name}': ${error.message}`, { cause: error }));
    },
  );
  condemn(refusedParameters, resolvedLocals, namespace);
  // §5.10.1's held recursion, over the parametric records as the two checks above left them, each declaration once.
  heldRecursion.forget();
  const heldRecursive = new Set<string>();
  for (const name of declarations.keys()) {
    const error = heldRecursion.refusal(name);
    if (error === undefined) continue;
    report(name, error);
    heldRecursive.add(name);
  }
  condemn(heldRecursive, resolvedLocals, namespace);
  // The bound checks of the applications closed while declarations were being made ready, which an argument could
  // not order (§3.4.1), run now that every argument is ready -- before anything else closes.
  materialiser.checkDeferred((name, error) => {
    if (receiver === undefined) throw error;
    if (!failed.has(name)) report(name, error);
  });

  materialiser.materialise(resolvedLocals, receiver === undefined ? undefined : report);
  republish(namespace, resolvedLocals);
  appliedParentEdges(namespace, resolvedLocals, applications);
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
    // §8.2's derived key annotation: every entry that closes an application of a parametric record carries
    // `@meta.application` on its key, stated as written, its arguments past their alias hops.
    const application = materialiser.writtenApplication(name);
    const applied =
      application === undefined ? nameAnnotations : withApplication(nameAnnotations, application);
    // §8.1's other derived key annotation: a declared completion states the incomplete entries it closed.
    const completion = resolver.completionOf(name);
    const annotated = completion === undefined ? applied : withCompletion(applied, completion);
    if (annotated.length > 0) keyAnnotations.set(name, annotated);
  }
  // A declaration that failed has its verdict, and its restatements were made of what it could not finish.
  const restated = new Map<string, readonly Restatement[]>();
  for (const [name, found] of restatements.settled((type) => materialiser.closedInPlace(type))) {
    if (declarations.has(name) && !failed.has(name) && found.length > 0) restated.set(name, found);
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
    ...(restated.size === 0 ? {} : { restatements: restated }),
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

// ── Condemned parametric records, applied parents (§5.8) ─────────────────────────────────────

/**
 * Replaces each named entry with the placeholder a declaration that failed to resolve leaves, keeping its type
 * parameters -- a parametric record whose verdict is already in. Both maps, because the two halves are read by
 * different phases: materialisation walks the locals, while an application's head is looked up through the namespace.
 */
function condemn(
  names: ReadonlySet<string>,
  resolvedLocals: Map<string, Top>,
  namespace: Map<string, Top>,
): void {
  for (const name of names) {
    const placeholder = unresolvedPlaceholder(typeParameters(resolvedLocals.get(name)));
    resolvedLocals.set(name, placeholder);
    namespace.set(name, placeholder);
  }
}

/** Puts the local entries back into the namespace, which every later phase reads through. */
function republish(namespace: Map<string, Top>, resolvedLocals: ReadonlyMap<string, Top>): void {
  for (const [name, value] of resolvedLocals) namespace.set(name, value);
}

/**
 * §5.8's IS-A edge for a parent written as an application, derived once every declaration has resolved, and the
 * chains made complete through it. The entry an application denotes is whichever declaration names the same
 * application, and asking that during materialisation would make the answer depend on declaration order, so the edge
 * waits until every parent is a type. **Nothing is created here**: the pass derives an index over entries that
 * already exist, keyed on §8.2's canonical application, and an application no declaration names contributes no edge.
 * **Complete means transitively closed**: an entry IS-A every entry its supertypes are IS-A, to a fixed point.
 */
function appliedParentEdges(
  namespace: Map<string, Top>,
  resolvedLocals: Map<string, Top>,
  applications: ReadonlyMap<string, ApplyBody>,
): void {
  const byApplication = new Map<string, string>();
  for (const name of namespace.keys()) {
    const application = applications.get(name);
    if (application === undefined) continue;
    const key = CanonicalApplication.key(
      CanonicalApplication.of(application.head.name, application.arguments),
    );
    if (!byApplication.has(key)) byApplication.set(key, name);
  }
  for (let round = 0; round <= namespace.size; round++) {
    const changed = fold(resolvedLocals, byApplication, namespace);
    republish(namespace, resolvedLocals);
    if (!changed) return;
  }
}

/** One round of {@link appliedParentEdges} over one map, to a fixed point within it -- `true` when any chain grew. */
function fold(
  entries: Map<string, Top>,
  byApplication: ReadonlyMap<string, string>,
  namespace: Map<string, Top>,
): boolean {
  let changedAny = false;
  for (let pass = 0; pass <= entries.size; pass++) {
    let changed = false;
    for (const [name, value] of entries) {
      const folded = completed(value, byApplication, namespace);
      if (folded !== value) {
        entries.set(name, folded);
        namespace.set(name, folded);
        changed = true;
      }
    }
    if (!changed) return changedAny;
    changedAny = true;
  }
  return changedAny;
}

/**
 * One chain made complete: a type's every applied parent's owning declaration folded in, and every member's own
 * supertypes. An applied parent reaches what its head's applied parents reach, substituted (§5.8: an application
 * takes its head's written parents' edges), to any depth; the application nobody declares adds no edge of its own.
 * `definition` itself where nothing grew.
 */
function completed(
  definition: Top,
  byApplication: ReadonlyMap<string, string>,
  namespace: ReadonlyMap<string, Top>,
): Top {
  if (!isType(definition)) return definition;
  const lookup = (name: string): Top | undefined => namespace.get(name);
  const chain = new Set(chainOf(definition).supertypes);
  const parents: TypeExpr[] = [...parentsOf(definition)];
  const seen = new Set<string>();
  for (let parent = parents.shift(); parent !== undefined; parent = parents.shift()) {
    if (parent.kind !== 'inline' || parent.of.kind !== 'apply') continue;
    const application = parent.of;
    // A parent written through an alias of a parametric record is that parametric record's application (§8.3).
    const head = Ancestry.parametricHead(application.head.name, lookup);
    const key = CanonicalApplication.key(CanonicalApplication.of(head, application.arguments));
    if (seen.has(key)) continue;
    seen.add(key);
    const owner = byApplication.get(key);
    if (owner !== undefined) chain.add(owner);
    const record = namespace.get(head);
    const parameters = typeParameters(record);
    if (record?.kind === 'record' && parameters.length === application.arguments.length) {
      const bindings = new Map<string, TypeRef>();
      parameters.forEach((parameter, index) => {
        const argument = application.arguments[index];
        if (argument !== undefined) bindings.set(parameter, argument);
      });
      parents.push(...Substitution.parents(record, bindings));
    }
  }
  for (const member of [...chain]) {
    for (const further of Ancestry.closedNames(namespace.get(member))) chain.add(further);
  }
  const current = chainOf(definition);
  return chain.size === new Set(current.supertypes).size
    ? definition
    : withChain(definition, typeChain([...chain], current.parents, current.subtypes));
}

/**
 * Every closed chain with the applications the fold left standing dropped: an application no declaration names
 * denotes an entry nothing can be declared as, and a closed type's parents are not part of it (§4.1). A parametric
 * record keeps its written parents, which may name its own parameters.
 */
function closeChains(namespace: Map<string, Top>, locals: Map<string, Top>): void {
  for (const [name, definition] of locals) {
    if (!isType(definition) || isParametric(definition) || parentsOf(definition).length === 0)
      continue;
    const chain = chainOf(definition);
    locals.set(name, withChain(definition, typeChain(chain.supertypes, [], chain.subtypes)));
  }
  republish(namespace, locals);
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
  applications: Map<string, ApplyBody>,
  restatements: Map<string, readonly Restatement[]>,
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
      const application = applicationOf(imported.keyAnnotations?.get(name));
      if (application !== undefined) applications.set(name, application);
      const restated = imported.restatements?.get(name);
      if (restated !== undefined) restatements.set(name, restated);
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
export function unresolvedPlaceholder(parameters: readonly string[]): Top {
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
