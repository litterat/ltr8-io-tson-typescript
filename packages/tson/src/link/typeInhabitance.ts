/**
 * Which entries some finite document can satisfy (§5.10.1's productivity rule, §3.4.1). A type
 * can be perfectly well-formed -- every reference resolving, every constraint coherent -- and
 * still have no value at all, because its recursion never reaches a base case:
 *
 * ```
 * x    => { y: y }                                     an x needs a y needs an x
 * y    => { x: x }
 * tree => <T> { value: T  children: [tree<T>; 1..] }   every node needs a child
 * ```
 *
 * Left unchecked, the mistake surfaces at the first document, as `missing required field 'x'` --
 * blaming the data for a defect in the schema, at a line the author of the data does not control.
 *
 * Ported from the reference implementation's `TypeInhabitance`
 * (`tson-compiler/.../compiler/TypeInhabitance.java`); see that file's own doc for the exhaustive
 * rationale, which carries over unchanged: a least fixed point over the entry graph rather than a
 * search (every entry starts unknown, a round marks each one whose body is satisfied by what is
 * already marked, rounds repeat until nothing changes -- terminating in O(entries) rounds since at
 * most one round per entry can add anything), exact and total with no third answer to report, and
 * scoped structurally (an atom's own satisfiability -- `int8 ^ { min: 300 }` admits nothing -- is
 * the constraint family that owns those facets' question, not this one's).
 *
 * **One simplification from the Java: the reported chain names entries directly, never through
 * the reference implementation's `EntryDisplayName`.** `link/referenceValidation.ts`'s own note
 * makes the identical simplification for the identical reason: this port reports every failure
 * against the entry (or, here, the chain link) it was found on, synthetic name and all, rather
 * than rendering a synthetic entry by the form or application that produced it.
 */
import type { DiagnosticsReceiver } from '../core/diagnostic.js';
import { TsonSchemaValidationError } from '../core/errors.js';
import { isDataBody } from './bodyKind.js';
import type { RecordBody, RecordField, TupleElement } from '../schema/meta/bodies.js';
import type { TypeDefinition, TypeRef } from '../schema/meta/typedef.js';

// ── Public surface ───────────────────────────────────────────────────────────────────────────

/** Dependencies {@link checkEveryEntryIsInhabited} needs beyond the merged namespace itself. */
export interface CheckInhabitanceOptions {
  /** This schema's own canonical identity, stamped on every diagnostic. */
  readonly schemaId: string;
  /**
   * Where a failing entry is reported, letting every other entry still be checked. Omitted means
   * fail-fast: the first {@link TsonSchemaValidationError} propagates.
   */
  readonly receiver?: DiagnosticsReceiver;
}

/**
 * §5.10.1's productivity rule: an entry no finite document can satisfy is rejected, with the
 * chain that has to be broken. `x => { y: y }` with `y => { x: x }` resolves and would otherwise
 * link cleanly, failing only at the first document as `missing required field 'x'`.
 *
 * **Every local entry is judged, referenced or not** -- on the same footing as a declared type
 * parameter the body never uses (§5.10): a declaration nothing can satisfy is a mistake wherever
 * it sits, and its author cannot see it. Imported entries are skipped: they were judged when
 * their own schema linked, and repeating the verdict here would report one defect once per
 * importer.
 *
 * Must run after reference validation, so an unresolved reference is already reported and never
 * mistaken for an uninhabited one.
 */
export function checkEveryEntryIsInhabited(
  merged: ReadonlyMap<string, TypeDefinition>,
  localNames: ReadonlySet<string>,
  options: CheckInhabitanceOptions,
): void {
  const { schemaId, receiver } = options;
  const inhabited = deriveInhabited(merged);
  for (const name of localNames) {
    if (inhabited.has(name)) {
      continue;
    }
    const def = merged.get(name);
    const chain = cycleThrough(name, merged, inhabited);
    const message =
      `'${name}' can never be satisfied by any document: ${chain.join(' needs ')}, and nothing ` +
      'in that chain can be left out or left empty (§5.10.1). A recursion terminates only where ' +
      'it reaches a base case -- an optional field, a possibly-empty container, or a choice ' +
      'variant that does not recur';
    if (receiver === undefined) {
      throw new TsonSchemaValidationError(message);
    }
    receiver.report({
      code: 'SCHEMA_ERROR',
      message,
      schemaId,
      schemaPointer: `/${name}`,
      ...(def?.position === undefined ? {} : { schemaPosition: def.position }),
    });
  }
}

