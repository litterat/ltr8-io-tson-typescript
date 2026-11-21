/**
 * §5.2's discriminated-family coherence check, over a whole linked namespace — the "Over the
 * family" paragraph: every entry in an ABSTRACT base's `subtypes`, transitively, restates each
 * marked field FIXED, and — over the base's *direct* members, the set a read actually dispatches
 * among (this file's own "One level" note below) — the pins are pairwise distinct as values (as
 * tuples, where a base marks several fields), under the field type's own equality (§5.5, §5.7),
 * decoded through the same parser a read uses rather than compared as spelled tokens. The
 * base-level structural facts §5.2 states about a selector — its declared type resolves to an
 * atom-family instance or an enum — are checked here too, since only a link-time pass can follow a
 * field's alias chain against the whole merged namespace (`aliasChain.ts`'s own
 * `terminalDefinition`).
 *
 * This module's own shape follows this package's existing linker passes (`typeInhabitance.ts`,
 * `disjointness.ts`).
 *
 * **What is already enforced elsewhere, and so is not re-checked here:**
 *
 * - A selector's name is unmarked and its type non-voidable, it carries no value, and `=?` can
 *   never be acquired by refinement or land on a group member — all four are refused at
 *   declaration time, structurally (`fieldModifiers.ts`'s own `resolveFieldMarks`,
 *   `definitionResolver.ts`'s own `resolveTighteningField`) or by grammar (`GroupMember` has no
 *   modifier slot at all, `ast/schema/fields.ts`). A selector reaching this module already carries
 *   all four facts; this module only adds the one fact declaration time cannot check — what the
 *   field's own declared type resolves to.
 * - `=?` implying `ABSTRACT`, and `final` beside one being refused, are both
 *   `definitionResolver.ts`'s own `applyDefinitionMark` (a fact about one declaration, checked the
 *   moment its mark is read).
 * - FINAL's composition/refinement refusal is `definitionResolver.ts`'s own (§5.2, §5.9) — a fact
 *   about one declaration's own operator, not about a family.
 *
 * **One level, by construction.** {@link directMembers} finds only a base's *direct* composers or
 * refiners — never `the chain's `subtypes``' full transitive closure, which also holds every
 * descendant several generations down. A grandchild inherits its parent's pin unchanged (§5.7's
 * identity rule forbids a restatement from changing one), so it legitimately shares that pin —
 * checking distinctness over the transitive set would flag every such grandchild as a collision
 * with its own parent, contradicting §5.2's own "a family discriminates one level: a subtype of a
 * member inherits the member's pin ... and dispatches to its parent". Distinctness is therefore
 * checked over direct members only, which is also the set a member-dispatched read actually
 * chooses among (`compiler/subsumption.ts`).
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import { isAtom } from '../compiler/atomChecks.js';
import { buildAtomReader } from '../compiler/atomBuilder.js';
import { terminal, terminalDefinition } from './aliasChain.js';
import type { TypeReader } from '../reader/contracts.js';
import { valuesEqual } from '../reader/tree/equality.js';
import { readSchemaLiteral } from '../reader/tree/support.js';
import type { RecordBody, RecordField } from '../schema/meta/bodies.js';
import { typeNameOf } from '../schema/meta/bodies.js';
import {
  applicationOf,
  isParametric,
  supertypesOf,
  type Annotations,
  type Top,
} from '../schema/meta/typedef.js';
import type { Value } from '../tree/nodes.js';
import type { FactsTable } from './facts.js';

/** Whether `body` is a record. */
function isRecordBody(body: Top): body is RecordBody {
  return body.kind === 'record';
}

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/** Dependencies {@link checkRecordExtension} needs beyond the merged namespace itself. */
export interface CheckRecordExtensionOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /**
   * The schema each entry of `merged` was declared by, as `LinkedSchema.origins` states it. A
   * family judged over the closure names where two colliding members came from (§3.3.4).
   */
  readonly origins?: ReadonlyMap<string, string>;
  /**
   * Where a failing family is reported, letting every other one still be checked. Omitted means
   * fail-fast: the first {@link TsonSchemaValidationError} propagates.
   */
  readonly receiver?: DiagnosticsReceiver;
  /** Each entry's recorded facts (§8.1). */
  readonly facts?: FactsTable;
  /** Each entry's key annotations. */
  readonly keyAnnotations?: ReadonlyMap<string, Annotations>;
}

