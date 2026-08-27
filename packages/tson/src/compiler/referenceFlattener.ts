/**
 * Part 2 §8.3's use-site reference flattening: a type position naming a `REFERENCE` entry is
 * rewritten to the first entry in its chain that is not one, and the name the author wrote is
 * preserved on the reference as `@alias`. meta-kernel's own resolved fixture states the rule in
 * one line -- "Reference-kind names at type positions are flattened with @alias" -- and spells
 * the result `type: @alias:field_name token`.
 *
 * Ported from the reference implementation's `ReferenceFlattener`
 * (`tson-compiler/.../resolver/ReferenceFlattener.java`); see that file's own module doc for the
 * full rationale. This module states only what differs in the port.
 *
 * **What it buys is single-level identity.** §8.2 compares an instantiation's `source` as a flat
 * application, so a use site that still names an alias would have to be chased before two of them
 * could be told apart. Flattening moves that walk to schema-load time, once per use site; `@alias`
 * is what keeps the author's own word recoverable afterwards.
 *
 * **Only use sites.** An alias entry's own `source` and its {@link Reference} target are left
 * exactly as resolved: `doc => documentation` keeps its single hop even though `documentation` is
 * itself a reference to `text`. `supertypes`/`subtypes` are name lists with no annotation channel
 * and are likewise untouched -- resolver-managed indexes, not use sites.
 *
 * Runs after materialisation so an instantiation's minted entry is in the namespace to be
 * flattened past: an alias to an application (`string_triple => vector<text, 3>`) is a
 * `REFERENCE` like any other, and a use of it lands on the instantiation with
 * `@alias:string_triple`.
 */
import type {
  Annotations,
  Reference,
  Top,
  TypeArgument,
  TypeDefinition,
  TypeRef,
} from '../schema/meta/typedef.js';
import { mapBodyRefs } from './templates.js';

const ALIAS = 'alias';

/**
 * `entries` with every use site flattened. `namespace` is what chains are walked through -- the
 * whole schema including merged imports, since an alias may be imported while the use site is
 * local. `minted` is the set of entry names a template materialiser closed an application to
 * (empty when this schema materialised nothing): the walk stops *at* one of these rather than
 * through it, since that is the entry §8.2 keys identity on.
 */
export function flattenSchema(
  entries: ReadonlyMap<string, TypeDefinition>,
  namespace: ReadonlyMap<string, TypeDefinition>,
  minted: ReadonlySet<string>,
): Map<string, TypeDefinition> {
  const flattened = new Map<string, TypeDefinition>();
  for (const [name, definition] of entries) {
    flattened.set(name, flattenEntry(definition, namespace, minted));
  }
  return flattened;
}

/** One entry's body, or the entry unchanged where nothing in it moved. */
function flattenEntry(
  definition: TypeDefinition,
  namespace: ReadonlyMap<string, TypeDefinition>,
  minted: ReadonlySet<string>,
): TypeDefinition {
  if (isReferenceBody(definition.body)) {
    return definition; // an alias entry records the hop; see this module's own doc
  }
  const body = mapBodyRefs(definition.body, (ref) => flattenRef(ref, namespace, minted));
  return body === definition.body ? definition : { ...definition, body };
}

function isReferenceBody(body: Top): body is Reference {
  return 'kind' in body && body.kind === 'reference';
}

/** One type-ref, its own arguments flattened first so a nested alias moves too. */
function flattenRef(
  ref: TypeRef,
  namespace: ReadonlyMap<string, TypeDefinition>,
  minted: ReadonlySet<string>,
): TypeRef {
  const withArguments = flattenArguments(ref, namespace, minted);
  const terminal = terminalName(ref.name, namespace, minted);
  if (terminal === ref.name) {
    return withArguments;
  }
  return {
    name: terminal,
    arguments: withArguments.arguments,
    annotations: plusAlias(withArguments.annotations, ref.name),
  };
}

/** `annotations` with `@alias:written` added -- the carrier is immutable, so this rebuilds it. */
function plusAlias(annotations: Annotations, written: string): Annotations {
  return [...annotations, { name: ALIAS, value: written }];
}

function flattenArguments(
  ref: TypeRef,
  namespace: ReadonlyMap<string, TypeDefinition>,
  minted: ReadonlySet<string>,
): TypeRef {
  if (ref.arguments.length === 0) {
    return ref;
  }
  const args: TypeArgument[] = ref.arguments.map((argument) => {
    if (argument.kind !== 'ref') {
      return argument;
    }
    const flattenedRef = flattenRef(argument.ref, namespace, minted);
    return flattenedRef === argument.ref ? argument : { kind: 'ref', ref: flattenedRef };
  });
  const changed = args.some((argument, i) => argument !== ref.arguments[i]);
  return changed ? { ...ref, arguments: args } : ref;
}

/**
 * The first name in `name`'s reference chain that is not a `REFERENCE` entry, or `name` itself
 * when it is not one. A cycle stops at the name that closes it rather than spinning: an
 * unsatisfiable alias loop is a later work package's verdict to give (linking), not this pass's.
 */
function terminalName(
  name: string,
  namespace: ReadonlyMap<string, TypeDefinition>,
  minted: ReadonlySet<string>,
): string {
  const walked = new Set<string>();
  let current = name;
  while (!walked.has(current)) {
    walked.add(current);
    const definition = namespace.get(current);
    if (definition?.kind !== 'REFERENCE' || !isReferenceBody(definition.body)) {
      return current;
    }
    // Stop *at* a materialised instantiation rather than walking through it -- see this module's
    // own doc on the extra REFERENCE hop this model gives one over the form that holds the shape.
    if (minted.has(current)) {
      return current;
    }
    // An argument-bearing target is an application, not a further hop -- only a template's own
    // body can hold one, and a template is never a use site.
    if (definition.body.target.arguments.length > 0) {
      return current;
    }
    current = definition.body.target.name;
  }
  return current;
}
