/**
 * Resolves a whole {@link SchemaDocument} into a {@link Schema}: `!!id`/`!!import` handling, merging every
 * import's entries into the schema's one namespace before any local declaration resolves (Part 2 §2.2.3,
 * §3.3), driving `definitionResolver.ts` over every declaration on demand (dependency order, not source
 * order, so a declaration may compose or refine one declared later in the same schema), and the
 * `@meta.synthetic` and `@meta.application` key markers (§8.2). A type position naming an `alias` entry is
 * left exactly as the author wrote it (§8.3) -- nothing here walks or rewrites a use site past one; a
 * consumer that needs the type at the end of a chain does its own ephemeral walk
 * (`link/aliasChain.ts`'s shared function).
 *
 * **One namespace per schema (§3.3).** Every name -- a construction head, a refinement source, a type
 * position, an annotation -- resolves in the document's own entries and its import closure's, from the
 * root; there is no governing meta. A schema map nested as an entry (`geo => !schema { ... }`) declares its
 * members under their paths, and a map of one path declared by several documents of one closure is the
 * union of their members.
 *
 * **This module does not fetch, link, or register anything.** It takes each import's already-resolved
 * entries ({@link SchemaResolverDeps.resolveImport}) and the readers a body is read through
 * ({@link SchemaResolverDeps.readers}) as caller-supplied dependencies, the same dependency-injection shape
 * `definitionResolver.ts` uses for its own. A caller with no loader simply omits `resolveImport`; this
 * module then reports {@link TsonNotImplementedError} the moment a document actually writes `!!import`.
 *
 * **The kernel resolves through the same lookup (§3.4).** Every construction head in `meta.tn` names an
 * entry `meta.tn` declares, and a head is made ready, on demand, before an instance that applies it is
 * read, so the kernel needs no imported vocabulary and no special case beyond being handed no import.
 *
 * **§5.10 materialisation runs exactly where the reference runs it.** One `templates.ts`
 * `TemplateMaterialiser` is constructed per call, before the driving loop -- its `closeApplication` is
 * wired into `definitionResolver.ts` as its own on-demand `ApplicationCloser`, and its batch `materialise`
 * pass runs once every local declaration has resolved. Sharing one instance for both is what makes an
 * on-demand closing and a later batch closing of the same application land on one entry.
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
import type { DataValue } from '../ast/value.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { FieldNameType } from '../link/fieldNames.js';
import type { TemplateParam } from '../schema/meta/bodies.js';
import { NO_FIELDS, TYPE_KIND } from '../schema/meta/bodies.js';
import type { Annotations, EntryFacts, Top, TypeRef } from '../schema/meta/typedef.js';
import {
  APPLICATION_ANNOTATION,
  SYNTHETIC_ANNOTATION,
  applicationOf,
  chainOf,
  isConstructor,
  isOpen,
  isType,
  supertypesOf,
  typeChain,
  typeParameters,
  withApplication,
  withChain,
} from '../schema/meta/typedef.js';
import { areOneSynthetic, unifiedFacts } from '../link/importedSynthetics.js';
import { isNestedMap, syncedEntries } from '../schema/meta/schemaPaths.js';
import { DEFAULT_MAX_WAIT_DEPTH, waitDepthLimitRefusal } from '../core/limits.js';
import { terminal } from '../link/aliasChain.js';
import { canonicalApplication } from './derivedName.js';
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
import { desugar, lifted, typeParamsOf, type DesugarFailureReporter } from './desugar.js';
import { heldOf, withParametersOf } from './heldBody.js';
import { looseAnnotationValue } from './looseAnnotation.js';
import { createTemplateMaterialiser, type MaterialisationFailureReporter } from './templates.js';
import { inferAll, kinds as parameterKindsOf } from './parameterTypes.js';
import { renames as syntheticRenames, rewrite as rewriteSynthetics } from './syntheticMerge.js';

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
 * `@meta.synthetic` and `@meta.application` (§8.2).
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
  /** `entries.get(name)`'s own key-position annotations (§6, §8.2) -- present only for a name that carries at least one. */
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