/**
 * Judges every family of `merged` (§5.2) and every parametric record's selectors (§5.10).
 *
 * A parametric record's selector types name no parameter, so every application states the same selectors: they are
 * judged once, at its declaration, applied or not, and an application declared under a name repeats its head's
 * verdict, so a declared application of a refused one is not judged again. A family over a parametric record's
 * application is judged where the application closes.
 */
export function checkRecordExtension(
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  options: CheckRecordExtensionOptions,
): void {
  // Every family in the closure is judged, not only one with a part declared here (§3.3.4): two
  // schemas that each link cleanly can each add a member to one imported family, and the schema
  // importing both holds a family neither did.
  const refused = new Set<string>();
  for (const [name, def] of merged) {
    if (!isRecordBody(def) || def.discriminators === undefined) continue;
    if (isParametric(def)) {
      if (!selectorsAreAtoms(name, def.discriminators, selectorOf(def), merged, options)) {
        refused.add(name);
      }
      continue;
    }
    const head = appliedHead(name, merged, options.keyAnnotations);
    if (head !== undefined && refused.has(head)) continue;
    checkFamily(name, def.discriminators, selectorOf(def), merged, localNames, options);
  }
}

/** The parametric record a declared application applies, past its head's alias hops (§8.3); `undefined` otherwise. */
function appliedHead(
  name: string,
  merged: ReadonlyMap<string, Top>,
  keyAnnotations: ReadonlyMap<string, Annotations> | undefined,
): string | undefined {
  const application = applicationOf(keyAnnotations?.get(name));
  if (application === undefined) return undefined;
  const head = terminal(application.head.name, (n) => merged.get(n));
  return isParametric(merged.get(head)) ? head : undefined;
}

/** Whether every selector of `baseName` is typed by an atom-family instance or an enum (§5.2), reporting each that is not. */
function selectorsAreAtoms(
  baseName: string,
  discriminators: readonly string[],
  selectorField: (fieldName: string) => RecordField | undefined,
  merged: ReadonlyMap<string, Top>,
  options: CheckRecordExtensionOptions,
): boolean {
  let ok = true;
  for (const fieldName of discriminators) {
    if (
      checkSelectorType(baseName, fieldName, selectorField(fieldName), merged, options) ===
      undefined
    ) {
      ok = false;
    }
  }
  return ok;
}

// ── A family member is declared (§5.2, §8.2) ─────────────────────────────────────────────────

// ── Direct membership ────────────────────────────────────────────────────────────────────────

/** One direct member of a family, as {@link directMembers} finds it. */
export interface Member {
  readonly name: string;
  readonly body: RecordBody;
}

/**
 * `baseName`'s own direct composers/refiners — the members its selector(s) actually discriminate
 * among (§5.2's "one level"). Filtered to the direct edge, over every record entry `merged` holds:
 * a composition names the base — or an alias of it — in its own `record.supertypes` (the body's
 * authorial list, §5.8), a refinement names it as the entry's own `source` (§5.7) — the two
 * spellings a member may take, since a refinement admits no new fields and so may still pin an
 * inherited selector with none of its own. Either spelling is followed through its own reference
 * chain (§8.3) before comparing to `baseName`: `ba => b; m1 => ba & { ... }` composes onto `b`
 * exactly as `m1 => b & { ... }` would — an alias is a hop, not a different type — so `m1`'s
 * `supertypes` entry, `ba`, is resolved to its terminal before the comparison, the same way
 * `compiler/subsumption.ts`'s own `selfNames` resolves an annotation's name before comparing it.
 *
 * **Scans `merged` directly rather than `baseDef.subtypes`.** That index is `link/subtypes.ts`'s
 * own reverse of `the chain's `supertypes``, computed over the *un-dereferenced* name each entry
 * recorded (`definitionResolver.ts`'s own composition resolver keeps the author's own spelling
 * there deliberately — "the composed vocabulary is the terminal's while the recorded name is the
 * author's"). `m1 => ba & { ... }` above therefore records `supertypes: ['ba']`, never `'b'`, so
 * `subtypes.ts`'s reverse index credits `ba` (not `b`) with `m1` as a subtype — correct for that
 * index's own purpose, but exactly the alias step this function exists to see through, so relying
 * on it here would silently drop every member reached through one.
 *
 * Exported for `compiler/subsumption.ts`'s own member-dispatch reader, which needs exactly the
 * same "one level" set — the members a read actually chooses among (§5.2) — computed the same
 * way, rather than a second, drifting copy of this walk.
 */
