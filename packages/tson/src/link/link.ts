/**
 * Turns a resolved-but-unlinked {@link Schema} (`compiler/schemaResolver.ts`'s own output) into a
 * {@link LinkedSchema} — the compile-time proof that every `!!import` transitively merged
 * (diamonds included), `subtypes` is populated, choice `disjoint` is derived and its `@disjoint`
 * assertions checked, and every type reference in the schema actually resolves.
 *
 * Ported from the reference implementation's `TsonSchemaLinker`
 * (`tson-compiler/.../TsonSchemaLinker.java`); see that file's own module doc for the exhaustive
 * rationale. This module states only what differs in the port.
 *
 * **Why this exists separately from `schemaResolver.ts`, when that module already merges
 * `!!import`.** `resolveSchema`'s own `mergeImports` builds the namespace a schema's *own*
 * declarations resolve against — every import's entries, taken from a caller-supplied
 * `resolveImport`, so a local declaration can reference an imported name while it resolves. That
 * merge is deliberately shallow about one thing: it has no `subtypes` yet to reconcile (`subtypes`
 * does not exist until *this* module computes it), so its own collision handling never needs
 * `unifySubtypes.ts`'s diamond union. This module's own {@link mergeImports} is the *later*, full
 * merge Part 2 §2.2.3's identity-collision rule actually needs: called once every local
 * declaration is already resolved, over `ImportedSchema`s that are themselves already fully
 * *linked* (so each one's own `subtypes` already reflects everything its own schema could see),
 * reconciling two routes to one diamond-reached schema by union rather than by "keep the first".
 *
 * **What this module deliberately does not do**, each a documented follow-up rather than a
 * silent gap: constructor-eligibility checking (§2.2.2 — which schemas may declare/govern with
 * `~`), `TypeInhabitance`'s productivity check (§3.4.1 — an entry no finite document can
 * satisfy), and the reference-implementation's richer "walk back to the nearest positioned
 * declaration" error attribution (`referenceValidation.ts`'s own note). None of the four
 * deliverables this work package states depend on any of the three.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import type { ImportedSchema, ImportResolver, Schema } from '../compiler/schemaResolver.js';
import type { Annotations, TypeDefinition } from '../schema/meta/typedef.js';
import { DEFAULT_NAME_POLICY, type NamePolicy } from '../unicode/policy.js';
import { canonicalizeIdentity } from './identity.js';
import { computeSubtypes, unifySubtypes } from './subtypes.js';
import { checkDisjointAssertions, computeDisjointness } from './disjointness.js';
import { checkNameHygiene } from './nameHygiene.js';
import { validateReferences } from './referenceValidation.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * A linked schema (Part 2 §2.2.3, §8): {@link Schema}'s own three header fields, carried through
 * unchanged, plus the **flat, fully-merged** namespace — every entry this schema can see, local
 * *and* imported, `subtypes`/`disjoint` populated — and the origin schema id each entry's own
 * identity is keyed against.
 *
 * Unlike {@link Schema.entries} (local-only, by that interface's own contract), `entries` here is
 * the whole closure: an importer of *this* schema takes every one of these, exactly as-is, never
 * re-validating or re-resolving them (§2.2.3's "merged entries keep their home namespace").
 */
export interface LinkedSchema {
  readonly id: string;
  readonly meta: string;
  readonly imports: readonly string[];
  /** Every entry this schema can see: this schema's own declarations plus every `!!import`'s, transitively. */
  readonly entries: ReadonlyMap<string, TypeDefinition>;
  /**
   * `entries.get(name)`'s own key-position annotations (§6) — present only for a locally-declared
   * name that carries at least one. Imported names' key annotations are not carried over: §6's
   * key-annotation carrier is a project-tracked gap (`STATUS.md`'s "`annotations` is bound as an
   * ordinary wire field, not as a record's annotations carrier"), and `ImportedSchema` (this
   * package's own dependency contract) exposes no key-annotation map to carry over in the first
   * place. A caller that needs an imported name's own `@doc` reads it from that name's *home*
   * schema instead.
   */
  readonly keyAnnotations: ReadonlyMap<string, Annotations>;
  readonly bootstrap: boolean;
  /**
   * `name`'s origin schema id, for every entry `entries` holds, local or imported — §2.2.3's
   * identity-based collision rule (one schema reached by several `!!import` routes unifies; two
   * different schemas declaring one name is an error) needs this to decide which case it is, and
   * a further importer of *this* schema needs it to keep deciding the same question one hop out.
   */
  readonly origins: ReadonlyMap<string, string>;
}

