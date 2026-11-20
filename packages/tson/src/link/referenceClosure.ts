/**
 * A schema's reference closure ([TSON-SCHEMA] §3.4.1): every document reachable through `!!import` and through the
 * foreign schemas of its externs (§5.13), loaded dependencies first. The relation over imports and externs together
 * MUST be acyclic (§2.2.3, §5.13), and a closure reached through an extern holds the declaring document's kernel.
 *
 * A schema is registered only once it has linked, so a cycle cannot be found by a lookup: being *in flight* is the
 * whole signal, and a document held as text is in flight under its own `!!id`, so a reference reaching it is the
 * cycle, never a fetch.
 */
import { TsonSchemaFetchError, TsonSchemaValidationError } from '../core/errors.js';
import type { SchemaDocument } from '../ast/schema/document.js';
import { canonicalizeIdentity } from './identity.js';
import { writtenExterns, type WrittenExtern } from './externs.js';

/** The edge a link of the closure was reached by: the entry name of the extern that names it, or `undefined` for an import. */
export type ReferenceEdge = string | undefined;

/** One dependency a schema document names: an `!!import`, or an extern's `schema`. */
export interface SchemaDependency {
  readonly reference: string;
  /** The extern naming it, `undefined` for an import. */
  readonly edge: ReferenceEdge;
  /** What the extern writes, for an extern's dependency. */
  readonly written?: WrittenExtern;
}

/**
 * The `!!import`s `document` names, then each extern's `schema` it writes, found by the written head (§5.13). The
 * externs are read only where `holdsKernelExtern`, the document's closure holding the kernel's `meta.extern`: an
 * import-free schema's own `meta.extern` is an ordinary entry, and loads nothing.
 */
export function externDependencies(
  document: SchemaDocument,
  holdsKernelExtern: boolean,
): readonly SchemaDependency[] {
  if (!holdsKernelExtern) return [];
  const dependencies: SchemaDependency[] = [];
  for (const [name, written] of writtenExterns(document.body.declarations)) {
    if (written.schema === undefined) continue;
    dependencies.push({ reference: written.schema, edge: name, written });
  }
  return dependencies;
}

/**
 * The cycle over the reference relation that `identity`, reached by `closing`, closes in `chain` (the identities in
 * flight, outermost first, each with the edge it was reached by): §2.2.3's import cycle, or one an extern takes part
 * in (§5.13), each extern edge marked with the entry it is. An author error, not a library gap.
 */
export function referenceCycle(
  chain: ReadonlyMap<string, ReferenceEdge>,
  identity: string,
  closing: ReferenceEdge,
): TsonSchemaValidationError {
  let path = '';
  let fromCycleStart = false;
  let throughExtern = closing !== undefined;
  for (const [link, edge] of chain) {
    if (fromCycleStart) {
      path += edgeText(edge);
      throughExtern ||= edge !== undefined;
    }
    fromCycleStart ||= link === identity;
    if (fromCycleStart) path += link;
  }
  path += `${edgeText(closing)}${identity}`;
  if (!throughExtern) {
    return new TsonSchemaValidationError(
      `'${identity}' is part of an import cycle (${path}) -- a schema cannot depend, directly or ` +
        'transitively, on one that depends on it, since neither can be resolved before the other ' +
        '([TSON-SCHEMA] §2.2.3). Break the cycle by moving what both need into a third schema they each import',
    );
  }
  return new TsonSchemaValidationError(
    `'${identity}' is part of a reference cycle through an extern (${path}) -- the reference relation over ` +
      'imports and externs together is acyclic, so a schema reaches itself through neither, nor through a mix ' +
      'of the two ([TSON-SCHEMA] §3.4.1, §5.13). Break the cycle by moving what both need into a third schema ' +
      'they each reference',
  );
}

function edgeText(edge: ReferenceEdge): string {
  return edge === undefined ? ' -> ' : ` -[extern '${edge}']-> `;
}

/**
 * Whether `identity` (canonical) is the series' kernel of some revision, `meta.tn` under `tson.io/<year>/<revision>/m/`
 * (§13.2): a kernel is known by its identity, never by its content.
 */
export function isKernelOfAnyRevision(identity: string): boolean {
  const prefix = 'tson.io/';
  const suffix = '/m/meta.tn';
  if (!identity.startsWith(prefix) || !identity.endsWith(suffix)) return false;
  const revision = identity.slice(prefix.length, identity.length - suffix.length).split('/');
  return revision.length === 2 && revision.every((part) => part.length > 0 && isDigits(part));
}

function isDigits(text: string): boolean {
  for (const ch of text) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

/** Whether `chain` was entered through any extern, or `closing` is one. */
export function reachedThroughExtern(
  chain: ReadonlyMap<string, ReferenceEdge>,
  closing: ReferenceEdge,
): boolean {
  if (closing !== undefined) return true;
  for (const edge of chain.values()) if (edge !== undefined) return true;
  return false;
}

/**
 * `error`, thrown loading the foreign schema `written` names, said to have come through the extern `name`: the
 * declaring document is refused whole, as for an import that will not load, the classification kept (§5.13).
 */
export function throughExtern(error: unknown, name: string, written: WrittenExtern): unknown {
  const through = `'${name}' is an extern of '${written.type ?? ''}' in '${written.schema ?? ''}'`;
  if (error instanceof TsonSchemaFetchError) {
    return new TsonSchemaFetchError(
      error.schemaId,
      error.reason,
      `${through}, whose schema is not available: ${error.message}`,
      { cause: error },
    );
  }
  if (
    error instanceof TsonSchemaValidationError &&
    error.constructor === TsonSchemaValidationError
  ) {
    return new TsonSchemaValidationError(
      `${through}, whose schema does not load: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return error;
}

/** `reference`'s canonical identity, or `undefined` where it names none (the resolution reports why). */
export function identityOf(reference: string): string | undefined {
  try {
    return canonicalizeIdentity(reference);
  } catch {
    return undefined;
  }
}
