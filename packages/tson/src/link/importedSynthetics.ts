/**
 * Two imports' entries under one name that are one synthetic ([TSON-SCHEMA] §8.2): the rule both import
 * merges apply, the resolver's (`compiler/schemaResolver.ts`) and the linker's (`link/link.ts`).
 *
 * **A synthetic is identified by its form, not by the document that minted it.** Its name is derived from the
 * form alone, so two documents that write `[text]` without importing each other each mint `array_text_…`, and
 * a schema importing both reaches the one type twice. That is unification, as one schema reached by two routes
 * is, and not §2.2.3's collision of two declarations: the first arrival is kept, its declaring schema stays its
 * origin, and every use in either document names it. A name only one side marks synthetic is a declared entry
 * meeting a minted one, and stays the collision.
 *
 * **The two bodies must agree, and a disagreement is an internal invariant break**, neither the author's error
 * nor a gap: both minting sites render the form canonically before deriving the name, so equal names mean
 * equal forms. Each route's link credits `subtypes` against its own view of the namespace, so the comparison
 * leaves them out.
 */
import { TsonInternalError } from '../core/errors.js';
import type { EntryFacts, Top } from '../schema/meta/typedef.js';
import { chainOf, withChain } from '../schema/meta/typedef.js';

/** `value` as JSON, a `Map` as its entries and a `bigint` as text, so two bodies compare by what they hold. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (value instanceof Map) return [...(value as Map<unknown, unknown>)];
  return value;
}

function withoutSubtypes(value: Top): Top {
  const chain = chainOf(value);
  return chain.subtypes.length === 0 ? value : withChain(value, { ...chain, subtypes: [] });
}

/**
 * Whether the incumbent and arriving entries under `name`, declared by two different schemas, are one
 * synthetic: `true` when both are marked synthetic, so the arrival unifies with the incumbent; `false` when
 * either is a declared entry, which the caller refuses as the collision it is.
 *
 * @throws TsonInternalError where both are synthetic and their bodies differ
 */
export function areOneSynthetic(
  name: string,
  incumbentFacts: EntryFacts | undefined,
  incumbent: Top,
  incumbentOrigin: string,
  arrivingFacts: EntryFacts | undefined,
  arriving: Top,
  arrivingOrigin: string,
): boolean {
  if (incumbentFacts?.synthetic !== true || arrivingFacts?.synthetic !== true) return false;
  if (
    JSON.stringify(withoutSubtypes(incumbent), replacer) !==
    JSON.stringify(withoutSubtypes(arriving), replacer)
  ) {
    throw new TsonInternalError(
      `'${incumbentOrigin}' and '${arrivingOrigin}' each mint the internal name '${name}' for a different ` +
        'form ([TSON-SCHEMA] §8.2 derives the name from the form alone)',
    );
  }
  return true;
}

/**
 * The facts of one synthetic reached through two imports: the incumbent's, with every application either side
 * closed to it. A form one document lifts directly and another reaches by closing a template's open synthetic
 * closes different applications, and the importer resolves each of them.
 */
export function unifiedFacts(incumbent: EntryFacts, arriving: EntryFacts): EntryFacts {
  const own = incumbent.closes ?? [];
  const theirs = arriving.closes ?? [];
  const fresh = theirs.filter(
    (application) => !own.some((known) => JSON.stringify(known) === JSON.stringify(application)),
  );
  return fresh.length === 0 ? incumbent : { ...incumbent, closes: [...own, ...fresh] };
}
