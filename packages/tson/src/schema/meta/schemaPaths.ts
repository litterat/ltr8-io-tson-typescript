/**
 * A schema map nested as an entry, `geo => !schema { address => { ... } }`, and the paths that address its
 * members (Part 2 §2.2.3, §4.1, §5.12). Every value of the kernel's `meta.schema` namespace type
 * declares as the document's root does, and a member's identity is its path from the root, `geo.address`.
 *
 * **One map of entries, keyed by path.** A schema's entries hold every declaration of the document at
 * every depth under its path, so each phase reads a nested member as it reads a root entry: a reference
 * to `geo.address` is a lookup of that key, as every name resolves from the root. The nested map's own
 * entry, `geo`, is a {@link ValueEntry} of `meta.schema` whose {@link Namespace} holds its members under
 * their own names, and it is derived from the path entries wherever a schema is built
 * ({@link syncedEntries}), so the two never disagree. Resolved output writes the nested map and not the
 * paths; a resolved form read back holds the nested map alone, and {@link syncedEntries} keys its members
 * under their paths.
 */
import type { Annotations, Namespace, Top, ValueEntry } from './typedef.js';
import { namespaceOf } from './typedef.js';
import { SCHEMA } from './kernel.js';

/** Whether `name` is the path of a nested map's member, `geo.address`, rather than a root entry's. */
export function isPath(name: string): boolean {
  return name.includes('.');
}

/** The path of the map `path` is a member of, `''` for a root entry. */
export function parentPath(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(0, dot);
}

/** The member's own name, the path's last segment. */
export function memberName(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

/** The members `value` holds where it is a schema map nested as an entry, `undefined` otherwise. */
export function nestedMembers(value: Top | undefined): Namespace<Top> | undefined {
  if (value === undefined || !('kind' in value) || value.kind !== 'value_entry') return undefined;
  const held = value.value;
  return value.type === SCHEMA && held.form === 'schema_map' ? held.members : undefined;
}

/** Whether `value` is a schema map nested as an entry: a value of `meta.schema` holding members. */
export function isNestedMap(value: Top | undefined): boolean {
  return nestedMembers(value) !== undefined;
}

/** A nested map's entry holding `members` under their own names. */
export function nestedMap(members: Namespace<Top>): ValueEntry {
  return { kind: 'value_entry', type: SCHEMA, value: { form: 'schema_map', members } };
}

/** The entries of a schema map together with the annotations written on each key. */
export interface KeyedEntries {
  readonly entries: ReadonlyMap<string, Top>;
  readonly keyAnnotations: ReadonlyMap<string, Annotations>;
}

/**
 * `entries` with every nested map and its members in step: a member a nested map holds and no path keys
 * (a schema built from a resolved form read back) is added under its path, an entry keyed under its path
 * being the one held where both are present, and each nested map's value is then rebuilt from the entries
 * at its members' paths, with their key annotations, in their order, innermost first. Returns `entries`
 * itself where it holds no nested map.
 */
export function syncedEntries(keyed: KeyedEntries): KeyedEntries {
  const { entries, keyAnnotations } = keyed;
  let any = false;
  for (const value of entries.values()) {
    if (isNestedMap(value)) {
      any = true;
      break;
    }
  }
  if (!any) return keyed;
  // Every keyed entry first, so a member keyed under its path is the one held, whichever comes first.
  const flat = new Map<string, Top>(entries);
  const annotations = new Map<string, Annotations>(keyAnnotations);
  for (const [name, value] of entries) addWithMembers(flat, annotations, name, value);
  const maps = [...flat.entries()]
    .filter(([, value]) => isNestedMap(value))
    .map(([name]) => name)
    .sort((a, b) => b.split('.').length - a.split('.').length);
  for (const map of maps) {
    const members: [string, Top][] = [];
    const memberAnnotations = new Map<string, Annotations>();
    for (const [name, value] of flat) {
      if (isPath(name) && parentPath(name) === map) {
        members.push([memberName(name), value]);
        const written = annotations.get(name);
        if (written !== undefined) memberAnnotations.set(memberName(name), written);
      }
    }
    flat.set(map, nestedMap(namespaceOf(SCHEMA, members, memberAnnotations)));
  }
  return { entries: flat, keyAnnotations: annotations };
}

/** `name` and, where it is a nested map, each member it holds that no path already keys, recursively. */
function addWithMembers(
  flat: Map<string, Top>,
  annotations: Map<string, Annotations>,
  name: string,
  value: Top,
): void {
  const members = nestedMembers(value);
  if (members === undefined) return;
  for (const [member, memberValue] of members.entries) {
    const path = `${name}.${member}`;
    if (!flat.has(path)) {
      flat.set(path, memberValue);
      const written = members.keyAnnotations?.get(member);
      if (written !== undefined) annotations.set(path, written);
    }
    addWithMembers(flat, annotations, path, memberValue);
  }
}