/** Dependencies {@link linkSchema} needs beyond the {@link Schema} being linked. */
export interface LinkDeps {
  /**
   * Resolves one `!!import` URI to its already-**linked** namespace — `Schema.imports` entries,
   * called in that order. Omitted means "no loader": a schema with no `!!import` links
   * unaffected; one that declares any throws {@link TsonSchemaValidationError} the moment it is
   * reached, the same "no loader" contract `schemaResolver.ts`'s own `resolveImport` states.
   * Reuses that module's own {@link ImportResolver} type so both merge stages speak one shape.
   */
  readonly resolveImport?: ImportResolver;
  /**
   * The governing meta-schema's own entries (§3.3.1), consulted only as the `source`/composition-
   * supertype fallback `referenceValidation.ts` documents — never for an ordinary field/element/
   * variant reference (§3.3.2). Omitted means "no governing meta in scope" (the meta-kernel
   * bootstrap route), matching `resolveSchema`'s own `deps.metaDefinitions` in spirit; a caller
   * assembling both stages typically passes the same governing `LinkedSchema.entries` here that it
   * turned into a `DefinitionGetter` for `resolveSchema`.
   */
  readonly structureNamespace?: ReadonlyMap<string, TypeDefinition>;
  /**
   * Where a failing entry is reported, letting every other entry still be checked. Omitted means
   * fail-fast: the first {@link TsonSchemaValidationError} propagates, naming the entry that
   * failed.
   */
  readonly receiver?: DiagnosticsReceiver;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy, applied over [TSON-SCHEMA] §11.4's schema-layer
   * scopes (`nameHygiene.ts`'s own `checkNameHygiene`). Defaults to {@link DEFAULT_NAME_POLICY}
   * — mechanisms 1 and 2 enforced, mechanism 3 at Highly Restrictive over the whole name — the
   * same default every other name-hygiene call site in this package applies. A relaxation is a
   * caller's explicit code decision (§8.2 forbids relaxing one silently), passed here exactly
   * once per link rather than read from the environment.
   *
   * **Never pass a caller-relaxed policy when linking the meta-kernel bootstrap document
   * itself** (`schema/bootstrap.ts`'s `bootstrapMetaKernel` output) — the reference
   * implementation locks that one document to its own default regardless of what a caller
   * configures ("a policy should not be able to break meta-kernel"), and every call site in this
   * package that links it omits this field for exactly that reason. An *ordinary* schema
   * (meta.tn and core.tn included, once resolved the normal way rather than through the
   * bootstrap route) has no such restriction and may take a caller's own policy.
   */
  readonly namePolicy?: NamePolicy;
}

/**
 * Links `schema` — merges every `!!import`'s whole, already-linked namespace (diamonds unified by
 * origin), adds `schema`'s own local entries, populates `subtypes`, derives choice `disjoint` and
 * checks its `@disjoint` assertions, and validates that every reference in the result resolves.
 *
 * **Local-vs-import collision** (§2.2.3): a local name that already exists in the merged import
 * namespace is reported/thrown, and the *local* declaration is dropped from the result (an
 * import is already-linked, separately registered material — keeping it is what leaves the rest
 * of this schema checkable against something real).
 */
export function linkSchema(schema: Schema, deps: LinkDeps = {}): LinkedSchema {
  const { resolveImport, structureNamespace, receiver } = deps;
  const namePolicy = deps.namePolicy ?? DEFAULT_NAME_POLICY;

  const origins = new Map<string, string>();
  let merged = mergeImports(schema.imports, resolveImport, origins);

  const localNames = new Set<string>();
  const selfId = canonicalizeIdentity(schema.id);
  for (const [name, def] of schema.entries) {
    if (merged.has(name)) {
      const message = `'${name}' collides with an entry of the same name brought in by !!import`;
      if (receiver === undefined) {
        throw new TsonSchemaValidationError(message);
      }
      receiver.report({
        code: 'SCHEMA_ERROR',
        message,
        schemaId: schema.id,
        schemaPointer: `/${name}`,
        ...(def.position === undefined ? {} : { schemaPosition: def.position }),
      });
      continue; // the local entry is dropped, not the import's -- see this function's own doc
    }
    merged.set(name, def);
    origins.set(name, selfId);
    localNames.add(name);
  }

  merged = computeSubtypes(merged, localNames);
  merged = computeDisjointness(merged);

  checkNameHygiene(merged, {
    schemaId: schema.id,
    namePolicy,
    ...(receiver === undefined ? {} : { receiver }),
  });

  validateReferences(merged, {
    schemaId: schema.id,
    ...(structureNamespace === undefined ? {} : { structureNamespace }),
    ...(receiver === undefined ? {} : { receiver }),
  });
  checkDisjointAssertions(merged, localNames, {
    schemaId: schema.id,
    ...(receiver === undefined ? {} : { receiver }),
  });

  return {
    id: schema.id,
    meta: schema.meta,
    imports: schema.imports,
    entries: merged,
    keyAnnotations: schema.keyAnnotations,
    bootstrap: schema.bootstrap,
    origins,
  };
}

// ── Import merging (§2.2.3, diamonds included) ──────────────────────────────────────────────────

/**
 * Stage 1 of {@link linkSchema}: every `!!import`'s whole, already-**linked** namespace, in
 * declaration order, brought in as-is. The namespace is flat and the merge is transitive: an
 * import contributes everything its own `entries` holds, its own imports' entries included
 * (`LinkedSchema.entries`'s own contract), so a schema reached by two different `!!import` routes
 * — the diamond every practical schema forms by importing `core.tn` — arrives once, reconciled by
 * {@link unifySubtypes} rather than treated as a conflict.
 *
 * A collision is decided by entry identity, never by name occurrence: the same schema reached
 * through several routes is one set of entries (unified), two *different* schemas declaring one
 * name is the real collision and stays an error.
 */
function mergeImports(
  imports: readonly string[],
  resolveImport: ImportResolver | undefined,
  origins: Map<string, string>,
): Map<string, TypeDefinition> {
  const merged = new Map<string, TypeDefinition>();
  const alreadyImported = new Set<string>();
  for (const importUri of imports) {
    const importIdentity = canonicalizeIdentity(importUri);
    if (alreadyImported.has(importIdentity)) {
      continue; // a route repeating one already-merged identity contributes nothing new
    }
    alreadyImported.add(importIdentity);
    if (resolveImport === undefined) {
      throw new TsonSchemaValidationError(
        `'!!import:"${importUri}"' needs a schema loader to resolve, and this linker was built ` +
          'without one',
      );
    }
    const imported: ImportedSchema = resolveImport(importUri);
    for (const [name, definition] of imported.entries) {
      const origin = imported.originOf(name);
      const incumbent = origins.get(name);
      if (incumbent !== undefined) {
        if (incumbent !== origin) {
          throw new TsonSchemaValidationError(
            `'${name}' is declared by two different schemas reached through !!import ` +
              `('${incumbent}' and '${origin}') -- distinct types cannot share one name in the ` +
              `flat namespace; import one of them, or a version of each that agrees on where ` +
              `'${name}' is declared`,
          );
        }
        const existing = merged.get(name);
        merged.set(name, existing === undefined ? definition : unifySubtypes(existing, definition));
        continue;
      }
      merged.set(name, definition);
      origins.set(name, origin);
    }
  }
  return merged;
}
