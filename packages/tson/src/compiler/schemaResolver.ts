/**
 * Resolves a whole {@link SchemaDocument} into a {@link Schema}: `!!id`/`!!import` handling,
 * merging every import's namespace into the type-name namespace before any local declaration
 * resolves, driving `definitionResolver.ts` over every declaration on demand (dependency order,
 * not source order, so a declaration may compose or refine one declared later in the same
 * schema), §8.3 use-site flattening, and the `@synthetic` key marker (§8.2).
 *
 * Ported from the reference implementation's `SchemaResolver`
 * (`tson-compiler/.../resolver/SchemaResolver.java`); see that file's own module doc for the
 * exhaustive rationale. This module states only what differs in the port.
 *
 * **This module does not fetch, link, or register anything.** The Java original holds a
 * `TsonCompiledSchemaLoader` that resolves `!!meta`/`!!import` by fetching, compiling and caching
 * schemas on demand -- that whole apparatus (a schema registry, canonical-identity validation,
 * transitive-import linking) is a later work package's (linking/registry, identity and hashing).
 * This module instead takes the governing meta's own compiled surface
 * ({@link SchemaResolverDeps.metaDefinitions}/{@link SchemaResolverDeps.definitionMetaReader}/
 * {@link SchemaResolverDeps.annotationValueReader}) and each import's already-resolved namespace
 * ({@link SchemaResolverDeps.resolveImport}) as caller-supplied dependencies, the same
 * dependency-injection shape `definitionResolver.ts` already uses for its own five/eight
 * functions. A caller with no loader yet (every caller today) simply omits `resolveImport`; this
 * module then reports {@link TsonNotImplementedError} the moment a document actually writes
 * `!!import`, rather than pretending to resolve one.
 *
 * **§5.10 materialisation runs exactly where the Java's own `SchemaResolver` runs it.** One
 * `templates.ts` `TemplateMaterialiser` is constructed per call, before the driving loop -- its
 * `closeApplication` is wired into `definitionResolver.ts` as its own on-demand `ApplicationCloser`
 * (a composition supertype or refinement source that is a *closed* generic application needs one
 * to absorb its fields immediately, per that module's own note), and its batch `materialise` pass
 * runs once every local declaration has resolved. Sharing one instance for both is what makes an
 * on-demand closing and a later batch closing of the same application land on one entry.
 *
 * **Two namespace dependencies, mirroring `definitionResolver.ts`'s own split (§3.3.1).**
 * `deps.metaDefinitions` is the structure namespace (the governing meta's own entries, one hop via
 * `!!meta`); the type-name namespace is this module's own concern, built from `!!import` and grown
 * as each local declaration resolves -- never a caller-supplied function, since only this module
 * knows the resolution order a document's own declarations create.
 */
