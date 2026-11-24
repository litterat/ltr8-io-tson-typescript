/**
 * The names a reference admits where its `of` is a constructor (Part 2 §4.2, §5.12): every entry of the
 * closure whose value, past its alias hops (§8.3), is a type built with a constructor that is `of` or IS-A
 * it -- the derived index `meta.ref`'s `index.members` the linker writes.
 *
 * **Membership is one walk** over resolved entries, never over spellings. From an entry, alias hops first
 * reach the type the entry is; that value is no member if it is no type -- a value entry, an incomplete entry
 * or a parametric record (§5.5, §5.10). A constructor is a type like any other (§4.1): a record written in
 * braces is built with `meta.record`, and so is `meta.top` itself, so `meta.ref<meta.record>` holds all of
 * them. The constructor an entry's value applies -- the tag resolved output writes -- is followed until a
 * constructor is reached, and the entry is a member when that constructor is `of` or has `of` among its
 * supertypes.
 *
 * Every name resolves in the one namespace, so there is no structure namespace to read a constructor from
 * first. The rule `of` itself obeys is the linker's judgement of the reference's declaration, not this
 * index's.
 */
import type { EntryAccess, RefBody, ReferenceValues } from '../schema/meta/bodies.js';
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  isParametric,
  isType,
  supertypesOf,
  withChain,
} from '../schema/meta/typedef.js';
import { terminal, type EntryLookup } from './aliasChain.js';
import { mapInPlace } from '../schema/meta/typeInline.js';
import type { ExternHops } from './externHops.js';

/** An entry reached by a walk, under the name it is declared by. */
interface Found {
  readonly name: string;
  readonly value: Top;
}

/** The entry at the end of `name`'s §8.3 chain in `entries`, or `undefined` where the walk reaches none. */
function reached(name: string, entries: EntryLookup): Found | undefined {
  const end = terminal(name, entries);
  const value = entries(end);
  if (value === undefined || value.kind === 'alias') {
    return undefined;
  }
  return { name: end, value };
}

/** Whether `of` names a constructor in `local`: the reference admits types' names where it does, values' names otherwise. */
export function namesTypes(of: string, local: EntryLookup): boolean {
  const end = terminal(of, local);
  const value = local(end);
  return value !== undefined && isConstructor(value, end);
}

/**
 * Whether the entry `name` names in `local` is a member of the names `of` admits. `heads` gives the
 * constructor an entry's value applies, from its recorded facts. An extern is a member where the entry it lands on
 * is, judged in the namespace holding that entry (`hops`, §5.13).
 */
export function isKindMember(
  name: string,
  of: string,
  local: EntryLookup,
  heads: (name: string) => string | undefined,
  hops?: ExternHops,
): boolean {
  const landed = hops?.membership(name, of);
  if (landed !== undefined) return landed;
  const end = terminal(name, local);
  const type = local(end);
  if (type === undefined || !isTypeValue(type)) return false;
  const ofConstructor = terminal(of, local);
  const walked = new Set<string>();
  const current = heads(end) ?? constructorOf(type);
  while (!walked.has(current)) {
    walked.add(current);
    const next = reached(current, local);
    if (next === undefined) return current === ofConstructor;
    return (
      isConstructor(next.value, next.name) &&
      (next.name === ofConstructor || supertypesOf(next.value).includes(ofConstructor))
    );
  }
  return false;
}

/** Whether `value` is a type a position may name: IS-A `meta.type` (§4.1), and no parametric record (§5.10). */
function isTypeValue(value: Top): boolean {
  return isType(value) && !isParametric(value);
}

/** Every entry of `merged` that is a member of `reference`, sorted -- the index `members` holds. */
export function kindMembers(
  reference: RefBody,
  merged: ReadonlyMap<string, Top>,
  heads: (name: string) => string | undefined,
  hops?: ExternHops,
): readonly string[] {
  const local: EntryLookup = (n) => merged.get(n);
  const members: string[] = [];
  for (const name of merged.keys()) {
    if (isKindMember(name, reference.of.name, local, heads, hops)) members.push(name);
  }
  return members.sort();
}

