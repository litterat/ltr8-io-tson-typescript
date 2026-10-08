/**
 * §5.2's discriminated-family coherence check, over a whole linked namespace — the "Over the
 * family" paragraph: every entry in an ABSTRACT base's `subtypes`, transitively, restates each
 * marked field FIXED, and — over the base's *direct* members, the set a read actually dispatches
 * among (this file's own "One level" note below) — the pins are pairwise distinct as values (as
 * tuples, where a base marks several fields), under the field type's own equality (§5.5, §5.7),
 * decoded through the same parser a read uses rather than compared as spelled tokens. The
 * base-level structural facts §5.2 states about a selector — its declared type resolves to an
 * atom-family instance or an enum — are checked here too, since only a link-time pass can follow a
 * field's reference chain against the whole merged namespace (`referenceChain.ts`'s own
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
 * refiners — never `TypeDefinition.subtypes`' full transitive closure, which also holds every
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
import { terminal, terminalDefinition } from './referenceChain.js';
import type { TypeReader } from '../reader/contracts.js';
import { valuesEqual } from '../reader/tree/equality.js';
import { readSchemaLiteral } from '../reader/tree/support.js';
import type { RecordBody, RecordField } from '../schema/meta/bodies.js';
import type { Top, TypeDefinition } from '../schema/meta/typedef.js';
import type { Value } from '../tree/nodes.js';

// `Top`'s own union mixes closed literal-`kind` members with one open one (`Data.kind: string`,
// `compiler/compile.ts`'s own note) -- a plain `'kind' in body && body.kind === 'record'` cannot
// exclude `Data` from narrowing, so every check in this module goes through this guard instead,
// the same pattern `compile.ts`'s own `isRecordBody` uses.
function isRecordBody(body: Top): body is RecordBody {
  return 'kind' in body && body.kind === 'record';
}

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/** Dependencies {@link checkRecordExtension} needs beyond the merged namespace itself. */
export interface CheckRecordExtensionOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /**
   * Where a failing family is reported, letting every other one still be checked. Omitted means
   * fail-fast: the first {@link TsonSchemaValidationError} propagates.
   */
  readonly receiver?: DiagnosticsReceiver;
}

/**
 * §5.2's family coherence, checked over every record entry `merged` can see that names
 * `discriminators` — imported and local alike, since a member added by *this* schema can break a
 * family whose base an import declared.
 *
 * **Re-judged only where some part of the family is local.** A family entirely inherited from an
 * import was already judged, in full, when that import's own schema linked — re-running the same
 * verdict over unchanged entries would find nothing new and cost a pass over the whole namespace
 * for no reason. A base declared here, or a member composing onto an imported base from here,
 * both count as "local" for this purpose (`isFamilyLocal`), matching §5.2's own "the family is
 * re-judged whenever any part of it is local ... in the importing schema, which is the schema
 * that broke it".
 *
 * Must run after reference validation, so an unresolved selector type is already reported and
 * never re-diagnosed as "not an atom or enum". Does **not** depend on
 * {@link import('./subtypes.js').computeSubtypes}: {@link directMembers} finds a family's members
 * by scanning `merged` directly (see its own note on why `TypeDefinition.subtypes` is not a safe
 * shortcut here), so this check needs no particular pass to have run before it beyond that.
 */
export function checkRecordExtension(
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
  options: CheckRecordExtensionOptions,
): void {
  for (const [name, def] of merged) {
    const body = def.body;
    if (!isRecordBody(body) || body.discriminators === undefined) {
      continue;
    }
    if (!isFamilyLocal(name, merged, localNames)) {
      continue;
    }
    checkFamily(name, body, merged, localNames, options);
  }
}

// ── Locality gate ────────────────────────────────────────────────────────────────────────────

/** Whether `baseName`'s declaration, or any of its direct members, is local to this schema. */
function isFamilyLocal(
  baseName: string,
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
): boolean {
  if (localNames.has(baseName)) return true;
  return directMembers(baseName, merged).some((member) => localNames.has(member.name));
}

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
 * own reverse of `TypeDefinition.supertypes`, computed over the *un-dereferenced* name each entry
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
  merged: ReadonlyMap<string, TypeDefinition>,
): readonly Member[] {
  const lookup = (n: string): TypeDefinition | undefined => merged.get(n);
  const members: Member[] = [];
  for (const [candidateName, candidate] of merged) {
    if (candidateName === baseName) continue;
    const candidateBody = candidate.body;
    if (!isRecordBody(candidateBody)) continue;
    const direct =
      (candidate.source !== undefined && terminal(candidate.source.name, lookup) === baseName) ||
      candidateBody.supertypes.some((ref) => terminal(ref.name, lookup) === baseName);
    if (direct) members.push({ name: candidateName, body: candidateBody });
  }
  return members;
}

// ── One family ───────────────────────────────────────────────────────────────────────────────

function checkFamily(
  baseName: string,
  baseBody: RecordBody,
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
  options: CheckRecordExtensionOptions,
): void {
  const discriminators = baseBody.discriminators ?? [];
  const fieldReaders = new Map<string, TypeReader<Value>>();
  let selectorsOk = true;
  for (const fieldName of discriminators) {
    const fieldReader = checkSelectorType(baseName, fieldName, baseBody, merged, options);
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
        // family, not the schema that declared the other side of the collision (this file's own
        // top note, and §5.2's "in the importing schema, which is the schema that broke it").
        // Falls back to the base only when neither colliding member is local, which happens only
        // when the base itself is what made this family local to begin with.
        const blame = localNames.has(a.name) ? a.name : localNames.has(b.name) ? b.name : baseName;
        fail(
          options,
          `'${a.name}' and '${b.name}' both pin '${baseName}''s ${named} to the same value -- the ` +
            'pins of a sealed family must be pairwise distinct (§5.2)',
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
    const field = member.body.fields.find((candidate) => candidate.name === fieldName);
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
 * §5.2: "the marked field's declared type resolves, after its reference chain, to an atom-family
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
  baseBody: RecordBody,
  merged: ReadonlyMap<string, TypeDefinition>,
  options: CheckRecordExtensionOptions,
): TypeReader<Value> | undefined {
  const field: RecordField | undefined = baseBody.fields.find(
    (candidate) => candidate.name === fieldName,
  );
  if (field === undefined) {
    // `discriminators` is populated by the same resolver pass that populates `fields`
    // (`definitionResolver.ts`'s own `resolveEntry`), always from a name it just pushed into
    // `fields` -- this is an invariant of that resolver, never a document-level defect.
    throw new Error(
      `internal error: '${baseName}' names '${fieldName}' in 'discriminators' but declares no ` +
        'such field',
    );
  }
  const terminalDef = terminalDefinition(field.type.name, (n) => merged.get(n));
  if (terminalDef === undefined || !isAtom(terminalDef.body)) {
    fail(
      options,
      `'${baseName}': the discriminator '${fieldName}' is typed '${field.type.name}', which is ` +
        'not an atom-family instance or an enum -- a selector MUST resolve, after its reference ' +
        'chain, to one of those (§5.2)',
      baseName,
    );
    return undefined;
  }
  return buildAtomReader(field.type.name, terminalDef.body);
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────────

function fail(options: CheckRecordExtensionOptions, message: string, pointerName: string): void {
  const { schemaId, receiver } = options;
  if (receiver === undefined) {
    throw new TsonSchemaValidationError(message);
  }
  receiver.report({
    code: 'SCHEMA_ERROR',
    message,
    schemaId,
    schemaPointer: `/${pointerName}`,
  });
}
