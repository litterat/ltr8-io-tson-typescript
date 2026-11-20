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
 * `~`), and the reference-implementation's richer "walk back to the nearest positioned
 * declaration" error attribution (`referenceValidation.ts`'s own note).
 *
 * **`TypeInhabitance`'s productivity check** (§3.4.1, §5.10.1 — an entry no finite document can
 * satisfy) lives in {@link checkEveryEntryIsInhabited} (`typeInhabitance.ts`), run here over
 * every local entry after reference validation and before `@disjoint` checking, matching the
 * reference implementation's own placement in `TsonSchemaLinker`.
 *
 * **§5.2's discriminated-family coherence** (a selector's declared type, and the family's pin
 * distinctness) lives in {@link checkRecordExtension} (`recordExtension.ts`), run here right
 * after inhabitance for the same reason: it needs `subtypes` populated and every reference
 * already validated, and — unlike inhabitance — it is re-judged whenever any part of a family is
 * local, which is why it takes `localNames` too.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import {
  TsonInternalError,
  TsonNotImplementedError,
  TsonSchemaValidationError,
} from '../core/errors.js';
import type { ImportedSchema, ImportResolver, Schema } from '../compiler/schemaResolver.js';
import type { Normalization } from '../schema/meta/atoms-text.js';
import type { Annotations, EntryFacts, Restatement, Top } from '../schema/meta/typedef.js';
import { isParametric } from '../schema/meta/typedef.js';
import { isNestedMap, syncedEntries } from '../schema/meta/schemaPaths.js';
import { DEFAULT_IDENTIFIER_POLICY, type IdentifierPolicy } from '../unicode/policy.js';
import { canonicalizeIdentity } from './identity.js';
import { computeSubtypes, unifySubtypes } from './subtypes.js';
import { computeKindMembers } from './kindMembers.js';
import { checkFieldNameTypes, type FieldNameType } from './fieldNames.js';
import { schemaPositionOf } from './facts.js';
import { checkDisjointAssertions, computeDisjointness } from './disjointness.js';
import {
  checkEnumLabels,
  enumLabelForm,
  enumLabelProfile,
  type EnumLabelProfile,
} from './enumLabels.js';
import { checkNameHygiene } from './nameHygiene.js';
import { validateReferences } from './referenceValidation.js';
import { checkEveryEntryIsInhabited } from './typeInhabitance.js';
import { checkFieldGroups } from './fieldGroups.js';
import { checkRecordExtension } from './recordExtension.js';
import { checkKindsReferencesAndNamespaceTypes } from './namespaceTypes.js';
import { checkValuesByName, ValuesByName } from './valuesByName.js';
import { checkRestatementsOffTheChain } from './restatedFields.js';
import { attachExterns, type ExternSchemaLoader } from './externLink.js';
import { externHops } from './externHops.js';
import { checkExternVariants } from './externChecks.js';
import type { ExternTarget } from './externTarget.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/**
 * A linked schema (Part 2 §2.2.3, §8): {@link Schema}'s own three header fields, carried through
 * unchanged, plus the **flat, fully-merged** namespace — every entry this schema can see, local
 * *and* imported, its derived indexes (`chain.subtypes`, a choice's `disjoint`, a kind's
 * `members`) populated — the facts beside each entry, and the origin schema id each entry's own
 * identity is keyed against.
 *
 * Unlike {@link Schema.entries} (local-only, by that interface's own contract), `entries` here is
 * the whole closure: an importer of *this* schema takes every one of these, exactly as-is, never
 * re-validating or re-resolving them (§2.2.3's "merged entries keep their home namespace").
 */
export interface LinkedSchema {
  readonly id: string;
  readonly imports: readonly string[];
  /** Every entry this schema can see: this schema's own declarations plus every `!!import`'s, transitively. */
  readonly entries: ReadonlyMap<string, Top>;
  /** Each entry's facts beyond its value (§8.1), local and imported alike -- present only for a name with any recorded. */
  readonly facts: ReadonlyMap<string, EntryFacts>;
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
  /**
   * Each enum among `entries` that matches in a form other than `NONE`, by name: its label type's
   * `normalization` ([TSON-SCHEMA] §5.5, §7.4), so `Content-Type` is the member written
   * `content-type` under a case-folding type. Local and imported enums alike.
   */
  readonly enumForms: ReadonlyMap<string, Normalization>;
  /**
   * Each record among `entries` that states a `name_type`, with the identifier family its field
   * names are values of ([TSON-SCHEMA] §5.2) -- resolved where the record was declared, so an
   * importer reads an imported record's names as its own schema did. A record absent here has the
   * kernel's `meta.identifier`. Local and imported records alike.
   */
  readonly nameTypes: ReadonlyMap<string, FieldNameType>;
  /**
   * The fields each entry restates over a source its closed chain does not reach (§5.8, §5.9), as its schema's
   * resolution settled them -- local and imported alike, present only for an entry with any. An importer that
   * absorbs an application of an imported parametric record takes the record's restatements with it. Absent
   * means none.
   */
  readonly restatements?: ReadonlyMap<string, readonly Restatement[]>;
  /**
   * Each extern among `entries` attached to the foreign entry it lands on (§5.13) -- local and imported alike, as
   * each one's own link attached it. A fact of the link, never of the extern's value, which states only what was
   * written. An extern its link refused is absent, and lands nowhere. Absent means none.
   */
  readonly externs?: ReadonlyMap<string, ExternTarget>;
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
   * Where a failing entry is reported, letting every other entry still be checked. Omitted means
   * fail-fast: the first {@link TsonSchemaValidationError} propagates, naming the entry that
   * failed.
   */
  readonly receiver?: DiagnosticsReceiver;
  /**
   * [TSON-DATA] §8.2's name-hygiene policy, applied over [TSON-SCHEMA] §11.4's schema-layer
   * scopes (`nameHygiene.ts`'s own `checkNameHygiene`). Defaults to {@link DEFAULT_IDENTIFIER_POLICY}
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
  readonly identifierPolicy?: IdentifierPolicy;
  /**
   * Judges the dependent values the schema's value entries hold as written (§5.2) against the type each
   * one's sibling names, once the rest of the link is clean. A judgement is a read, which compiles the
   * linked schema, so it is supplied by the caller that has the readers (`compiler/heldValues.ts`) and
   * `link/` names none. Omitted means the held values are not judged, which is what a schema holding none
   * needs.
   */
  readonly heldValues?: HeldValueJudge;
  /**
   * The linked schema of a canonical identity an extern names (§5.13), loaded with this schema's imports before it
   * resolved. Omitted loads nothing, and every local extern is refused as not loaded.
   */
  readonly externSchema?: ExternSchemaLoader;
}

/** {@link LinkDeps.heldValues}: refusals and gaps are handed to `report` with the entry holding the value. */
export type HeldValueJudge = (
  linked: LinkedSchema,
  localNames: ReadonlySet<string>,
  report: (entry: string, error: TsonSchemaValidationError | TsonNotImplementedError) => void,
) => void;

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
  const { resolveImport } = deps;
  // Held values are judged only once everything else linked clean, so a refusal anywhere stops there.
  const state = { refused: false };
  const receiver: DiagnosticsReceiver | undefined =
    deps.receiver === undefined
      ? undefined
      : {
          report(diagnostic) {
            state.refused = true;
            deps.receiver?.report(diagnostic);
          },
        };
  const identifierPolicy = deps.identifierPolicy ?? DEFAULT_IDENTIFIER_POLICY;

  const origins = new Map<string, string>();
  const enumForms = new Map<string, Normalization>();
  const facts = new Map<string, EntryFacts>();
  const nameTypes = new Map<string, FieldNameType>();
  const restatements = new Map<string, readonly Restatement[]>();
  // Each extern of the namespace with the foreign entry it lands on: an import's as its own link attached it.
  const externs = new Map<string, ExternTarget>();
  let merged = mergeImports(
    schema.imports,
    resolveImport,
    origins,
    enumForms,
    facts,
    nameTypes,
    restatements,
    externs,
  );

  const localNames = new Set<string>();
  const selfId = canonicalizeIdentity(schema.id);
  for (const [name, def] of schema.entries) {
    // A schema map of one path is open: this document's contribution to an imported one is no collision, its
    // members colliding by path as any name does (§2.2.3); the union is rebuilt once every entry is in.
    if (merged.has(name) && isNestedMap(merged.get(name)) && isNestedMap(def)) {
      origins.set(name, selfId);
      localNames.add(name);
      merged.set(name, def);
      continue;
    }
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
        ...schemaPositionOf(schema.facts, name),
      });
      continue; // the local entry is dropped, not the import's -- see this function's own doc
    }
    merged.set(name, def);
    origins.set(name, selfId);
    localNames.add(name);
    const recorded = schema.facts.get(name);
    if (recorded !== undefined) facts.set(name, recorded);
    const restated = schema.restatements?.get(name);
    if (restated !== undefined) restatements.set(name, restated);
  }

  attachExterns(merged, localNames, deps.externSchema, externs, (name, error) => {
    if (receiver === undefined) throw error;
    receiver.report({
      code: 'SCHEMA_ERROR',
      message: error.message,
      schemaId: schema.id,
      schemaPointer: `/${name}`,
      ...schemaPositionOf(schema.facts, name),
    });
  });
  // Each nested map holds the union of the members its closure declares (§2.2.3).
  merged = new Map(syncedEntries({ entries: merged, keyAnnotations: new Map() }).entries);
  // Every judgement through an extern is made of the entry it lands on, by identity (§5.13).
  const hops = externHops(
    (name) => merged.get(name),
    (name) => origins.get(name) ?? selfId,
    externs,
  );
  merged = computeSubtypes(merged, localNames);
  // A reference read in data names an entry of the final namespace, assembled below, and a name read under a
  // reference that names values reaches a value of it: both are lookups the index holds until the link ends.
  const closure: { current: ReadonlyMap<string, Top> } = { current: new Map() };
  const reached: { current?: ValuesByName } = {};
  merged = computeKindMembers(merged, {
    hops,
    facts: (name) => facts.get(name),
    entries: {
      get: (name) => closure.current.get(name),
      has: (name) => closure.current.has(name),
    },
    values: (of) => (where, name) => {
      if (reached.current === undefined) {
        throw new TsonInternalError(
          `'${name}' is read under 'meta.ref<${of}>' before the schema linking it has assembled its namespace`,
        );
      }
      return reached.current.reach(where, name, of);
    },
  });

  // Before disjointness: an enum whose members are texts is string-class, and only here can its
  // `name_type` be followed into the governing meta, where a constructor's pinned one was written.
  const entryOf = (name: string): Top | undefined => merged.get(name);
  // One namespace per schema (§3.3): every name, a constructor's included, resolves in `merged`.
  const structureOf = (name: string): Top | undefined => merged.get(name);
  const enumProfiles = new Map<string, EnumLabelProfile>();
  // The constructor an entry applied, from its facts -- the schema's own or the governing meta's.
  const headOf = (name: string): string | undefined => facts.get(name)?.head;
  for (const name of localNames) {
    const definition = merged.get(name);
    if (definition?.kind !== 'enum') {
      continue;
    }
    const head = facts.get(name)?.head;
    const enumeration = head === undefined ? { value: definition } : { value: definition, head };
    const labelProfile = enumLabelProfile(enumeration, entryOf, structureOf, headOf);
    if (labelProfile !== undefined) enumProfiles.set(name, labelProfile);
    const form = enumLabelForm(enumeration, entryOf, structureOf, headOf);
    if (form !== 'NONE') enumForms.set(name, form);
  }
  merged = computeDisjointness(merged, hops);
  checkExternVariants(merged, localNames, hops, {
    schemaId: schema.id,
    facts,
    ...(receiver === undefined ? {} : { receiver }),
  });

  // Before the name checks: a member that is not a value of its enum's type is the more basic
  // verdict, and the per-name rules would otherwise report it as a restricted character.
  const refusedEnums = new Set<string>();
  for (const violation of checkEnumLabels(merged, localNames, structureOf, headOf)) {
    refusedEnums.add(violation.entry);
    if (receiver === undefined) throw new TsonSchemaValidationError(violation.message);
    receiver.report({
      code: 'SCHEMA_ERROR',
      message: violation.message,
      schemaId: schema.id,
      schemaPointer: `/${violation.entry}`,
      ...schemaPositionOf(facts, violation.entry),
    });
  }

  // Before the name checks too: a field name its record's name type does not admit is no name,
  // and judging it under the hygiene rules as well would report one mistake twice.
  const fieldNameTypes = checkFieldNameTypes(merged, localNames, structureOf);
  for (const [name, nameType] of fieldNameTypes.nameTypes) nameTypes.set(name, nameType);
  for (const violation of fieldNameTypes.violations) {
    refusedEnums.add(violation.entry);
    if (receiver === undefined) throw new TsonSchemaValidationError(violation.message);
    receiver.report({
      code: 'SCHEMA_ERROR',
      message: violation.message,
      schemaId: schema.id,
      schemaPointer: `/${violation.entry}`,
      ...schemaPositionOf(facts, violation.entry),
    });
  }

  checkNameHygiene(merged, {
    schemaId: schema.id,
    facts,
    identifierPolicy,
    refusedEnums,
    enumProfiles,
    nameTypes,
    ...(receiver === undefined ? {} : { receiver }),
  });

  checkFieldGroups(merged, localNames, {
    schemaId: schema.id,
    facts,
    ...(receiver === undefined ? {} : { receiver }),
  });

  validateReferences(merged, {
    schemaId: schema.id,
    facts,
    enumForms,
    structureNamespace: merged,
    ...(receiver === undefined ? {} : { receiver }),
  });
  checkKindsReferencesAndNamespaceTypes(merged, localNames, {
    hops,
    schemaId: schema.id,
    facts,
    structureNamespace: merged,
    ...(receiver === undefined ? {} : { receiver }),
  });
  checkValuesByName(merged, localNames, {
    hops,
    schemaId: schema.id,
    facts,
    structureNamespace: merged,
    structureFacts: facts,
    ...(receiver === undefined ? {} : { receiver }),
  });
  // §5.8's rule over the restatements the closed chain does not reach, each local closed entry's.
  for (const [name, found] of schema.restatements ?? []) {
    if (!localNames.has(name) || isParametric(merged.get(name))) continue;
    try {
      checkRestatementsOffTheChain(name, found, merged);
    } catch (error: unknown) {
      if (!(error instanceof TsonSchemaValidationError)) throw error;
      if (receiver === undefined) throw error;
      receiver.report({
        code: 'SCHEMA_ERROR',
        message: error.message,
        schemaId: schema.id,
        schemaPointer: `/${name}`,
        ...schemaPositionOf(facts, name),
      });
    }
  }
  checkEveryEntryIsInhabited(merged, localNames, {
    schemaId: schema.id,
    facts,
    ...(receiver === undefined ? {} : { receiver }),
  });
  checkRecordExtension(merged, localNames, {
    schemaId: schema.id,
    facts,
    keyAnnotations: schema.keyAnnotations,
    origins,
    ...(receiver === undefined ? {} : { receiver }),
  });
  checkDisjointAssertions(merged, localNames, {
    schemaId: schema.id,
    facts,
    // §6's name-position channel as well as §3.1's value-position one: `@disjoint` written
    // before a declared name is the same assertion as one written on its body, and a marker
    // this check could not see would be a marker nothing ever contradicts.
    keyAnnotations: schema.keyAnnotations,
    ...(receiver === undefined ? {} : { receiver }),
  });

  closure.current = merged;
  reached.current = new ValuesByName(merged, {
    hops,
    schemaId: schema.id,
    facts,
    structureNamespace: merged,
    structureFacts: facts,
  });

  const linked: LinkedSchema = {
    id: schema.id,
    imports: schema.imports,
    entries: merged,
    facts,
    keyAnnotations: schema.keyAnnotations,
    bootstrap: schema.bootstrap,
    origins,
    enumForms,
    nameTypes,
    restatements,
    externs,
  };
  if (deps.heldValues !== undefined && !state.refused) {
    deps.heldValues(linked, localNames, (entry, error) => {
      if (receiver === undefined) throw error;
      receiver.report({
        code: error instanceof TsonNotImplementedError ? 'NOT_IMPLEMENTED' : 'SCHEMA_ERROR',
        message: error.message,
        schemaId: schema.id,
        schemaPointer: `/${entry}`,
        ...schemaPositionOf(facts, entry),
      });
    });
  }
  return linked;
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
  enumForms: Map<string, Normalization>,
  facts: Map<string, EntryFacts>,
  nameTypes: Map<string, FieldNameType>,
  restatements: Map<string, readonly Restatement[]>,
  externs: Map<string, ExternTarget>,
): Map<string, Top> {
  const merged = new Map<string, Top>();
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
    for (const [name, form] of imported.enumForms ?? []) enumForms.set(name, form);
    for (const [name, nameType] of imported.nameTypes ?? []) nameTypes.set(name, nameType);
    for (const [name, definition] of imported.entries) {
      const origin = imported.originOf(name);
      const incumbent = origins.get(name);
      // A schema map of one path declared by several documents is one map, the union of their members,
      // each merged under its path; the map's entry is derived from them (§2.2.3).
      if (incumbent !== undefined && isNestedMap(merged.get(name)) && isNestedMap(definition)) {
        continue;
      }
      if (incumbent !== undefined) {
        const existing = merged.get(name);
        if (incumbent !== origin) {
          throw new TsonSchemaValidationError(
            `'${name}' is declared by two different schemas reached through !!import ` +
              `('${incumbent}' and '${origin}') -- distinct types cannot share one name in the ` +
              `one namespace; import one of them, or a version of each that agrees on where ` +
              `'${name}' is declared`,
          );
        }
        merged.set(name, existing === undefined ? definition : unifySubtypes(existing, definition));
        continue;
      }
      merged.set(name, definition);
      origins.set(name, origin);
      const recorded = imported.facts?.get(name);
      if (recorded !== undefined) facts.set(name, recorded);
      const restated = imported.restatements?.get(name);
      if (restated !== undefined) restatements.set(name, restated);
      const attached = imported.externs?.get(name);
      if (attached !== undefined) externs.set(name, attached);
    }
  }
  return merged;
}