/** What {@link computeKindMembers} derives each index from beyond the namespace being indexed. */
export interface KindIndexInputs {
  /** An entry's recorded facts: the constructor it applied. */
  readonly facts: (name: string) => EntryFacts | undefined;
  /** The closure's final entries, which a reference read in data names; assembled after the index is, so a lookup. */
  readonly entries: EntryAccess;
  /** What a name read under a reference over `of`, a type that is no constructor, reaches: the link's own walk over its final namespace. */
  readonly values: (of: string) => ReferenceValues;
  /** The namespace's externs, each a member where the entry it lands on is (§5.13). Absent means none. */
  readonly hops?: ExternHops;
}

/**
 * `merged` with every reference's derived `index` computed over the whole closure (§4.2, §2.2.3): the
 * linker's derived index, as `subtypes` is, discarded and recomputed whenever a schema links. An imported
 * reference is recomputed too -- the closure that links is what its members are drawn from, so a reference
 * the kernel declares lists an entry this schema declares.
 *
 * The index holds, beside the members, each alias entry's terminal. A reference over a type that is no
 * constructor holds instead the walk that judges a value's qualified name.
 */
export function computeKindMembers(
  merged: ReadonlyMap<string, Top>,
  inputs: KindIndexInputs,
): Map<string, Top> {
  const result = new Map(merged);
  const heads = (name: string): string | undefined => inputs.facts(name)?.head;
  const local: EntryLookup = (n) => merged.get(n);
  const aliases = new Map<string, string>();
  for (const [name, value] of merged) {
    if (value.kind !== 'alias') continue;
    const end = terminal(name, local);
    if (end !== name) aliases.set(name, end);
  }
  const indexed = (value: RefBody): RefBody => {
    const types = namesTypes(value.of.name, local);
    const members = types ? kindMembers(value, merged, heads, inputs.hops) : [];
    const { index: _previous, ...rest } = value;
    void _previous;
    return withChain(
      {
        ...rest,
        index: {
          namesTypes: types,
          members,
          aliases: types ? aliases : new Map(),
          entries: inputs.entries,
          shown: members,
          ...(types ? {} : { values: inputs.values(value.of.name) }),
        },
      },
      value.chain ?? { parents: [], supertypes: [], subtypes: [] },
    );
  };
  for (const name of merged.keys()) {
    const value = merged.get(name);
    if (value === undefined) continue;
    // A reference written in place is indexed as a declared one is (§4.2).
    const inPlace = mapInPlace(value, (inline) =>
      inline.of.kind === 'ref' ? { ...inline, of: indexed(inline.of) } : inline,
    );
    if (inPlace.kind === 'ref') result.set(name, indexed(inPlace));
    else if (inPlace !== value) result.set(name, inPlace);
  }
  return result;
}

/**
 * Why `reference`'s `of` cannot be one, or `undefined` where it can: any type or constructor of the writer's
 * namespace may be. Refused are a name the namespace does not declare (reported as an unresolved reference by
 * the caller), a parametric record, which denotes no type until it is applied (§5.10), an incomplete entry,
 * which is no type (§5.5), and a value entry, which is a value and no type.
 */
export function ofRefusal(reference: RefBody, local: EntryLookup): string | undefined {
  const of = reference.of.name;
  const found = reached(of, local);
  if (found === undefined) return undefined;
  if (found.value.kind === 'value_entry') {
    return (
      `its 'of' names '${of}', which is a value and no type -- a reference admits the names of ` +
      'entries whose values are of a type, and nothing has a value of a value'
    );
  }
  if (isParametric(found.value)) {
    return `its 'of' names '${of}', a parametric record, which denotes no type until it is applied (§5.10)`;
  }
  if (found.value.kind === 'incomplete') {
    return `its 'of' names '${of}', an incomplete entry, which is no type (§5.5)`;
  }
  return undefined;
}