import {
  TsonBindMismatchError,
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaFetchError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import { diagnosticCodeForFetch } from '../core/diagnostic.js';
import type { Diagnostic, DiagnosticsReceiver } from '../core/diagnostic.js';
import type { Position } from '../core/position.js';
import type { Declaration, SchemaDocument } from '../ast/schema/document.js';
import type { Annotations, TypeDefinition } from '../schema/meta/typedef.js';
import {
  createDefinitionResolver,
  type DefinitionResolver,
  type DefinitionResolverDeps,
} from './definitionResolver.js';
import type {
  AnnotationValueReader,
  DefinitionGetter,
  DefinitionMetaReader,
  SourceBodyEncoder,
} from './resolverTypes.js';
import { desugar, lifted, type DesugarFailureReporter } from './desugar.js';
import { createHeldBody } from './heldBody.js';
import { heldEmptyRecord } from './wireForm.js';
import { createTemplateMaterialiser, type MaterialisationFailureReporter } from './templates.js';
import { flattenSchema } from './referenceFlattener.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * A resolved schema (Part 2 §8): the kernel's own `schema` type, `map<type_name,
 * type_definition>` (§9), plus the governing-chain directives the document header carried
 * (`!!id`/`!!meta`/`!!import*`, §2.2). `entries`' insertion order is preserved, matching
 * `SchemaMap.declarations`'s own ordering guarantee.
 *
 * `id` is a plain `string`, not optional -- the grammar itself marks `!!id` optional (a raw
 * parsed {@link SchemaDocument} can genuinely lack one), but a *resolved* schema always needs a
 * real identity; {@link resolveSchema} enforces this before ever constructing one.
 *
 * `bootstrap` is `true` only for a schema `bootstrap.ts`'s `bootstrapMetaKernel` itself produced
 * (Part 2 §1.5's one deliberate circularity: meta-kernel's own `!!meta` names its own `!!id`, and
 * nothing else is allowed to).
 *
 * **`entries`/`keyAnnotations` are two parallel maps, not one `AnnotatedMap`.**
 * `annotations/index.ts` already declares an `AnnotatedMap<K, V>` with exactly this shape, but its
 * own `Annotations` is the *wire* carrier (`{ values: readonly Annotation[] }`, over
 * `ast/value.ts`'s `Annotation`) -- a different, incompatible type from `schema/meta/typedef.ts`'s
 * own local stand-in (`readonly Annotation[]`, over its own `Annotation`) that every other
 * annotation-carrying field in this module already uses (`TypeDefinition.annotations`,
 * `RecordField.annotations`, ...). `STATUS.md`'s own "Known gaps" note names this exact mismatch.
 * Reusing `AnnotatedMap` here would force a conversion this module has no reason to perform;
 * spelling the same shape with `schema/meta`'s own `Annotations` keeps every annotation in this
 * module speaking one type.
 */
export interface Schema {
  readonly id: string;
  readonly meta: string;
  readonly imports: readonly string[];
  /** Every resolved entry, local-only (imported entries are visible during resolution but never part of this). */
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  /** `entries.get(name)`'s own key-position annotations (§6) -- present only for a name that carries at least one. */
  readonly keyAnnotations: ReadonlyMap<string, Annotations>;
  readonly bootstrap: boolean;
}

/** One `!!import`'s own resolved namespace, and where each of its entries was originally declared. */
export interface ImportedSchema {
  /** Every entry this import contributes -- its own whole, transitively-merged namespace. */
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  /**
   * `name`'s origin schema id, for the identity-based collision rule §2.2.3 states: one schema
   * reached by several `!!import` routes unifies (same origin, kept once), two different schemas
   * declaring one name is an error (different origins). Called only for a name `entries` holds.
   */
  readonly originOf: (name: string) => string;
}

/** Resolves one `!!import` directive's URI to the namespace it contributes. */
export type ImportResolver = (importUri: string) => ImportedSchema;

/**
 * Every dependency {@link resolveSchema} needs beyond the document in hand. The four fields
 * shared with {@link DefinitionResolverDeps} carry the identical contract that module states for
 * each -- see `resolverTypes.ts`. `definitionMetaReader` doubles as `templates.ts`'s own
 * `TemplateMaterialiserDeps.definitionMetaReader`: the same "bind a value through this
 * constructor's compiled reader" contract, whether the value came from a written `!C value` or a
 * template application's own substituted body.
 */
export interface SchemaResolverDeps {
  readonly definitionMetaReader: DefinitionMetaReader;
  readonly metaDefinitions: DefinitionGetter;
  readonly annotationValueReader?: AnnotationValueReader;
  readonly encodeSourceBody?: SourceBodyEncoder;
  /** Resolves an `!!import` URI's namespace. Omitted means "no loader": a document with no `!!import` is unaffected; one that writes any reports {@link TsonNotImplementedError}. */
  readonly resolveImport?: ImportResolver;
}

/** Options for {@link resolveSchema}. */
export interface ResolveSchemaOptions {
  /**
   * The identity-keyed source position of every declaration `document` carries, mirroring
   * `desugar.ts`'s own `DesugarOptions.positions` -- indeed the very same map, threaded through
   * both phases so a declaration desugaring rebuilds keeps its position. Every resolved entry's
   * own `position` (§8.1's diagnostic addition) comes from here.
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
 * Resolves every declaration in `document`'s body, on demand and dependency-following rather than
 * strict source order (§3.4.1), and carries `document`'s own header directives
 * (`!!id`?/`!!meta`/`!!import*`) into the result's `id`/`meta`/`imports`.
 *
 * **Two things are validated up front**, before any declaration is resolved: `document.id` must
 * be present (§2.2.1: "publishing a schema... REQUIRES `!!id`"), thrown as
 * {@link TsonSchemaValidationError} naming the document's own `!!meta` so the caller can tell
 * *which* document lacked one. `document.meta` itself is not independently validated here --
 * `deps.metaDefinitions`/`deps.definitionMetaReader` are simply used as given; a caller responsible
 * for resolving `!!meta` to those functions in the first place (a later work package) is where a
 * malformed or unreachable `!!meta` is caught.
 *
 * **`!!import` is merged into the type-name namespace before any local declaration resolves.**
 * Collision handling mirrors what the reference implementation's linker does one phase later
 * (§2.2.3): a name declared by more than one import, or by an import *and* a local declaration, is
 * a {@link TsonSchemaValidationError}. **Merged entries keep their home namespace** -- an imported
 * entry is copied in exactly as its own schema resolved it, never re-resolved or re-materialised
 * against the importer.
 *
 * §5.10 materialisation and §8.3 use-site flattening both run once every local declaration has
 * resolved -- see this module's own doc on the former's optionality. Flattening is unconditional
 * and needs no dependency: `referenceFlattener.ts` is self-contained.
 *
 * **§6: an annotation written before a declared name binds to the name, not the definition.** A
 * resolved schema is `{type_name => type_definition}`, so the name is the *key* of `entries` --
 * which is where {@link Schema.keyAnnotations} keeps them, alongside the derived `@synthetic`
 * marker (§8.2) every entry this module lifted from a sugar form or materialised from an open
 * synthetic carries at its key, and nowhere else.
 */
export function resolveSchema(
  document: SchemaDocument,
  deps: SchemaResolverDeps,
  options: ResolveSchemaOptions = {},
): Schema {
  const id = document.id;
  if (id === undefined) {
    throw new TsonSchemaValidationError(
      `'!!meta:"${document.meta}"': !!id is required to resolve this schema, but is absent (§2.2.1)`,
    );
  }
  const { positions, receiver } = options;

  const namespace = mergeImports(document, deps);

  const reporter: DesugarFailureReporter | undefined =
    receiver === undefined
      ? undefined
      : {
          reportFailedDeclaration(declaration, error): void {
            receiver.report(
              schemaProblem(id, declaration.name, error, positions?.get(declaration)),
            );
          },
        };
  const desugared = desugar(document, new Set(namespace.keys()), {
    ...(reporter === undefined ? {} : { reporter }),
    ...(positions === undefined ? {} : { positions }),
  });
  const declarations = desugared.body.declarations;
  const generated = lifted(document, desugared);

  // Local-vs-import collisions, up front (local names are already unique -- SchemaMap dedupes them).
  for (const name of declarations.keys()) {
    if (namespace.has(name)) {
      throw new TsonSchemaValidationError(
        `'${name}' collides with an entry of the same name brought in by !!import`,
      );
    }
  }

  // Resolve on demand, following dependencies rather than source order (§3.4.1). `resolving`
  // catches a cycle through a composition/refinement/atom-refinement edge; ordinary recursion
  // through field references never enters it. `resolverBox` breaks the construction cycle
  // between this getter and the `DefinitionResolver` that needs it as its own `namespaceDefinitions`.
  const resolving = new Set<string>();
  const resolverBox: { current?: DefinitionResolver } = {};

  const namespaceGetter: DefinitionGetter = (name) => {
    const already = namespace.get(name);
    if (already !== undefined) {
      return already;
    }
    const declaration = declarations.get(name);
    if (declaration === undefined) {
      return undefined; // not a local entry -- an as-yet-unverified reference a later phase validates
    }
    if (resolving.has(name)) {
      throw new TsonSchemaValidationError(
        `'${name}' is part of a circular composition/refinement chain (${[...resolving].join(' -> ')} -> ${name}) ` +
          '-- a supertype or refinement source cannot depend, directly or transitively, on the type it helps define',
      );
    }
    resolving.add(name);
    try {
      const resolver = resolverBox.current;
      if (resolver === undefined) {
        throw new TsonInternalError(
          'namespaceGetter was invoked before its own DefinitionResolver was assigned',
        );
      }
      const position = positions?.get(declaration);
      const resolved = resolver.resolve(declaration, position);
      refuseHeadAbstraction(name, resolved);
      namespace.set(name, resolved);
      return resolved;
    } catch (e: unknown) {
      if (!isReportable(e)) {
        throw e;
      }
      if (receiver === undefined) {
        throw e;
      }
      const position = positions?.get(declaration);
      receiver.report(schemaProblem(id, name, e, position));
      const placeholder = unresolvedPlaceholder(position, typeParamsOfDeclaration(declaration));
      namespace.set(name, placeholder);
      return placeholder;
    } finally {
      resolving.delete(name);
    }
  };

  // One materialiser for the whole schema, built before the driving loop because resolution
  // itself closes applications on demand (a supertype or refinement source absorbing a *closed*
  // application's fields cannot wait for the batch pass below). `generated` is `templates.ts`'s
  // own `generatedNames`: the desugar lift's synthetic names, so a generated head closing its own
  // intermediate form is told apart from an authored one.
  const materialiser = createTemplateMaterialiser({
    namespaceDefinitions: namespaceGetter,
    publish: (name, definition) => namespace.set(name, definition),
    definitionMetaReader: deps.definitionMetaReader,
    generatedNames: generated,
  });

  resolverBox.current = createDefinitionResolver({
    definitionMetaReader: deps.definitionMetaReader,
    metaDefinitions: deps.metaDefinitions,
    namespaceDefinitions: namespaceGetter,
    applicationCloser: (application) => materialiser.closeApplication(application),
    ...(deps.annotationValueReader === undefined
      ? {}
      : { annotationValueReader: deps.annotationValueReader }),
    ...(deps.encodeSourceBody === undefined ? {} : { encodeSourceBody: deps.encodeSourceBody }),
  } satisfies DefinitionResolverDeps);
  const resolver: DefinitionResolver = resolverBox.current;

  for (const name of declarations.keys()) {
    namespaceGetter(name);
  }

  // §5.10 materialisation, after every declaration has resolved: a template application reaches
  // here as a type-ref carrying arguments, and closing it needs the template's own *resolved* open
  // form, which only exists once the loop above has run.
  const beforeMaterialise = new Map<string, TypeDefinition>();
  for (const name of declarations.keys()) {
    beforeMaterialise.set(name, requiredGet(namespace, name, 'resolveSchema'));
  }
  const materialiseReporter: MaterialisationFailureReporter | undefined =
    receiver === undefined
      ? undefined
      : {
          reportFailedApplication(entryName, error): void {
            const declaration = declarations.get(entryName);
            receiver.report(
              schemaProblem(id, entryName, error, declaration && positions?.get(declaration)),
            );
          },
        };
  const materialised = materialiser.materialise(beforeMaterialise, materialiseReporter);
  const resolvedLocals = new Map(materialised.entries);
  let instantiations = new Map(materialised.materialised);
  const mintedSynthetic = materialised.synthetics;
  for (const [name, definition] of resolvedLocals) namespace.set(name, definition);
  for (const [name, definition] of instantiations) namespace.set(name, definition);

  // §8.3, last because it needs everything above already in the namespace: a type position naming
  // a REFERENCE entry is rewritten to the end of its chain and keeps the author's own name as
  // @alias. After materialisation specifically, so an alias to an application flattens onto the
  // entry that application minted rather than onto the alias in front of it.
  const mintedNames = new Set(instantiations.keys());
  const flatLocals = flattenSchema(resolvedLocals, namespace, mintedNames);
  for (const [name, definition] of flatLocals) resolvedLocals.set(name, definition);
  instantiations = flattenSchema(instantiations, namespace, mintedNames);
  for (const [name, definition] of resolvedLocals) namespace.set(name, definition);
  for (const [name, definition] of instantiations) namespace.set(name, definition);

  // §6: a declaration's own name-annotations bind to the *name*, never hoisted onto the
  // definition -- so they, and the derived @synthetic marker, land on entries' key, not its value.
  const entries = new Map<string, TypeDefinition>();
  const keyAnnotations = new Map<string, Annotations>();
  for (const name of declarations.keys()) {
    let nameAnnotations: Annotations;
    const declaration = requiredGet(declarations, name, 'resolveSchema');
    try {
      nameAnnotations = resolver.annotationsFor(name, declaration.nameAnnotations);
    } catch (e: unknown) {
      if (!isReportable(e)) {
        throw e;
      }
      if (receiver === undefined) {
        throw e;
      }
      receiver.report(schemaProblem(id, name, e, positions?.get(declaration)));
      nameAnnotations = [];
    }
    entries.set(name, requiredGet(resolvedLocals, name, 'resolveSchema'));
    if (generated.has(name)) {
      keyAnnotations.set(name, SYNTHETIC);
    } else if (nameAnnotations.length > 0) {
      keyAnnotations.set(name, nameAnnotations);
    }
  }
  // An entry the materialiser minted has no declared name to carry author annotations from; the
  // synthetic half still gets the derived marker (§8.2), the rest get none.
  for (const [name, definition] of instantiations) {
    entries.set(name, definition);
    if (mintedSynthetic.has(name)) {
      keyAnnotations.set(name, SYNTHETIC);
    }
  }

  return {
    id,
    meta: document.meta,
    imports: document.imports,
    entries,
    keyAnnotations,
    bootstrap: false,
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────

/** [TSON-SCHEMA] §8.2's derived marker, attached to the key of every entry this resolver materialised from a sugar form. */
const SYNTHETIC: Annotations = [{ name: 'synthetic' }];

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
  | TsonSchemaFetchError;

function isReportable(e: unknown): e is ReportableSchemaError {
  return (
    e instanceof TsonSchemaValidationError ||
    e instanceof TsonNotImplementedError ||
    e instanceof TsonBindMismatchError ||
    e instanceof TsonSchemaFetchError
  );
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
): Map<string, TypeDefinition> {
  const merged = new Map<string, TypeDefinition>();
  const origins = new Map<string, string>();
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
      if (incumbent !== undefined) {
        if (incumbent !== origin) {
          throw new TsonSchemaValidationError(
            `'${name}' is declared by two different schemas reached through !!import ('${incumbent}' and ` +
              `'${origin}') -- distinct types cannot share one name in the flat namespace; import one of them, ` +
              `or a version of each that agrees on where '${name}' is declared`,
          );
        }
        continue;
      }
      merged.set(name, definition);
      origins.set(name, origin);
    }
  }
  return merged;
}

/**
 * §5.10 admits no head abstraction: a type parameter stands for a type, never for a template, so
 * `<T> { v: T<text> }` is no form. Refused here, over every application a held body writes, rather
 * than waiting for materialisation (which, by the time it ran, would have already substituted the
 * parameter away and left either an arity error against a content-derived name nobody typed, or a
 * wire-vocabulary mismatch -- neither naming what the author did).
 */
function refuseHeadAbstraction(name: string, resolved: TypeDefinition): void {
  if ('kind' in resolved.body) {
    return; // not a held TemplateBody
  }
  for (const application of resolved.body.applications()) {
    if (resolved.parameters.includes(application.name)) {
      throw new TsonSchemaValidationError(
        `'${name}': '${application.name}' is a type parameter applied to arguments -- a parameter stands for a ` +
          `type, never for a template, and §5.10 admits no head abstraction, so '${application.name}<...>' is no ` +
          'form. Take the applied type as the parameter instead',
      );
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
function unresolvedPlaceholder(
  position: Position | undefined,
  parameters: readonly string[],
): TypeDefinition {
  return {
    kind: 'PRODUCT',
    parameters,
    constructor: false,
    supertypes: [],
    subtypes: [],
    // An open placeholder holds its body like every other open entry, so nothing downstream has to
    // keep a second substitution path for the one shape that did not.
    body:
      parameters.length === 0
        ? { kind: 'record', supertypes: [], fields: [], groups: [] }
        : createHeldBody(heldEmptyRecord()),
    ...(position === undefined ? {} : { position }),
    annotations: [],
  };
}

/** A declaration's own declared type parameters -- mirrors `desugar.ts`'s own (unexported) `typeParamsOf`. */
function typeParamsOfDeclaration(declaration: Declaration): readonly string[] {
  const typeDef = declaration.typeDef;
  switch (typeDef.kind) {
    case 'instance':
    case 'structuralTypeDef':
    case 'referenceTypeDef':
      return typeDef.typeParams;
    case 'atomRefinement':
      return [];
  }
}

/**
 * One declaration's failure as a {@link Diagnostic}, classified positively -- `BIND_MISMATCH` for
 * a {@link TsonBindMismatchError} (the reading application's own binding disagrees with the
 * schema, not an author mistake; subsumes {@link TsonMissingBindingError}), `NOT_IMPLEMENTED` for
 * a {@link TsonNotImplementedError} (a library gap), `SCHEMA_UNAVAILABLE` for a
 * {@link TsonSchemaFetchError} (no configured source would supply a schema this declaration's own
 * constructor is bound against -- not obtained, so never judged), and `SCHEMA_ERROR` for a
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