// ── The fixed point ──────────────────────────────────────────────────────────────────────────

/** The names some finite document can satisfy. Everything else in `namespace` is uninhabited. */
function deriveInhabited(namespace: ReadonlyMap<string, TypeDefinition>): ReadonlySet<string> {
  const inhabited = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, def] of namespace) {
      if (!inhabited.has(name) && isInhabited(def, namespace, inhabited)) {
        inhabited.add(name);
        changed = true;
      }
    }
  }
  return inhabited;
}

/**
 * Whether one definition is satisfied by the entries marked so far.
 *
 * **An open entry is judged too, with its parameters assumed inhabited.** A template is not a
 * type and no document ever has one, so the question could have been left to its closures -- but
 * then a template nobody applies would ship broken. Assuming the parameters inhabited makes the
 * verdict sound in the direction that matters: if the body cannot be satisfied even when every
 * argument can, then no application of it can be either. A parameter is not an entry, so {@link
 * refInhabited} already treats one as inhabited (it is not a key `namespace` holds), and an
 * application `tree<p0>` already depends on `tree` -- both fall out of looking the reference's
 * own name up.
 */
function isInhabited(
  def: TypeDefinition,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): boolean {
  const body = def.body;
  if (!('kind' in body)) {
    // A held body is not walked: its element type and bounds are tokens that mean nothing until
    // substitution supplies the arguments, so a template is inhabited here and the closure that
    // does supply them is judged on its own -- it is an ordinary entry in this namespace by the
    // time linking runs, materialisation having minted it. A template nobody applies is judged
    // nowhere, which is the same answer §5.10 gives everywhere else for that case.
    return true;
  }
  if (isDataBody(body)) {
    return true; // not a type; TypeInhabitance's own question does not apply to it
  }
  switch (body.kind) {
    case 'record':
      return recordInhabited(body, namespace, inhabited);
    case 'array':
      return (
        body.state === 'OPTIONAL' ||
        isEmptyAllowed(body.minItems) ||
        refInhabited(body.elementType, namespace, inhabited)
      );
    case 'map':
      return (
        isEmptyAllowed(body.minItems) ||
        (refInhabited(body.keyType, namespace, inhabited) &&
          refInhabited(body.valueType, namespace, inhabited))
      );
    case 'tuple':
      return body.elements.every((element) => positionInhabited(element, namespace, inhabited));
    // A sum needs one good variant, where a product needs all its parts -- the one place the walk
    // branches rather than conjoins, and the reason `(leaf | node)` survives a non-productive `node`.
    case 'choice':
      return body.variants.some((variant) => refInhabited(variant, namespace, inhabited));
    case 'reference':
      return refInhabited(body.target, namespace, inhabited);
    default:
      return true; // an atom's own satisfiability is its family's question, not this one
  }
}

/**
 * A record needs every part it cannot do without, and one member of every group it must choose
 * from.
 *
 * **The groups are walked separately because their members hide from the field walk**: §5.11
 * makes a group's members uniformly OPTIONAL in `fields`, with the requirement carried by the
 * group's own state. Reading only the field list would find nothing required and call every
 * group satisfied.
 */
function recordInhabited(
  record: RecordBody,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): boolean {
  const grouped = new Set<string>();
  for (const group of record.groups) {
    for (const member of group.members) grouped.add(member);
  }
  for (const field of record.fields) {
    if (grouped.has(field.name) || isOptionalField(field)) {
      continue;
    }
    if (!refInhabited(field.type, namespace, inhabited)) {
      return false;
    }
  }
  for (const group of record.groups) {
    if (group.state !== 'REQUIRED') {
      continue;
    }
    const any = group.members.some((member) =>
      record.fields.some(
        (field) => field.name === member && refInhabited(field.type, namespace, inhabited),
      ),
    );
    if (!any) {
      return false;
    }
  }
  return true;
}