export function directMembers(
  baseName: string,
  merged: ReadonlyMap<string, Top>,
  excluded: (name: string) => boolean = () => false,
): readonly Member[] {
  const lookup = (n: string): Top | undefined => merged.get(n);
  const members: Member[] = [];
  for (const [candidateName, candidate] of merged) {
    if (candidateName === baseName) continue;
    // A parametric record IS-A the base is no member: its applications are, each pinned once closed.
    if (!isRecordBody(candidate) || isParametric(candidate)) continue;
    if (excluded(candidateName)) continue;
    const chain = supertypesOf(candidate);
    if (!chain.some((ref) => terminal(ref, lookup) === baseName)) continue;
    // The direct edge: no other entry of the chain is itself a member below the base. A parametric
    // record in the chain is no member (its applications are).
    const throughAnother = chain.some((ref) => {
      const end = terminal(ref, lookup);
      if (end === baseName) return false;
      const value = merged.get(end);
      return (
        value !== undefined &&
        !isParametric(value) &&
        supertypesOf(value).some((above) => terminal(above, lookup) === baseName)
      );
    });
    if (!throughAnother) members.push({ name: candidateName, body: candidate });
  }
  return members;
}

// ── One family ───────────────────────────────────────────────────────────────────────────────

/** A closed base's selector field by name: the base declares it itself. */
function selectorOf(baseBody: RecordBody): (fieldName: string) => RecordField | undefined {
  return (fieldName) => baseBody.fields.entries.get(fieldName);
}

function checkFamily(
  baseName: string,
  discriminators: readonly string[],
  selectorField: (fieldName: string) => RecordField | undefined,
  merged: ReadonlyMap<string, Top>,
  localNames: ReadonlySet<string>,
  options: CheckRecordExtensionOptions,
): void {
  const fieldReaders = new Map<string, TypeReader<Value>>();
  let selectorsOk = true;
  for (const fieldName of discriminators) {
    const fieldReader = checkSelectorType(
      baseName,
      fieldName,
      selectorField(fieldName),
      merged,
      options,
    );
    if (fieldReader === undefined) {
      selectorsOk = false;
      continue;
    }
    fieldReaders.set(fieldName, fieldReader);
  }
  if (!selectorsOk) {
    // Already reported, at the base: a pin cannot be safely decoded through a type that isn't
    // one (§5.2's own base-level check, above), and every discriminator is checked before any
    // pin is, so a family with a bad selector never reaches the pin-distinctness check below at
    // all -- avoiding a second, spurious diagnostic stacked on the real one.
    return;
  }

  const members = directMembers(baseName, merged);
  const pinned: { readonly name: string; readonly values: readonly Value[] }[] = [];
  for (const member of members) {
    const values = pinsFor(baseName, member, discriminators, fieldReaders, options);
    if (values !== undefined) pinned.push({ name: member.name, values });
  }

  for (let i = 0; i < pinned.length; i += 1) {
    for (let j = i + 1; j < pinned.length; j += 1) {
      const a = pinned[i];
      const b = pinned[j];
      if (a === undefined || b === undefined) continue; // array bounds; unreachable given the loop
      if (tuplesEqual(a.values, b.values)) {
        const tuple = discriminators.join(', ');
        const named =
          discriminators.length > 1 ? `discriminators (${tuple})` : `discriminator '${tuple}'`;
        // Blamed against whichever of the two colliding members this schema itself declares --
        // an importing schema that adds a member colliding with one it imported broke the
        // family, not the schema that declared the other side of the collision (§5.2, "in the
        // importing schema, which is the schema that broke it"). Where neither is local the merge
        // is what put them in one family, and the schema itself is blamed, naming both origins.
        const blame = localNames.has(a.name) ? a.name : localNames.has(b.name) ? b.name : undefined;
        const origins = options.origins;
        const merge =
          blame === undefined && origins !== undefined
            ? ` Each is declared by a schema this one imports ('${origins.get(a.name) ?? '?'}' and ` +
              `'${origins.get(b.name) ?? '?'}'), and importing both is what puts them in one family (§3.3.4).`
            : '';
        fail(
          options,
          `'${a.name}' and '${b.name}' both pin '${baseName}''s ${named} to the same value -- the ` +
            `pins of a sealed family must be pairwise distinct (§5.2).${merge}`,
          blame,
        );
      }
    }
  }
}

