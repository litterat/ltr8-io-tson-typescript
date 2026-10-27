/**
 * The members of a `kind_type` instance (Part 2 §4.2): every entry of the governing closure built
 * with the constructor its `of` names -- the derived index `kind_type.members` the linker writes.
 * Ported from the reference implementation's `KindMembers`
 * (`tson-compiler/.../resolver/KindMembers.java`).
 *
 * **Membership is one walk** over resolved entries, never over spellings. From an entry, alias
 * hops first (§8.3) reach the type the entry is; that type is no member if it is a reference or a
 * held template (no type). A constructor IS-A `top` and is excluded, its instances being types --
 * except a namespace constructor (the kernel's `namespace`, or one IS-A it), which is a type
 * because its instances are values, maps: it is a member of `type_kind` and of the kind of each
 * namespace constructor it is or IS-A, and of no other kind. For every other type the constructor
 * its value applies -- the tag resolved output writes -- is followed, through a constructor
 * template's held body to the constructor it applies, until a constructor is reached, and the
 * entry is a member when that constructor is `of` or has `of` among its supertypes. A record
 * template is built with `record`, so a kind of `record` holds it; so does the kernel's `top`, a
 * fresh abstract record IS-A nothing.
 *
 * **A constructor is read from the structure namespace first**, where §3.3.1 puts every
 * constructor role, so a schema's own entry under a constructor's name never captures a hop. A
 * name the structure namespace does not hold is read in the entry's own namespace -- which is
 * where the meta-kernel's own constructors are while it links itself.
 *
 * The rule `of` itself obeys (`of` names `type`, `namespace`, or a constructor below either) is
 * the linker's judgement of the kind's declaration, not this index's.
 */
import type { EntryFacts, KindBody, Top } from '../schema/meta/typedef.js';
import { constructorOf, isTemplateBody, supertypesOf, withChain } from '../schema/meta/typedef.js';
import { heldOf } from '../compiler/heldBody.js';
import { terminal, type EntryLookup } from './referenceChain.js';

const TYPE = 'type';
const NAMESPACE = 'namespace';

/** An entry reached by a walk, under the name it is declared by. */
interface Found {
  readonly name: string;
  readonly value: Top;
}

function isConstructorValue(value: Top): boolean {
  return supertypesOf(value).includes('top');
}

/** The entry at the end of `name`'s §8.3 chain in `entries`, or `undefined` where the walk reaches none. */
function reached(name: string, entries: EntryLookup): Found | undefined {
  const end = terminal(name, entries);
  const value = entries(end);
  if (value === undefined || (!isTemplateBody(value) && value.kind === 'reference')) {
    return undefined;
  }
  return { name: end, value };
}

/**
 * Whether the entry `name` names in `local` is a member of the kind of `of`. `heads` gives the
 * constructor an entry's value applies, from its recorded facts; `structure` is the governing
 * meta's namespace.
 */
export function isKindMember(
  name: string,
  of: string,
  local: EntryLookup,
  heads: (name: string) => string | undefined,
  structure: EntryLookup,
): boolean {
  const end = terminal(name, local);
  const type = local(end);
  if (type === undefined) return false;
  return isMemberValue(end, type, heads(end) ?? constructorOf(type), of, local, structure);
}

function isMemberValue(
  name: string,
  type: Top,
  head: string,
  of: string,
  local: EntryLookup,
  structure: EntryLookup,
): boolean {
  const constructors: EntryLookup = (n) => structure(n) ?? local(n);
  if (isTemplateBody(type) || type.kind === 'reference') return false;
  const ofConstructor = terminal(of, constructors);
  if (isConstructorValue(type)) {
    const supertypes = supertypesOf(type);
    if (name !== NAMESPACE && !supertypes.includes(NAMESPACE)) return false;
    // A value of it is a map and not a record, and it is not built with `map`: its `!record` tag
    // is not followed. It is a type, and the namespace constructor it is or IS-A.
    return ofConstructor === TYPE || ofConstructor === name || supertypes.includes(ofConstructor);
  }
  const walked = new Set<string>();
  let current = head;
  while (!walked.has(current)) {
    walked.add(current);
    const next = reached(current, constructors);
    if (next === undefined) return current === ofConstructor;
    if (isTemplateBody(next.value)) {
      // A constructor template (`kind => <T> !kind_type { of: T }`): built with what its body applies.
      const applied = heldOf(next.value)?.application.typeRef;
      if (applied === undefined) return false;
      current = applied;
      continue;
    }
    return (
      isConstructorValue(next.value) &&
      (next.name === ofConstructor || supertypesOf(next.value).includes(ofConstructor))
    );
  }
  return false;
}

/** Every entry of `merged` that is a member of `kind`, sorted -- the index `kind_type.members` holds. */
export function kindMembers(
  kind: KindBody,
  merged: ReadonlyMap<string, Top>,
  heads: (name: string) => string | undefined,
  structure: EntryLookup,
): readonly string[] {
  const local: EntryLookup = (n) => merged.get(n);
  const members: string[] = [];
  for (const name of merged.keys()) {
    if (isKindMember(name, kind.of, local, heads, structure)) members.push(name);
  }
  return members.sort();
}

/**
 * `merged` with every kind's `members` index computed over the whole closure (§4.2, §2.2.3): the
 * linker's derived index, as `subtypes` is, discarded and recomputed whenever a schema links. An
 * imported kind is recomputed too -- the closure that links is what its members are drawn from,
 * so a kind the kernel declares lists an identifier family this schema declares.
 */
export function computeKindMembers(
  merged: ReadonlyMap<string, Top>,
  facts: (name: string) => EntryFacts | undefined,
  structure: EntryLookup,
): Map<string, Top> {
  const result = new Map(merged);
  const heads = (name: string): string | undefined => facts(name)?.head;
  for (const name of merged.keys()) {
    const value = merged.get(name);
    if (value === undefined || isTemplateBody(value) || value.kind !== 'kind_type') continue;
    const members = kindMembers(value, merged, heads, structure);
    const { members: _previous, ...rest } = value;
    void _previous;
    result.set(
      name,
      withChain({ ...rest, members }, value.chain ?? { parents: [], supertypes: [], subtypes: [] }),
    );
  }
  return result;
}