/**
 * Resolves every declaration in `document`'s body, on demand and dependency-following rather than strict
 * source order (§3.4.1), and carries `document`'s own header directives (`!!id`?/`!!import*`) into the
 * result's `id`/`imports`.
 *
 * **`document.id` must be present** (§2.2.1: "publishing a schema... REQUIRES `!!id`"), thrown as
 * {@link TsonSchemaValidationError} before any declaration is resolved.
 *
 * **`!!import` is merged into the one namespace before any local declaration resolves.** Collision handling
 * mirrors what the reference implementation's linker does one phase later (§2.2.3): a name declared by more
 * than one import, or by an import *and* a local declaration, is a {@link TsonSchemaValidationError}, but for
 * a schema map of one path, which is open: this document's contribution to an imported one is no collision,
 * its members colliding by path as any name does. **Merged entries keep their home namespace** -- an
 * imported entry is copied in exactly as its own schema resolved it, never re-resolved or re-materialised
 * against the importer.
 *
 * §5.10 materialisation runs once every local declaration has resolved. Nothing runs after it to rewrite a
 * use site (§8.3): a reference is a hop, not a rewrite, so what materialisation and the synthetic merge
 * leave in the namespace is the resolved schema's own final shape.
 *
 * **§6: an annotation written before a declared name binds to the name, not the definition.** A resolved
 * schema is `{type_name => declared}`, so the name is the *key* of `entries` -- which is where
 * {@link Schema.keyAnnotations} keeps them, alongside the derived `@meta.synthetic` and `@meta.application`
 * markers (§8.2).
 */
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
  // The application each imported entry closes, from its `@meta.application` -- what the applied-parent
  // fold keys an imported instantiation on, as it keys a local one (§8.2).
  const importedApplications = new Map<string, TypeRef>();
  // Which schema declared each imported entry, and the readers its annotation values come through.
  const origins = new Map<string, string>();
  const annotationReaders = new Map<string, AnnotationValueReader>();
  const namespace = mergeImports(
    document,
    deps,
    facts,
    importedApplications,
    origins,
    annotationReaders,
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
  const reused = new Map<string, Declaration>();
  const desugared = desugar(document, new Set(namespace.keys()), {
    ...(reporter === undefined ? {} : { reporter }),
    ...(positions === undefined ? {} : { positions }),
    reused,
  });
  const declarations = desugared.body.declarations;
  // Mutable, not the plain `ReadonlySet` `lifted` returns: the synthetic merge below removes an
  // eagerly lifted name and adds the closed name it merged onto, so this set stays the current
  // truth for the rest of this function (in particular the `@synthetic` key-marker loop near the
  // end, which asks it per entry).
  const generated = new Set(lifted(document, desugared));

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

  // The names the imports bring in, which a template's parameter may not be spelled like (§5.10).
  const imported = new Set(namespace.keys());

  /**
   * §5.10: within a template's body a parameter's name is read before the schema's, so a parameter spelled
   * like an entry the schema's namespace holds -- a type or a value entry, its own or an import's -- makes
   * that entry unreachable there, and is a resolver error at the declaration rather than a silent capture.
   * Judged by the name alone, before anything resolves, so no entry is waited on. A parameter list the
   * desugarer wrote for a lifted form is its own renaming (`p0`, `p1`), and is not asked.
   */
  const refuseShadowingParameters = (name: string, parameters: readonly string[]): void => {
    for (const parameter of parameters) {
      if (declarations.has(parameter) || imported.has(parameter)) {
        throw new TsonSchemaValidationError(
          `'${name}': parameter '${parameter}' shadows the entry '${parameter}' this schema's ` +
            `namespace holds -- inside a template a parameter's name is read before the schema's, so ` +
            `the entry would be unreachable there (§5.10). Rename the parameter`,
        );
      }
    }
  };

  // Resolve on demand, following dependencies rather than source order (§3.4.1). `resolving`
  // catches a cycle through a composition/refinement/atom-refinement edge; ordinary recursion
  // through field references never enters it. `resolverBox` breaks the construction cycle
  // between this getter and the `DefinitionResolver` that needs it as its own `namespaceDefinitions`.
  const resolving = new Set<string>();
  const failed = new Set<string>();
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
      if (!generated.has(name)) refuseShadowingParameters(name, typeParamsOf(declaration.typeDef));
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
      failed.add(name);
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

  // One materialiser for the whole schema, built before the driving loop because resolution
  // itself closes applications on demand (a supertype or refinement source absorbing a *closed*
  // application's fields cannot wait for the batch pass below). `generated` is `templates.ts`'s
  // own `generatedNames`: the desugar lift's synthetic names, so a generated head closing its own
  // intermediate form is told apart from an authored one.
  // Where a construction head and an annotation type resolve: the whole namespace, each entry made ready
  // on demand, in dependency order. The kernel resolves through the same lookup: every head it applies is
  // one of its own entries, ready before the instance that applies it is read (§3.4).
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
  // A held body closes to whatever its head builds: a type where the head is a constructor, and a value entry
  // where it is an ordinary type (`fetch => <T> !operations { ... }`, then `get_order => fetch<order>`). An
  // alias of a constructor is applied as its target is (§3.3.1).
  const closingReader: DefinitionMetaReader = (written, value) => {
    const type = terminal(written, heads);
    const head = heads(type);
    if (head === undefined || isConstructor(head, type) || readers.value === undefined) {
      return readers.meta(written, value);
    }
    return {
      kind: 'value_entry',
      type,
      value: readers.value(type, retagged(value, written, type)),
    };
  };
  const materialiser = createTemplateMaterialiser({
    namespaceDefinitions: namespaceGetter,
    publish: (name, definition) => namespace.set(name, definition),
    definitionMetaReader: closingReader,
    generatedNames: generated,
    metaTypes: heads,
    resolving: () => [...resolving].at(-1),
    heads: (name) => facts.get(name)?.head,
  });

  resolverBox.current = createDefinitionResolver({
    definitionMetaReader: readers.meta,
    ...(readers.value === undefined ? {} : { definitionValueReader: readers.value }),
    metaDefinitions: heads,
    namespaceDefinitions: namespaceGetter,
    facts,
    applicationCloser: (application) => materialiser.closeApplication(application),
    applicationChecker: (application) => materialiser.checkApplication(application),
    declaredApplicationCloser: (declaredName, application) =>
      materialiser.closeApplicationAs(declaredName, application),
    annotationValueReader,
    ...(deps.encodeSourceBody === undefined ? {} : { encodeSourceBody: deps.encodeSourceBody }),
  } satisfies DefinitionResolverDeps);
  const resolver: DefinitionResolver = resolverBox.current;

  for (const name of declarations.keys()) {
    namespaceGetter(name);
  }

  // §5.10 materialisation, after every declaration has resolved: a template application reaches
  // here as a type-ref carrying arguments, and closing it needs the template's own *resolved* open
  // form, which only exists once the loop above has run.
  const beforeMaterialise = new Map<string, Top>();
  for (const name of declarations.keys()) {
    beforeMaterialise.set(name, requiredGet(namespace, name, 'resolveSchema'));
  }

  // §5.10's parameters, typed by use, before anything closes: an argument is "read by the
  // position it lands in", and once a parameter's type is known that position is known at the
  // application rather than after substitution. Here because it needs every declaration resolved
  // (a slot's declared type comes from the constructor's own vocabulary) and nothing yet closed.
  // The declared templates' parameters are stamped here too, not only their kinds.
  const unkinded = new Set<string>();
  const written = writtenParameterTypes(declarations, resolver, (name, error) => {
    if (receiver === undefined) {
      throw error;
    }
    const declaration = declarations.get(name);
    receiver.report(
      schemaProblem(id, name, error, declaration && positionOf(declaration, positions)),
    );
  });
  const declaredParameters = inferAll(namespace, new Set(declarations.keys()), written, heads, {
    report(name, error): void {
      if (receiver === undefined) {
        throw error;
      }
      unkinded.add(name);
      const declaration = declarations.get(name);
      receiver.report(
        schemaProblem(id, name, error, declaration && positionOf(declaration, positions)),
      );
    },
  });
  stampParameters(declaredParameters, [beforeMaterialise, namespace]);
  materialiser.setParameterKinds(parameterKindsOf(declaredParameters));
  // An application closed during the driving loop was checked against parameters carrying no
  // bound yet, so its check runs again now that they are stamped (§5.10). A declaration that
  // already failed has its verdict, so a replayed check is not a second one.
  materialiser.recheckEarly((name, error) => {
    if (receiver === undefined) {
      throw error;
    }
    if (failed.has(name)) return;
    failed.add(name);
    const declaration = declarations.get(name);
    receiver.report(
      schemaProblem(id, name, error, declaration && positionOf(declaration, positions)),
    );
  });
  // Condemned on the same terms as a declaration that failed to resolve: the verdict is in, and
  // closing an application of a template whose parameters cannot be classified only reports the
  // consequence -- the substituted body failing its constructor's vocabulary -- against whichever
  // entry happened to apply it.
  condemn(unkinded, beforeMaterialise, namespace);

  const materialiseReporter: MaterialisationFailureReporter | undefined =
    receiver === undefined
      ? undefined
      : {
          reportFailedApplication(entryName, error): void {
            const declaration = declarations.get(entryName);
            receiver.report(
              schemaProblem(
                id,
                entryName,
                error,
                declaration && positionOf(declaration, positions),
              ),
            );
          },
        };
  const materialised = materialiser.materialise(beforeMaterialise, materialiseReporter);
  const resolvedLocals = new Map(materialised.entries);
  const instantiations = new Map(materialised.materialised);
  const mintedSynthetic = materialised.synthetics;
  for (const [name, definition] of resolvedLocals) namespace.set(name, definition);
  for (const [name, definition] of instantiations) namespace.set(name, definition);

  // §5.8's IS-A edge for a parent written as an application, derived once every declaration has
  // resolved, and every closed chain then dropped of the applications it no longer needs.
  const applicationOfEntry = (name: string): TypeRef | undefined =>
    materialiser.mintedFacts(name)?.application ?? importedApplications.get(name);
  appliedParentEdges(
    namespace,
    [resolvedLocals, instantiations],
    applicationOfEntry,
    materialiser.expansionsByApplication(),
    mintedSynthetic,
  );
  closeChains(namespace, [resolvedLocals, instantiations]);

  // §8.2's merge, at the moment that section names -- "identity settles after Pass 2, when
  // references have resolved". A form the desugar phase lifted with an application in one of its
  // slots was named before that application had an entry to be named for; every application is
  // closed now, so it re-derives to the name the other channel already gave the same form.
  const merged = syntheticRenames(declarations, generated, materialiser);
  if (merged.size > 0) {
    rewriteSynthetics(resolvedLocals, merged);
    rewriteSynthetics(instantiations, merged);
    for (const [from, to] of merged) {
      // Dropped where the other channel already published the form, moved where it did not: the
      // eager name was this schema's only one for it, and an entry nothing names is not an entry.
      const eager = resolvedLocals.get(from);
      resolvedLocals.delete(from);
      namespace.delete(from);
      generated.delete(from);
      generated.add(to);
      if (!namespace.has(to) && eager !== undefined) {
        resolvedLocals.set(to, eager);
      }
    }
    for (const [name, definition] of resolvedLocals) namespace.set(name, definition);
    for (const [name, definition] of instantiations) namespace.set(name, definition);
  }

  // §5.10's parameters, recorded on every open entry this schema produced -- the materialiser
  // mints open entries of its own, which is why this runs once everything has closed as well as
  // before. A failure was reported by the first pass against the declaration that wrote it; one
  // here is the same verdict, and the entry keeps what it had.
  stampParameters(
    inferAll(
      namespace,
      new Set([...resolvedLocals.keys(), ...instantiations.keys()]),
      written,
      heads,
      {
        report(): void {
          // Already reported against the declaration that wrote it, by the pass before.
        },
      },
    ),
    [resolvedLocals, instantiations, namespace],
  );

  // §8.3: a type position naming a REFERENCE entry keeps that name -- a reference is a hop, not a
  // rewrite, so resolved output states the chain exactly as the author wrote it and nothing here
  // rewrites a use site past one. `namespace`/`resolvedLocals`/`instantiations` therefore need no
  // further pass once materialisation and the synthetic merge above have settled.

  // §6: a declaration's own name-annotations bind to the *name*, never hoisted onto the
  // definition -- so they, and the derived @synthetic and @application markers, land on entries'
  // key, not its value.
  const entries = new Map<string, Top>();
  const keyAnnotations = new Map<string, Annotations>();
  const localFacts = new Map<string, EntryFacts>();
  // Every application this schema closed, recorded on the entry it denotes (§4.2, §8.2): an entry's own
  // application, and an expansion's, which carries no `@meta.application`. A reference read in data is resolved
  // against these by structural identity, and they travel with the facts to every importer.
  const closes = new Map<string, TypeRef[]>();
  for (const { entry, application } of materialiser.closedApplications()) {
    const name = merged.get(entry) ?? entry;
    const held = closes.get(name);
    if (held === undefined) closes.set(name, [application]);
    else held.push(application);
  }
  /** `name`'s facts as resolution recorded them, with the head the materialiser knows where it closed the entry. */
  const factsFor = (name: string): EntryFacts => {
    const known = facts.get(name) ?? {};
    const head = materialiser.mintedFacts(name)?.head;
    const withHead = head === undefined || known.head !== undefined ? known : { ...known, head };
    const closed = closes.get(name);
    const closing = closed === undefined ? withHead : { ...withHead, closes: closed };
    // A form no author named is synthetic (§8.2): an importer reaching it by two routes unifies it.
    return generated.has(name) || mintedSynthetic.has(name)
      ? { ...closing, synthetic: true }
      : closing;
  };
  /** `annotations` with the application `name` closes recorded as its `@application` (§8.2). */
  const withAppliedKey = (name: string, annotations: Annotations): Annotations => {
    const application = materialiser.mintedFacts(name)?.application;
    return application === undefined ? annotations : withApplication(annotations, application);
  };
  const keep = (name: string): void => {
    const recorded = factsFor(name);
    if (Object.keys(recorded).length > 0) localFacts.set(name, recorded);
  };
  for (const name of declarations.keys()) {
    let nameAnnotations: Annotations;
    const declaration = requiredGet(declarations, name, 'resolveSchema');
    try {
      // `@application` is the resolver's (§8.2): it states the application an entry closes, and
      // a declaration never writes it, as it never writes `chain`. `bx => box<text>` is the
      // declaration that means it.
      if (
        declaration.nameAnnotations.some((annotation) => annotation.name === APPLICATION_ANNOTATION)
      ) {
        throw new TsonSchemaValidationError(
          `'${name}' writes '@${APPLICATION_ANNOTATION}' on its key, which the resolver attaches ` +
            'wherever an entry closes an application and no declaration writes (§8.2) -- declare ' +
            "the entry as the application itself ('name => template<args>')",
        );
      }
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
    // A merged form is keyed by the name it merged onto, and contributes nothing at all where
    // that name belongs to the materialised half -- the entry is there, marked, and this is its
    // old key.
    const key = merged.get(name) ?? name;
    if (!resolvedLocals.has(key)) {
      continue;
    }
    entries.set(key, requiredGet(resolvedLocals, key, 'resolveSchema'));
    keep(key);
    const annotated = withAppliedKey(key, generated.has(key) ? SYNTHETIC : nameAnnotations);
    if (annotated.length > 0) keyAnnotations.set(key, annotated);
  }
  // An entry the materialiser minted has no declared name to carry author annotations from; the
  // synthetic half still gets the derived marker (§8.2), and an instantiation its application.
  for (const [name, value] of instantiations) {
    entries.set(name, value);
    keep(name);
    const annotated = withAppliedKey(name, mintedSynthetic.has(name) ? SYNTHETIC : []);
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

// ── Applied parents (§5.8) ───────────────────────────────────────────────────────────────────

/**
 * §5.8's IS-A edge for a **parent written as an application**, derived once every declaration has
 * resolved, and the chains made complete through it.
 *
 * Composition needs the operand's *fields* and nothing else, so a closed declaration and a closed
 * template both keep the application in their chain's `parents` and mint no entry for it (§8.2).
 * The edge is the half that has to wait: the entry an application denotes is whichever declaration
 * names the same application, and asking that *during* materialisation would make the answer depend
 * on declaration order -- `text_box` declared before the composition found, declared after it not.
 *
 * **Nothing is created here.** The pass derives an index over entries that already exist, keyed on
 * §8.2's canonical application so two spellings of one application agree -- the application each
 * instantiation records, an imported one's included, and for a use site's minted expansion (which
 * records none) the materialiser's own index. Where no entry denotes the application there is no
 * name to record, and that is the right answer: nobody declared that type, so nothing can be
 * declared as it. {@link closeChains} then drops every application left standing.
 *
 * **Complete means transitively closed**: an entry IS-A every entry its supertypes are IS-A, so a
 * declaration composing `okt => ok<text>` reaches the edge `okt` gained here, though it holds no
 * application of its own. The fold runs to a fixed point over every local chain, bounded by the
 * entry count since each round adds at least one name or stops. A minted synthetic gains no edge:
 * it is a member of nothing (`templates.ts`'s `refuseMintedMember`).
 */
function appliedParentEdges(
  namespace: Map<string, Top>,
  maps: readonly Map<string, Top>[],
  applicationOf: (name: string) => TypeRef | undefined,
  expansions: ReadonlyMap<string, string>,
  synthetics: ReadonlySet<string>,
): void {
  const byApplication = new Map<string, string>();
  for (const name of namespace.keys()) {
    const application = applicationOf(name);
    if (application === undefined || application.arguments.length === 0) continue;
    const key = canonicalApplication(application.name, application.arguments);
    if (!byApplication.has(key)) byApplication.set(key, name);
  }
  for (const [key, name] of expansions) if (!byApplication.has(key)) byApplication.set(key, name);
  const bound = [...maps].reduce((total, map) => total + map.size, 0);
  for (let round = 0; round <= bound; round++) {
    let changed = false;
    for (const entries of maps) {
      for (const [name, definition] of entries) {
        if (synthetics.has(name)) continue;
        const folded = completed(definition, byApplication, namespace);
        if (folded !== definition) {
          entries.set(name, folded);
          namespace.set(name, folded);
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
}

/**
 * One chain made complete: a type's every applied parent's owning entry folded in, and for any
 * chain every member's own supertypes. The application stays in `parents` until
 * {@link closeChains}, so a later round still finds it when the owner's chain has grown.
 * `definition` itself where nothing grew.
 */
function completed(
  definition: Top,
  byApplication: ReadonlyMap<string, string>,
  namespace: ReadonlyMap<string, Top>,
): Top {
  if (!isType(definition)) return definition;
  const chain = chainOf(definition);
  const names = new Set(chain.supertypes);
  for (const parent of chain.parents) {
    if (parent.arguments.length === 0) continue;
    const owner = byApplication.get(canonicalApplication(parent.name, parent.arguments));
    if (owner !== undefined) names.add(owner);
  }
  for (const member of [...names]) {
    for (const ancestor of supertypesOf(namespace.get(member))) names.add(ancestor);
  }
  return names.size === chain.supertypes.length
    ? definition
    : withChain(definition, typeChain([...names], chain.parents, chain.subtypes));
}

/**
 * Every closed chain with the applications the fold left standing dropped: an application no
 * entry denotes is one nothing can be declared as, so it reaches no edge, and a closed type's
 * parents are not part of it ([TSON-SCHEMA] §4.1). A template keeps its written parents: they may
 * still name its own parameters, and closing each application completes that application's chain
 * from them.
 */
function closeChains(namespace: Map<string, Top>, maps: readonly Map<string, Top>[]): void {
  for (const entries of maps) {
    for (const [name, definition] of entries) {
      const chain = chainOf(definition);
      if (!isType(definition) || chain.parents.length === 0 || isOpen(definition)) continue;
      const closed = withChain(definition, typeChain(chain.supertypes, [], chain.subtypes));
      entries.set(name, closed);
      namespace.set(name, closed);
    }
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

/** [TSON-SCHEMA] §8.2's derived marker, attached to the key of every entry this resolver materialised from a sugar form. */
const SYNTHETIC: Annotations = [{ name: SYNTHETIC_ANNOTATION }];

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

function requiredEntry(entries: ReadonlyMap<string, Top>, name: string): Top {
  const entry = entries.get(name);
  if (entry === undefined) throw new TsonInternalError(`no entry '${name}' in the merged imports`);
  return entry;
}

/**
 * Stage 1 of {@link resolveSchema} -- every `!!import`'s whole namespace, in declaration order,
 * merged as-is (never re-resolved against the importer). Mirrors the reference implementation's
 * own `mergeImports`, including its collision rule (§2.2.3): a route repeating one already-merged
 * URI is skipped (transitivity means the second mention contributes nothing new), and a name two
 * *different* origins both declare is a {@link TsonSchemaValidationError}.
 */
function mergeImports(
  document: SchemaDocument,
  deps: SchemaResolverDeps,
  facts: EntryFactsTable,
  applications: Map<string, TypeRef>,
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
        const incumbentFacts = facts.get(name);
        const arrivingFacts = imported.facts?.get(name);
        if (
          incumbent !== origin &&
          merged.get(name) !== undefined &&
          areOneSynthetic(
            name,
            incumbentFacts,
            requiredEntry(merged, name),
            incumbent,
            arrivingFacts,
            definition,
            origin,
          )
        ) {
          // One synthetic minted by two documents is one entry (§8.2): the first arrival is kept.
          if (incumbentFacts !== undefined && arrivingFacts !== undefined) {
            facts.set(name, unifiedFacts(incumbentFacts, arrivingFacts));
          }
          continue;
        }
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
    }
  }
  // Each nested map holds the union of the members its closure declares.
  return new Map(syncedEntries({ entries: merged, keyAnnotations: new Map() }).entries);
}

/**
 * §5.10 admits no head abstraction: a type parameter stands for a type, never for a template, so
 * `<T> { v: T<text> }` is no form. Refused here, over every application a held body writes, rather
 * than waiting for materialisation (which, by the time it ran, would have already substituted the
 * parameter away and left either an arity error against a content-derived name nobody typed, or a
 * wire-vocabulary mismatch -- neither naming what the author did).
 */
function refuseHeadAbstraction(name: string, resolved: Top): void {
  const body = heldOf(resolved);
  if (body === undefined) {
    return; // a closed entry
  }
  for (const application of body.applications()) {
    if (body.parameterNames.includes(application.name)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${application.name}' is a type parameter applied to arguments -- a parameter stands for a ` +
          `type, never for a template, and §5.10 admits no head abstraction, so '${application.name}<...>' is no ` +
          'form. Take the applied type as the parameter instead',
      );
    }
  }
}

/**
 * What each declaration's parameter list wrote after a name (`<T: text>`), as the type-refs
 * resolution uses, keyed by declaration then parameter. A written type that is not a reference to
 * a type is reported against the declaration that wrote it and left out.
 */
function writtenParameterTypes(
  declarations: ReadonlyMap<string, Declaration>,
  resolver: DefinitionResolver,
  report: (name: string, error: TsonSchemaValidationError) => void,
): ReadonlyMap<string, ReadonlyMap<string, TypeRef>> {
  const written = new Map<string, ReadonlyMap<string, TypeRef>>();
  for (const [name, declaration] of declarations) {
    if (declaration.parameterTypes === undefined) continue;
    const types = new Map<string, TypeRef>();
    for (const [parameter, ref] of declaration.parameterTypes) {
      try {
        types.set(parameter, resolver.parameterType(parameter, ref));
      } catch (e: unknown) {
        if (!(e instanceof TsonSchemaValidationError)) throw e;
        report(name, e);
      }
    }
    if (types.size > 0) written.set(name, types);
  }
  return written;
}

/**
 * Stamps each named open entry's parameters (`parameterTypes.ts`) in every view of it, so every
 * view of an entry agrees.
 */
function stampParameters(
  parameters: ReadonlyMap<string, ReadonlyMap<string, TemplateParam>>,
  views: readonly Map<string, Top>[],
): void {
  for (const view of views) {
    for (const [name, value] of view) {
      const settled = parameters.get(name);
      if (settled !== undefined && isOpen(value)) {
        view.set(name, withParametersOf(value, settled));
      }
    }
  }
}

/**
 * The placeholder a declaration that failed to resolve leaves behind, so declarations that
 * reference it -- and ones merely queued after it -- still resolve instead of collapsing into a
 * cascade of consequences of one original error. An empty record, because the point is to absorb
 * rather than to be recognised: a dependent that composes with a failed declaration
 * (`parent => child & { ... }`) resolves cleanly, contributing no fields.
 *
 * **It keeps the failed declaration's own type parameters.** Answering "how many type
 * parameters?" with zero is answering wrongly, not absorbing -- a downstream `bl<text>` would then
 * be told `bl` "declares no type parameters", which is a wrong fix for someone else's error.
 */
function unresolvedPlaceholder(parameters: readonly string[]): Top {
  // An open placeholder is an open empty record, closing by the process every record template
  // does, so nothing downstream has to keep a second substitution path for it.
  return {
    kind: 'record',
    fields: NO_FIELDS,
    groups: [],
    extension: 'OPEN',
    ...(parameters.length === 0
      ? {}
      : {
          parameters: parameters.map((parameter) => ({
            name: parameter,
            type: { name: TYPE_KIND, arguments: [], annotations: [] },
          })),
        }),
  };
}

/**
 * Replaces each named entry with {@link unresolvedPlaceholder}, keeping its position and its type
 * parameters -- the same treatment a declaration that failed to resolve gets, applied to a
 * template whose verdict is already in (§5.10's parameter-kind classification, today the only
 * caller).
 *
 * **Both maps, because the two halves are read by different phases**: `templates.ts`'s own
 * `materialise` walks `resolvedLocals`, while an application's head is looked up through
 * `namespaceGetter` over `namespace`. Leaving one behind would close applications against the
 * condemned template through whichever map was missed.
 */
function condemn(
  names: ReadonlySet<string>,
  resolvedLocals: Map<string, Top>,
  namespace: Map<string, Top>,
): void {
  for (const name of names) {
    const condemned = requiredGet(resolvedLocals, name, 'condemn');
    const placeholder = unresolvedPlaceholder(typeParameters(condemned));
    resolvedLocals.set(name, placeholder);
    namespace.set(name, placeholder);
  }
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

/** `value` tagged with `type` where it was written under the alias `written` of it. */
function retagged(value: DataValue, written: string, type: string): DataValue {
  return type !== written && value.typeRef === written ? { ...value, typeRef: type } : value;
}