/**
 * `member`'s own FIXED value for each of `discriminators`, decoded through `fieldReaders` (one
 * per discriminator, all the BASE's own declared type — §5.2's "a decoder parses them with the
 * one set of types it knows before dispatch", the same reason `compiler/subsumption.ts`'s own
 * read-time dispatch decodes through the base's field types too) — or `undefined` (having already
 * reported) when `member` leaves one unpinned, or when a pin that eager resolution should already
 * have validated somehow still fails to parse here (excluded from the distinctness check rather
 * than re-diagnosed, mirroring `compiler/subsumption.ts`'s own `candidatePins`). §5.7's identity
 * rule (a restatement MUST NOT change a pin) is what makes it safe to read a pin straight off
 * `member.body.fields` without re-deriving anything: whatever FIXED value a member's own field
 * carries is the value it pins, full stop.
 */
function pinsFor(
  baseName: string,
  member: Member,
  discriminators: readonly string[],
  fieldReaders: ReadonlyMap<string, TypeReader<Value>>,
  options: CheckRecordExtensionOptions,
): readonly Value[] | undefined {
  const values: Value[] = [];
  for (const fieldName of discriminators) {
    const field = member.body.fields.entries.get(fieldName);
    if (field?.role !== 'FIXED' || field.value === undefined) {
      fail(
        options,
        `'${member.name}' does not pin '${baseName}''s discriminator '${fieldName}' -- every ` +
          "member of a sealed family states its own value for each selector, with '=' (§5.2)",
        member.name,
      );
      return undefined;
    }
    const parser = fieldReaders.get(fieldName);
    if (parser === undefined) return undefined; // unreachable: checkFamily already bailed above
    try {
      values.push(readSchemaLiteral(field.value, parser));
    } catch {
      return undefined;
    }
  }
  return values;
}

/** Pairwise value equality (§5.5) over two decoded pin tuples, taken in the base's own declaration order. */
function tuplesEqual(a: readonly Value[], b: readonly Value[]): boolean {
  return a.length === b.length && a.every((value, i) => valuesEqual(value, requireAt(b, i)));
}

function requireAt<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new Error('internal error: tuplesEqual compared arrays of unequal length');
  }
  return value;
}

// ── Base-level selector checks ───────────────────────────────────────────────────────────────

/**
 * §5.2: "the marked field's declared type resolves, after its alias chain, to an atom-family
 * instance or an enum" — the one base-level fact declaration time cannot check, since it needs
 * the field's type resolved against the whole merged namespace. Every other base-level fact
 * (unmarked name, non-voidable type, no value, no group membership) is structurally guaranteed
 * before a selector ever reaches this module; see this file's own top note.
 *
 * Returns the compiled atom/enum reader for `fieldName`'s own declared type on success — built
 * directly off the resolved terminal body (`compiler/atomBuilder.ts`'s own `buildAtomReader`,
 * needing nothing a compiled schema would add) — so {@link pinsFor} and this module's own pin
 * comparison decode every member's pin, and the document's own value at read time
 * (`compiler/subsumption.ts`), through the identical parser rather than two that could drift.
 */
function checkSelectorType(
  baseName: string,
  fieldName: string,
  field: RecordField | undefined,
  merged: ReadonlyMap<string, Top>,
  options: CheckRecordExtensionOptions,
): TypeReader<Value> | undefined {
  if (field === undefined) {
    // `discriminators` is populated by the same resolver pass that populates `fields`
    // (`definitionResolver.ts`'s own `resolveEntry`), always from a name it just pushed into
    // `fields` -- this is an invariant of that resolver, never a document-level defect.
    throw new Error(
      `internal error: '${baseName}' names '${fieldName}' in 'discriminators' but declares no ` +
        'such field',
    );
  }
  const terminalDef = terminalDefinition(typeNameOf(field), (n) => merged.get(n));
  if (terminalDef === undefined || !isAtom(terminalDef)) {
    fail(
      options,
      `'${baseName}': the discriminator '${fieldName}' is typed '${typeNameOf(field)}', which is ` +
        'not an atom-family instance or an enum -- a selector MUST resolve, after its reference ' +
        'chain, to one of those (§5.2)',
      baseName,
    );
    return undefined;
  }
  return buildAtomReader(typeNameOf(field), terminalDef);
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────────

function fail(
  options: CheckRecordExtensionOptions,
  message: string,
  pointerName: string | undefined,
): void {
  const { schemaId, receiver } = options;
  if (receiver === undefined) {
    // A thrown error has no pointer to carry, so the declaration it is reported against is named
    // in the message.
    throw new TsonSchemaValidationError(
      pointerName === undefined ? message : `${message} (in the declaration of '${pointerName}')`,
    );
  }
  receiver.report({
    code: 'SCHEMA_ERROR',
    message,
    schemaId,
    ...(pointerName === undefined ? {} : { schemaPointer: `/${pointerName}` }),
  });
}
