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
import type { ReferenceBody } from '../schema/meta/bodies.js';
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import {
  constructorOf,
  isConstructor,
  isTemplateBody,
  isType,
  supertypesOf,
  withChain,
} from '../schema/meta/typedef.js';
import { heldOf } from '../compiler/heldBody.js';
import { terminal, type EntryLookup } from './referenceChain.js';

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
    return next.name === ofConstructor || supertypesOf(next.value).includes(ofConstructor);
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

/**
 * `merged` with every reference's derived `index` computed over the whole closure (§4.2, §2.2.3): the
 * linker's derived index, as `subtypes` is, discarded and recomputed whenever a schema links. An imported
 * reference is recomputed too -- the closure that links is what its members are drawn from, so a reference
 * the kernel declares lists an entry this schema declares.
 */
export function computeKindMembers(
  merged: ReadonlyMap<string, Top>,
  facts: (name: string) => EntryFacts | undefined,
): Map<string, Top> {
  const result = new Map(merged);
  const heads = (name: string): string | undefined => facts(name)?.head;
  const local: EntryLookup = (n) => merged.get(n);
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
            applications: new Map(),
            aliases: new Map(),
            entries: new Map(),
            shown: members,
          },
        },
        value.chain ?? { parents: [], supertypes: [], subtypes: [] },
      ),
    );
  }
  return result;
}
