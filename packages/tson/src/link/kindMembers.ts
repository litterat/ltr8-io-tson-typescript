/**
 * The names a reference admits where its `of` is a constructor (Part 2 §4.2, §5.12): every entry of the
 * closure whose value, past its alias hops (§8.3), is a type built with a constructor that is `of` or IS-A
 * it -- the derived index `meta.reference_type`'s `index.members` the linker writes.
 *
 * **Membership is one walk** over resolved entries, never over spellings. From an entry, alias hops first
 * reach the type the entry is; that value is no member if it is a held template (no type) or a value entry.
 * A constructor is a type like any other (§4.1): a record written in braces is built with `meta.record`, and
 * so is `meta.top` itself and a constructor whose declaration is a record, so `meta.ref<meta.record>` holds
 * all of them. The constructor an entry's value applies -- the tag resolved output writes -- is followed,
 * through a constructor template's held body to the constructor it applies, until a constructor is reached,
 * and the entry is a member when that constructor is `of` or has `of` among its supertypes.
 *
 * Every name resolves in the one namespace, so there is no structure namespace to read a constructor from
 * first. The rule `of` itself obeys is the linker's judgement of the reference's declaration, not this
 * index's.
 */
import type { EntryAccess, ReferenceBody, ReferenceValues } from '../schema/meta/bodies.js';
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  isOpen,
  isTemplateBody,
  isType,
  referenceText,
  supertypesOf,
  withChain,
} from '../schema/meta/typedef.js';
import { heldOf } from '../compiler/heldBody.js';
import { terminal, type EntryLookup } from './aliasChain.js';

/** An entry reached by a walk, under the name it is declared by. */
interface Found {
  readonly name: string;
  readonly value: Top;
}

/** The entry at the end of `name`'s §8.3 chain in `entries`, or `undefined` where the walk reaches none. */
function reached(name: string, entries: EntryLookup): Found | undefined {
  const end = terminal(name, entries);
  const value = entries(end);
  if (value === undefined || (!isTemplateBody(value) && value.kind === 'alias')) {
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
 * constructor an entry's value applies, from its recorded facts.
 */
export function isKindMember(
  name: string,
  of: string,
  local: EntryLookup,
  heads: (name: string) => string | undefined,
): boolean {
  const end = terminal(name, local);
  const type = local(end);
  if (type === undefined || !isTypeValue(type)) return false;
  const ofConstructor = terminal(of, local);
  const walked = new Set<string>();
  let current = heads(end) ?? constructorOf(type);
  while (!walked.has(current)) {
    walked.add(current);
    const next = reached(current, local);
    if (next === undefined) return current === ofConstructor;
    if (isTemplateBody(next.value)) {
      // A constructor template (`ref => <T> !meta.reference_type { of: T }`): built with what its body applies.
      const applied = heldOf(next.value)?.application.typeRef;
      if (applied === undefined) return false;
      current = applied;
      continue;
    }
    return (
      isConstructor(next.value, next.name) &&
      (next.name === ofConstructor || supertypesOf(next.value).includes(ofConstructor))
    );
  }
  return false;
}

/** Whether `value` is a type: it carries a chain, being IS-A `meta.type` (§4.1). */
function isTypeValue(value: Top): boolean {
  return !isTemplateBody(value) && isType(value);
}

/** Every entry of `merged` that is a member of `reference`, sorted -- the index `members` holds. */
export function kindMembers(
  reference: ReferenceBody,
  merged: ReadonlyMap<string, Top>,
  heads: (name: string) => string | undefined,
): readonly string[] {
  const local: EntryLookup = (n) => merged.get(n);
  const members: string[] = [];
  for (const name of merged.keys()) {
    if (isKindMember(name, reference.of.name, local, heads)) members.push(name);
  }
  return members.sort();
}

/** What {@link computeKindMembers} derives each index from beyond the namespace being indexed. */
export interface KindIndexInputs {
  /** An entry's recorded facts: the constructor it applied, and the applications it closes. */
  readonly facts: (name: string) => EntryFacts | undefined;
  /** The closure's final entries, which a reference read in data names; assembled after the index is, so a lookup. */
  readonly entries: EntryAccess;
  /** What a name read under a reference over `of`, a type that is no constructor, reaches: the link's own walk over its final namespace. */
  readonly values: (of: string) => ReferenceValues;
}

/**
 * `merged` with every reference's derived `index` computed over the whole closure (§4.2, §2.2.3): the
 * linker's derived index, as `subtypes` is, discarded and recomputed whenever a schema links. An imported
 * reference is recomputed too -- the closure that links is what its members are drawn from, so a reference
 * the kernel declares lists an entry this schema declares.
 *
 * The index holds, beside the members, the entry each application the closure closed denotes (§8.2) -- the
 * applications every entry's facts record, an expansion's included -- and each alias entry's terminal, so a
 * name or application written in data is judged through the entry it denotes (`referenceEntryOf`). A
 * reference over a type that is no constructor holds instead the walk that judges a value's qualified name.
 */
export function computeKindMembers(
  merged: ReadonlyMap<string, Top>,
  inputs: KindIndexInputs,
): Map<string, Top> {
  const result = new Map(merged);
  const heads = (name: string): string | undefined => inputs.facts(name)?.head;
  const local: EntryLookup = (n) => merged.get(n);
  const applications = new Map<string, string>();
  for (const name of merged.keys()) {
    for (const application of inputs.facts(name)?.closes ?? []) {
      const key = referenceText(application);
      if (!applications.has(key)) applications.set(key, name);
    }
  }
  const aliases = new Map<string, string>();
  for (const [name, value] of merged) {
    if (isTemplateBody(value) || value.kind !== 'alias') continue;
    const end = terminal(name, local);
    if (end !== name) aliases.set(name, end);
  }
  for (const name of merged.keys()) {
    const value = merged.get(name);
    if (value === undefined || isTemplateBody(value) || value.kind !== 'reference_type') continue;
    const types = namesTypes(value.of.name, local);
    const members = types ? kindMembers(value, merged, heads) : [];
    const { index: _previous, ...rest } = value;
    void _previous;
    result.set(
      name,
      withChain(
        {
          ...rest,
          index: {
            namesTypes: types,
            members,
            applications: types ? applications : new Map(),
            aliases: types ? aliases : new Map(),
            entries: inputs.entries,
            shown: members,
            ...(types ? {} : { values: inputs.values(value.of.name) }),
          },
        },
        value.chain ?? { parents: [], supertypes: [], subtypes: [] },
      ),
    );
  }
  return result;
}

/**
 * Why `reference`'s `of` cannot be one, or `undefined` where it can: any type or constructor of the
 * writer's namespace may be. Refused are a name the namespace does not declare (reported as an unresolved
 * reference by the caller), an open entry, which denotes no type until it is applied (§5.10), and a value
 * entry, which is a value and no type.
 */
export function ofRefusal(reference: ReferenceBody, local: EntryLookup): string | undefined {
  const of = reference.of.name;
  const found = reached(of, local);
  if (found === undefined) return undefined;
  if (!isTemplateBody(found.value) && found.value.kind === 'value_entry') {
    return (
      `its 'of' names '${of}', which is a value and no type -- a reference admits the names of ` +
      'entries whose values are of a type, and nothing has a value of a value'
    );
  }
  if (isOpen(found.value) || isTemplateBody(found.value)) {
    return `its 'of' names '${of}', an open entry: a template denotes no type until it is applied (§5.10)`;
  }
  return undefined;
}
