/**
 * What a tag may name at a position typed by an extern ([TSON-SCHEMA] §7.9): every name of the enclosing scope,
 * extern or not, that reaches past its aliases and externs the entry the extern lands on or an entry IS-A it, or,
 * where that entry is a choice, selects one of its variants as a tag at a choice does (§5.4), the entries compared
 * by identity. A fact of the link, so every encoding's boundary reader, and a choice of which the extern is a
 * variant, admit one set.
 */
import type { Top } from '../schema/meta/typedef.js';
import { supertypesOf } from '../schema/meta/typedef.js';
import { terminal } from './aliasChain.js';
import {
  declaringIdentity,
  identityOfLanding,
  landingDefinition,
  landingIn,
  type Landing,
} from './externTarget.js';
import type { LinkedSchema } from './link.js';

/** How an admitted name reaches what the extern lands on. */
export type AdmittedBy =
  /** It reaches the entry itself, and names it as the extern does. */
  | 'TARGET'
  /** It reaches an entry IS-A the target (§7.2). */
  | 'SUBTYPE'
  /** It selects a variant of the target, a choice: it reaches one, or an entry IS-A exactly one (§5.4). */
  | 'VARIANT';

/**
 * An admitted name: `terminal` past its alias chain in the enclosing scope, the landing of the extern it reaches
 * through (`through`, absent for a name that is no extern), the entry it reaches, as the schema that declares it and
 * its name there, and how that entry stands to the extern's own landing.
 */
export interface Admitted {
  readonly terminal: string;
  readonly through?: Landing;
  readonly declaringSchema: string;
  readonly entry: string;
  readonly reached: Top;
  readonly by: AdmittedBy;
}

/** The entry's identity: its declaring schema, canonical, and its path there (§8.3). */
export function admittedIdentity(admitted: Admitted): string {
  return `${admitted.declaringSchema}#${admitted.entry}`;
}

/**
 * The names a scope admits at a position typed by one of its externs: the entry the extern lands on, each admitted
 * name in the enclosing scope's declaration order with the entry it reaches, and each name of the enclosing scope
 * IS-A more than one variant of a choice the extern lands on and reaching none, to those variants' names -- it
 * selects none (§5.4).
 */
export interface ExternAdmission {
  readonly landing: Landing;
  readonly admitted: ReadonlyMap<string, Admitted>;
  readonly selectsNone: ReadonlyMap<string, readonly string[]>;
}

/**
 * The names `linked`'s scope admits at a position typed by its extern `extern`, or `undefined` where `extern` is
 * attached to no entry -- a schema holding such an extern does not link, so a compiled reader never asks.
 */
export function externAdmission(linked: LinkedSchema, extern: string): ExternAdmission | undefined {
  const landing = landingIn(linked, extern);
  if (landing === undefined) return undefined;
  const identity = identityOfLanding(landing);
  const variants = variantsOf(landing);
  const admitted = new Map<string, Admitted>();
  const selectsNone = new Map<string, readonly string[]>();
  const lookup = (name: string): Top | undefined => linked.entries.get(name);
  for (const written of linked.entries.keys()) {
    const end = terminal(written, lookup);
    const through = landingIn(linked, written);
    const reached = through === undefined ? lookup(end) : landingDefinition(through);
    if (reached === undefined || (through === undefined && reached.kind === 'extern')) continue;
    const declaring =
      through === undefined
        ? declaringIdentity(linked, end)
        : declaringIdentity(through.in, through.name);
    const entry = through === undefined ? end : through.name;
    const reachedIdentity = `${declaring}#${entry}`;
    // A supertype is a name of the namespace holding the entry, so its identity is read there.
    const originIn = (name: string): string =>
      through === undefined ? declaringIdentity(linked, name) : declaringIdentity(through.in, name);
    const above = new Set(
      supertypesOf(reached).map((supertype) => `${originIn(supertype)}#${supertype}`),
    );
    let by: AdmittedBy;
    if (reachedIdentity === identity) {
      by = 'TARGET';
    } else if (variants.has(reachedIdentity)) {
      by = 'VARIANT'; // a variant the tag names is selected before one its type only IS-A (§5.4)
    } else if (above.has(identity)) {
      by = 'SUBTYPE';
    } else {
      const among = [...variants].filter(([key]) => above.has(key)).map(([, name]) => name);
      if (among.length > 1) selectsNone.set(written, among);
      if (among.length !== 1) continue;
      by = 'VARIANT';
    }
    admitted.set(written, {
      terminal: end,
      ...(through === undefined ? {} : { through }),
      declaringSchema: declaring,
      entry,
      reached,
      by,
    });
  }
  return { landing, admitted, selectsNone };
}

/**
 * The names a choice's extern variant answers to (§5.4, §5.13): an extern has no subtypes in the namespace holding
 * it, so its names are the ones its position admits, judged of the entries by identity -- one reaching the target
 * names the variant, one reaching an entry IS-A it is a subtype, and one selecting a variant of a choice the extern
 * lands on is neither, IS-A being no relation to a choice.
 */
export interface ExternVariantNames {
  readonly named: readonly string[];
  readonly subtypes: readonly string[];
}

/** The names the choice variant `variant` of `linked` answers to, or `undefined` where it is no attached extern. */
export function externVariantNames(
  linked: LinkedSchema,
  variant: string,
): ExternVariantNames | undefined {
  const lookup = (name: string): Top | undefined => linked.entries.get(name);
  const end = terminal(variant, lookup);
  if (lookup(end)?.kind !== 'extern') return undefined;
  const admission = externAdmission(linked, end);
  if (admission === undefined) return undefined;
  const named: string[] = [];
  const subtypes: string[] = [];
  for (const [written, reach] of admission.admitted) {
    if (reach.by === 'TARGET') named.push(written);
    else if (reach.by === 'SUBTYPE') subtypes.push(written);
  }
  return { named, subtypes };
}

/**
 * Whether a value at a position typed by `definition` must name a subtype: an abstract record naming no selectors,
 * which has no direct instances and nothing to place a value by but its tag (§7.2).
 */
export function namesASubtype(definition: Top | undefined): boolean {
  return (
    definition?.kind === 'record' &&
    (definition.parameters?.length ?? 0) === 0 &&
    definition.extension === 'ABSTRACT' &&
    (definition.discriminators ?? []).length === 0
  );
}

/**
 * The identities of a choice's named variants, each past its hops in the namespace holding the choice, to the
 * variant's name as the choice writes it.
 */
function variantsOf(landing: Landing): ReadonlyMap<string, string> {
  const choice = landingDefinition(landing);
  const variants = new Map<string, string>();
  if (choice?.kind !== 'choice') return variants;
  const within = landing.in;
  const lookup = (name: string): Top | undefined => within.entries.get(name);
  for (const variant of choice.variants) {
    if (variant.kind === 'inline') continue;
    const through = landingIn(within, variant.name);
    const key =
      through === undefined
        ? `${declaringIdentity(within, terminal(variant.name, lookup))}#${terminal(variant.name, lookup)}`
        : identityOfLanding(through);
    if (!variants.has(key)) variants.set(key, variant.name);
  }
  return variants;
}
