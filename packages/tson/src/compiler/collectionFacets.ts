/**
 * [TSON-SCHEMA] §5.7's facet kinds for a refinement of an array, a map or a namespace type, `!tags ^ { min_items:
 * 2 }`, judged over effective values: both bodies are bound, so a facet neither wrote compares at the constructor's
 * default. The bounds move inward; a type slot and `ordered` are restated only, the one saying what an element is
 * and the other what two values being equal means; `unique_items` only rises and `voidable` only falls, each a
 * permission withdrawn. A type slot compares as held: two names reaching one entry are one type (§5.7), and a
 * refined body reaching here holds the source's spelling for them, the resolver having judged a restatement by
 * another name already.
 *
 * @module
 */
import type { ArrayBody, MapBody, NamespaceBody } from '../schema/meta/bodies.js';
import { typeExprText } from '../schema/meta/bodies.js';
import type { TypeExpr } from '../schema/meta/typedef.js';
import { sameTypeExpr } from '../schema/meta/typeInline.js';
import { checkAtLeast, checkAtMost, checkOnlyWithdraws } from './atomNarrowing.js';

/** A collection a refinement narrows: a type built by `meta.array`, `meta.map` or `meta.namespace`. */
export type CollectionBody = ArrayBody | MapBody | NamespaceBody;

/** Whether `body` is a collection {@link narrowing} judges. */
export function isCollection(body: { readonly kind: string }): body is CollectionBody {
  return body.kind === 'array' || body.kind === 'map' || body.kind === 'namespace';
}

/**
 * Each way `refined` moves a facet of `source` outward, empty where it narrows. Two bodies of different
 * constructors are never compared: a refinement is built by its source's constructor.
 */
export function narrowing(source: CollectionBody, refined: CollectionBody): string[] {
  const out: string[] = [];
  if (source.kind === 'array' && refined.kind === 'array') {
    restated(out, 'element_type', source.elementType, refined.elementType);
    checkOnlyWithdraws(out, 'voidable', source.voidable, refined.voidable);
    restatedFlag(out, 'ordered', source.ordered, refined.ordered);
    checkOnlyWithdraws(
      out,
      'duplicate items (unique_items: false)',
      !source.uniqueItems,
      !refined.uniqueItems,
    );
  } else if (source.kind !== 'array' && refined.kind !== 'array') {
    // `meta.namespace` composes `meta.map` and adds no field beside the ones it takes, so a namespace type is
    // judged as the map its values are read by; its `voidable` is pinned false.
    restated(out, 'key_type', source.keyType, refined.keyType);
    restated(out, 'value_type', source.valueType, refined.valueType);
    checkOnlyWithdraws(out, 'voidable', voidableOf(source), voidableOf(refined));
    restatedFlag(out, 'ordered', source.ordered, refined.ordered);
  } else {
    out.push(`a ${refined.kind} type replaces the source's own ${source.kind} type`);
    return out;
  }
  checkAtLeast(out, 'min_items', source.minItems, refined.minItems, compareCounts);
  checkAtMost(out, 'max_items', source.maxItems, refined.maxItems, compareCounts);
  return out;
}

/** The violation of a refinement writing `refined` at `facet`, fixed at `source`. */
export function replaced(facet: string, source: string, refined: string): string {
  return `${facet} ${refined} replaces the source's own ${source}, and a refinement only restates ${facet}`;
}

function voidableOf(body: MapBody | NamespaceBody): boolean {
  return body.kind === 'map' ? body.voidable : false;
}

function restated(out: string[], facet: string, source: TypeExpr, refined: TypeExpr): void {
  if (!sameTypeExpr(source, refined)) {
    out.push(replaced(facet, typeExprText(source), typeExprText(refined)));
  }
}

function restatedFlag(out: string[], facet: string, source: boolean, refined: boolean): void {
  if (source !== refined) out.push(replaced(facet, String(source), String(refined)));
}

function compareCounts(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
