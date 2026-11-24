/**
 * Which variant of a choice each tag selects ([TSON-SCHEMA] §5.4, §7.2): a name meaning a variant selects it, before
 * any variant it only IS-A; a name IS-A exactly one variant and meaning none selects that one; a name IS-A more than
 * one and meaning none selects none, a validation error at the data. One tally for every encoding's choice reader,
 * which is why it lives in `link/`, the zone both readers reach.
 *
 * A variant written in place has no name, so no tag names it and nothing IS-A it (§4.2): it adds nothing here. A
 * variant is judged by the entry it reaches past its alias hops (§8.3).
 *
 * An extern has no subtypes in the namespace holding it; its variant's names are the ones its position admits,
 * judged of the entries by identity (§5.13). That half is the extern's own (`ExternAdmission` in the reference),
 * and enters through {@link ChoiceSelectionOptions.externNames}.
 *
 * @module
 */
import type { Top, TypeExpr, TypeRef } from '../schema/meta/typedef.js';
import { subtypesOf } from '../schema/meta/typedef.js';
import { admitting, terminal } from './aliasChain.js';

/** The names an extern variant's position admits, split by how each reaches the variant (§5.13). */
export interface ExternVariantNames {
  /** Names reaching the extern's target: each means the variant. */
  readonly target: Iterable<string>;
  /** Names IS-A the extern's target: each a subtype of the variant. */
  readonly subtype: Iterable<string>;
}

export interface ChoiceSelectionOptions {
  /** The names an extern variant admits, or `undefined` for a variant that is no extern. */
  readonly externNames?: (variant: TypeRef) => ExternVariantNames | undefined;
}

/** The selection over one choice's named variants. */
export interface ChoiceSelection {
  /** Each name a tag may carry, to the variant it selects. */
  readonly selects: ReadonlyMap<string, TypeRef>;
  /** The names of {@link selects} meaning their variant, rather than IS-A it. */
  readonly named: ReadonlySet<string>;
  /** Each name IS-A more than one variant and meaning none, to those variants' names. */
  readonly selectsNone: ReadonlyMap<string, readonly string[]>;
}

/** The variants of `variants` that are names, in declaration order. */
export function namedVariants(variants: readonly TypeExpr[]): TypeRef[] {
  return variants.filter((variant): variant is TypeRef => variant.kind !== 'inline');
}

/**
 * The selection over `variants`, a choice's variants, in `entries`, the linked schema's merged namespace: each
 * variant's names are the entries meaning it past their alias chains, and the names below it those meaning an entry
 * in its `subtypes`.
 */
export function choiceSelection(
  variants: readonly TypeExpr[],
  entries: ReadonlyMap<string, Top>,
  options: ChoiceSelectionOptions = {},
): ChoiceSelection {
  const lookup = (name: string): Top | undefined => entries.get(name);
  const named = namedVariants(variants);
  const selects = new Map<string, TypeRef>();
  for (const variant of named) selects.set(variant.name, variant);
  for (const variant of named) {
    const end = terminal(variant.name, lookup);
    for (const written of admitting([end], entries)) {
      if (!selects.has(written)) selects.set(written, variant);
    }
    for (const written of options.externNames?.(variant)?.target ?? []) {
      if (!selects.has(written)) selects.set(written, variant);
    }
  }
  const meaning = new Set(selects.keys());
  const below = new Map<string, TypeRef[]>();
  for (const variant of named) {
    const end = terminal(variant.name, lookup);
    const under = new Set<string>(admitting(subtypesOf(entries.get(end)), entries));
    for (const written of options.externNames?.(variant)?.subtype ?? []) under.add(written);
    for (const written of under) {
      if (meaning.has(written)) continue;
      const isA = below.get(written);
      if (isA === undefined) below.set(written, [variant]);
      else if (!isA.includes(variant)) isA.push(variant);
    }
  }
  const selectsNone = new Map<string, readonly string[]>();
  for (const [written, isA] of below) {
    const [only] = isA;
    if (isA.length === 1 && only !== undefined) selects.set(written, only);
    else
      selectsNone.set(
        written,
        isA.map((variant) => variant.name),
      );
  }
  return { selects, named: meaning, selectsNone };
}
