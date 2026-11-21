/**
 * The constructor a composed constructor's instances bind as ([TSON-SCHEMA] §5.8, §8.1).
 *
 * `my_list => meta.array & { min_items?: = 1 }` is a constructor IS-A `meta.array` that adds no field, so its parent's
 * body holds every value an instance writes and its pins take effect where the instance is read. Nothing binds
 * `my_list` itself, so a lookup for an application or a construction of it tries the parent's names next.
 */
import { supertypesOf, isConstructor } from './typedef.js';
import type { Top } from './typedef.js';
import { metaName } from './kernel.js';

/** The entry `name` denotes past its alias hops, bounded so a cycle ends the walk. */
function terminalOf(
  name: string,
  lookup: (name: string) => Top | undefined,
  bound: number,
): string {
  let terminal = name;
  for (let hops = 0; hops < bound; hops++) {
    const entry = lookup(terminal);
    if (entry?.kind !== 'alias') break;
    terminal = entry.target.name;
  }
  return terminal;
}

/**
 * The constructor `name`'s instances bind as where nothing binds `name`: its one direct parent, where `name` is a
 * constructor composed over a constructor of types that has instances and has the same field names (§5.8). Derived
 * from the entries alone, so a resolved form read back binds as its source did. A field added, two parents, or an
 * abstract parent (a base kind, `meta.type`) leaves no body to bind as.
 *
 * **Only a constructor of types, and never `meta.record`.** What some constructions may write is checked of the
 * kernel's head by name -- a written `parameters` of `!meta.record` (§5.10), an alias's or an extern's body by what
 * it denotes -- so an instance built under another head would skip it. An instance of a constructor composing
 * `meta.top` alone is held as the value it is, and composing `record` is open work of its own.
 */
export function composedOver(
  name: string,
  lookup: (name: string) => Top | undefined,
  bound = 64,
): string | undefined {
  const record = lookup(name);
  if (
    record?.kind !== 'record' ||
    (record.parameters?.length ?? 0) > 0 ||
    !isConstructor(record, name)
  ) {
    return undefined;
  }
  const terminals = (names: readonly string[]): Set<string> =>
    new Set(names.map((each) => terminalOf(each, lookup, bound)));
  const supertypes = terminals(supertypesOf(record));
  const direct = [...supertypes].filter(
    (supertype) =>
      ![...supertypes].some(
        (other) => other !== supertype && terminals(supertypesOf(lookup(other))).has(supertype),
      ),
  );
  const [parentName, ...rest] = direct;
  if (parentName === undefined || rest.length > 0) return undefined;
  const parent = lookup(parentName);
  if (
    parent?.kind !== 'record' ||
    parent.extension === 'ABSTRACT' ||
    !supertypesOf(parent).includes(metaName('type')) ||
    parentName === metaName('record') ||
    !sameKeys(parent.fields.entries, record.fields.entries)
  ) {
    return undefined;
  }
  return parentName;
}

function sameKeys(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}