/**
 * A field a document may leave out places no demand on its type. Every other state does, the two
 * that carry a value included: a fixed or default value of a type nothing can satisfy does not
 * exist either.
 */
function isOptionalField(field: RecordField): boolean {
  return field.state === 'OPTIONAL' || field.state === 'OPTIONAL_FIXED';
}

function positionInhabited(
  element: TupleElement,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): boolean {
  return element.state === 'OPTIONAL' || refInhabited(element.elementType, namespace, inhabited);
}

/**
 * Whether a container may be empty -- the guard that makes recursion through one terminate.
 * `[tree]` is satisfied by `[]` whatever `tree` turns out to be; `[tree; 1..]` is satisfied only
 * if `tree` is. That single distinction is what separates ordinary recursion from the runaway
 * kind.
 */
function isEmptyAllowed(minItems: bigint | undefined): boolean {
  return minItems === undefined || minItems <= 0n;
}

/**
 * A name this namespace does not hold counts as inhabited. The reference is unresolved, which
 * `referenceValidation.ts` has already reported against this very entry -- calling it uninhabited
 * too would report the same defect twice, in words that name a different problem.
 */
function refInhabited(
  ref: TypeRef,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): boolean {
  return !namespace.has(ref.name) || inhabited.has(ref.name);
}

// ── The diagnostic chain ─────────────────────────────────────────────────────────────────────

/**
 * The chain from an uninhabited entry back to itself, or to whatever else it depends on. Walks
 * the demands {@link isInhabited} makes -- the parts a value cannot do without -- so the chain
 * shown is the one that actually has to be broken.
 */
function cycleThrough(
  name: string,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    chain.push(current);
    // The repeat is written down rather than dropped: `x needs y needs x` is the cycle, and
    // `x needs y` is only half of an explanation.
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const next = firstUnsatisfiedDependency(namespace.get(current), namespace, inhabited);
    if (next === undefined) {
      break;
    }
    current = next;
  }
  return chain;
}

/**
 * The part of a record nothing satisfies: a required field, or -- when every one of those is
 * fine -- the first member of a group that has to be chosen from and has nothing to choose.
 * Following the group matters because its members are OPTIONAL in `fields`, so a chain that
 * walked only required fields would stop at the record and explain nothing.
 */
function recordDependency(
  record: RecordBody,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): string | undefined {
  const grouped = new Set<string>();
  for (const group of record.groups) {
    for (const member of group.members) grouped.add(member);
  }
  for (const field of record.fields) {
    if (
      !grouped.has(field.name) &&
      !isOptionalField(field) &&
      !refInhabited(field.type, namespace, inhabited)
    ) {
      return field.type.name;
    }
  }
  for (const group of record.groups) {
    if (group.state !== 'REQUIRED') {
      continue;
    }
    for (const member of group.members) {
      const field = record.fields.find((f) => f.name === member);
      if (field !== undefined && !refInhabited(field.type, namespace, inhabited)) {
        return field.type.name;
      }
    }
  }
  return undefined;
}

/** The first thing a definition demands that nothing satisfies -- the next link of the chain. */
function firstUnsatisfiedDependency(
  def: TypeDefinition | undefined,
  namespace: ReadonlyMap<string, TypeDefinition>,
  inhabited: ReadonlySet<string>,
): string | undefined {
  if (def === undefined) {
    return undefined;
  }
  const body = def.body;
  if (!('kind' in body) || isDataBody(body)) {
    return undefined;
  }
  switch (body.kind) {
    case 'record':
      return recordDependency(body, namespace, inhabited);
    case 'array':
      return refInhabited(body.elementType, namespace, inhabited)
        ? undefined
        : body.elementType.name;
    case 'map':
      return refInhabited(body.valueType, namespace, inhabited) ? undefined : body.valueType.name;
    case 'tuple': {
      const bad = body.elements.find(
        (element) => !positionInhabited(element, namespace, inhabited),
      );
      return bad?.elementType.name;
    }
    case 'reference':
      return refInhabited(body.target, namespace, inhabited) ? undefined : body.target.name;
    default:
      return undefined; // a choice fails on every variant at once, so no single link continues the chain
  }
}
