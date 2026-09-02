import { firstConfusableCollision } from './skeleton.js';
import {
  DEFAULT_RESTRICTION_LEVEL,
  DEFAULT_RESTRICTION_UNIT,
  satisfiesRestrictionLevel,
  type RestrictionLevel,
  type RestrictionUnit,
} from './restriction-level.js';
import { identifierStatusAllowed, UTS39_VERSION } from './uts39.js';
import { isXidContinue } from './xid.js';

/**
 * [TSON-DATA] §8.2's name-hygiene policy, as one immutable value a caller holds and a reader
 * applies over a named scope -- the port of the pinned Java reference's `TsonUnicodePolicy`
 * (`tson-compiler/.../TsonUnicodePolicy.java`) and `TsonConfig`'s `identifierPolicy`, reshaped
 * for this port: the Java models mechanism 3 alone as `TsonUnicodePolicy` and wires mechanism 1
 * (`ConfusableNames`) separately and unconditionally; §8.2 requires a deployment to be able to
 * relax *any* of the three, so this type holds all three together as one value.
 *
 * **Not a class with builder methods.** `restriction-level.ts` and every other file in this
 * directory are plain functions over plain readonly data, and a Java `perSegment()`/`permitting`
 * fluent surface does not fit that -- see this module's own `with*` functions below for the same
 * "relax one axis, get a new value back" shape spelled as plain functions instead.
 *
 * **Each field is independently a deployment's to relax, and relaxing one never silently relaxes
 * another** -- §8.2: "A processor MUST allow a deployment to relax any of the three... and MUST
 * NOT allow that relaxation to be silent." The one place two fields compose is UTS #39 §5.2 itself,
 * not this port's choice: {@link appliesIdentifierProfile} folds in `restrictionLevel ===
 * 'UNRESTRICTED'` because §5.2 says that level alone drops the identifier profile too ("taking
 * `Identifier_Status` with it"), so `identifierStatus: true` at `'UNRESTRICTED'` still checks
 * nothing -- the level, not this type, is what took the profile away.
 */
export interface NamePolicy {
  /**
   * Mechanism 1 (default `true`): no two names in one scope may share a UTS #39 `skeleton()`
   * (`./skeleton.js`'s own `firstConfusableCollision`). A relation over the scope, not a property
   * of one name -- it never fires on a lone name, `id_пользователя` included.
   */
  readonly skeletonDistinctness: boolean;
  /**
   * Mechanism 2 (default `true`): every `XID_Continue` character of a name must be
   * `Identifier_Status=Allowed` (UTS #39 §3.1). The profile-extension character `-` is not
   * `XID_Continue`, carries no `Identifier_Status`, and never fails this on its own account.
   */
  readonly identifierStatus: boolean;
  /**
   * Mechanism 3's level (default {@link DEFAULT_RESTRICTION_LEVEL}, "Highly Restrictive"): the
   * UTS #39 §5.2 restriction level a name must satisfy. Every one of the six levels is a
   * conforming position -- §8.2: "An implementation MUST NOT offer a report-but-accept mode for
   * the levels of mechanism 3" -- so relaxing this field is a straight substitution, never a
   * severity dial.
   */
  readonly restrictionLevel: RestrictionLevel;
  /**
   * Mechanism 3's unit (default {@link DEFAULT_RESTRICTION_UNIT}, "whole name"): §8.2's own
   * refinement over UTS #39, applying `restrictionLevel` to the name's complete text or to each
   * `_`/`-` delimited segment of it. §8.2 names this, not the level, as "the relaxation to reach
   * for first".
   */
  readonly restrictionUnit: RestrictionUnit;
}

/** §8.2's defaults: mechanisms 1 and 2 on, mechanism 3 at Highly Restrictive over the whole name. */
export const DEFAULT_NAME_POLICY: NamePolicy = {
  skeletonDistinctness: true,
  identifierStatus: true,
  restrictionLevel: DEFAULT_RESTRICTION_LEVEL,
  restrictionUnit: DEFAULT_RESTRICTION_UNIT,
};

/** `policy` with mechanism 1 (skeleton distinctness) switched on or off. A code decision, never read from the environment (§8.2). */
export function withSkeletonDistinctness(policy: NamePolicy, enabled: boolean): NamePolicy {
  return { ...policy, skeletonDistinctness: enabled };
}

/** `policy` with mechanism 2 (`Identifier_Status`) switched on or off, independent of {@link NamePolicy.restrictionLevel}. */
export function withIdentifierStatus(policy: NamePolicy, enabled: boolean): NamePolicy {
  return { ...policy, identifierStatus: enabled };
}

/**
 * `policy` at `level`, over `unit` (default: `policy`'s own current unit, left unchanged). §8.2's
 * own advice: reach for {@link "PER_SEGMENT"} before reaching for a looser `level` -- it still
 * refuses every within-word homograph while admitting `id_пользователя`, `url_адрес`, `alpha_α`.
 */
export function withRestrictionLevel(
  policy: NamePolicy,
  level: RestrictionLevel,
  unit: RestrictionUnit = policy.restrictionUnit,
): NamePolicy {
  return { ...policy, restrictionLevel: level, restrictionUnit: unit };
}

/** `policy` with mechanism 3 applied per `_`/`-` delimited segment rather than to the whole name -- the relaxation §8.2 recommends trying first. */
export function perSegment(policy: NamePolicy): NamePolicy {
  return { ...policy, restrictionUnit: 'PER_SEGMENT' };
}

/**
 * Whether mechanism 2 actually runs for `policy`: its own flag, *and* UTS #39 §5.2's own rule
 * that {@link "UNRESTRICTED"} drops the identifier profile along with the script restriction --
 * see {@link NamePolicy}'s own top note on why that composition lives here rather than as a
 * second independent field.
 */
export function appliesIdentifierProfile(policy: NamePolicy): boolean {
  return policy.identifierStatus && policy.restrictionLevel !== 'UNRESTRICTED';
}

/**
 * §8.2's "Values" paragraph: the restriction level applied to *every token a read pulls off the
 * stream*, mechanism 3's peer on the value surface rather than the name surface. No
 * {@link NamePolicy.skeletonDistinctness}/{@link NamePolicy.identifierStatus} equivalents exist
 * here: skeleton distinctness is a relation and values have no scope to hold one over (two values
 * in one array need not be distinguishable, and two values in different documents cannot be
 * compared at all), and §5.2 collapses `MINIMALLY_RESTRICTIVE`/`UNRESTRICTED` into the same
 * no-profile-to-drop position for a token that is not a name in the first place.
 *
 * There is deliberately no `restrictionUnit` field: {@link tokenPolicy} is the only way to build
 * one, and it refuses a per-segment unit outright rather than accepting and ignoring it.
 */
export interface TokenPolicy {
  readonly restrictionLevel: RestrictionLevel;
}

/** §8.2's default for tokens: Unrestricted, so no scan runs at all. */
export const DEFAULT_TOKEN_POLICY: TokenPolicy = { restrictionLevel: 'UNRESTRICTED' };

/**
 * Builds a {@link TokenPolicy} at `restrictionLevel`.
 *
 * `unit` exists on this signature only so a caller building one from the same two axes a
 * {@link NamePolicy} uses can be refused outright rather than silently accepted: `_` and `-` are
 * word separators by convention in a name and ordinary characters in a value (§8.2 "Values"), so
 * segmenting a token admits UTS #39's own `Toys-Я-Us` -- exactly the spoof a strict token policy
 * exists to refuse. The pinned Java reference throws for the same reason
 * (`TsonConfig#tokenPolicy`); this is the TypeScript equivalent.
 *
 * @throws {Error} if `unit` is `'PER_SEGMENT'`.
 */
export function tokenPolicy(
  restrictionLevel: RestrictionLevel,
  unit: RestrictionUnit = 'WHOLE_NAME',
): TokenPolicy {
  if (unit === 'PER_SEGMENT') {
    throw new Error(
      "a token policy cannot be per-segment: '_' and '-' are ordinary characters in a value, " +
        'not word separators (§8.2 "Values") -- build a whole-text TokenPolicy instead',
    );
  }
  return { restrictionLevel };
}

/** Whether `text` satisfies `policy` (default {@link DEFAULT_TOKEN_POLICY}, which checks nothing). */
export function tokenSatisfiesPolicy(
  text: string,
  policy: TokenPolicy = DEFAULT_TOKEN_POLICY,
): boolean {
  return satisfiesRestrictionLevel(text, policy.restrictionLevel, 'WHOLE_NAME');
}

/**
 * §8.2's "Values" paragraph, applied to `text` (default {@link DEFAULT_TOKEN_POLICY}, which
 * checks nothing): `undefined` when `text` satisfies `policy`, else prose a caller composes into
 * a refusal message.
 *
 * **Restricted-script is the only rule this can fire** — {@link TokenPolicy}'s own doc explains
 * why mechanisms 1 and 2 have no equivalent on the value surface, so unlike
 * {@link nameHygieneRefusal} there is no mechanism to name, no scope to collect, and no `names`
 * array to return; one text, one rule, one detail string.
 *
 * **The returned string never names `text` itself.** The detail is composed without the token so
 * that whatever a caller wraps it in states the token exactly as many times as that wrapper
 * writes it -- one refused token, named once. A detail that opened by naming the token would read
 * twice in any message that also named it, and the only way to be sure that never happens is for
 * this half not to hold the text at all.
 */
export function tokenHygieneRefusal(
  text: string,
  policy: TokenPolicy = DEFAULT_TOKEN_POLICY,
): string | undefined {
  if (tokenSatisfiesPolicy(text, policy)) return undefined;
  return `does not satisfy UTS #39 §5.2's ${policy.restrictionLevel} restriction level (§8.2 "Values")`;
}

// -------------------------------------------------------------------------------------------
// Applying a NamePolicy over a scope
// -------------------------------------------------------------------------------------------

/** §8.2's three mechanisms, by the name a {@link NameHygieneRefusal} reports as having fired. */
export type NameHygieneMechanism =
  'skeleton-distinctness' | 'identifier-status' | 'restriction-level';

/**
 * One name-hygiene refusal: which mechanism fired, over which name(s), and why. `names` holds one
 * name for `'identifier-status'`/`'restriction-level'` (a per-name check), or the confusable pair
 * `[first, second]` for `'skeleton-distinctness'` (a relation) -- `second` is the one a caller
 * locates a diagnostic at, per §8.2's "on detection" ("reported at the second occurrence's
 * position").
 */
export interface NameHygieneRefusal {
  readonly mechanism: NameHygieneMechanism;
  readonly names: readonly string[];
  /** Prose naming what was found -- composed here so every call site states the same reasoning. */
  readonly detail: string;
}

/** ZWNJ (U+200C) and ZWJ (U+200D) -- see this function's own note on why they are excluded here. */
const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/**
 * The first character of `name` that is `XID_Continue` but not `Identifier_Status=Allowed`, or
 * `undefined` when every such character is allowed.
 *
 * **ZWNJ and ZWJ are excluded from this scan, matching the pinned Java reference's own
 * `IdentifierParser.hygiene`** (`tson-compiler/.../atom/IdentifierParser.java`). Both are
 * `Identifier_Status=Restricted`, so a naive scan would refuse them everywhere, but §7.7 rule 2
 * already carves the exception UTS #39 §3.1.1.1 defines: a joiner is admitted only where it has a
 * shaping effect (a Persian compound, an Indic conjunct) and refused everywhere else --
 * `unicode/identifier-profile.ts`'s `isIdentifierText` enforces exactly that as a matter of
 * **form**, ahead of this mechanism, for every name this function is ever handed (a type-ref,
 * annotation, or schema-layer name all pass through `isIdentifierText` first). So by the time a
 * joiner reaches this scan it has already been proven to sit in a permitted context, and
 * mechanism 2 has nothing further to say about it -- treating it as a restricted character here
 * would refuse the very names §7.7 rule 2 exists to admit (`کتاب‌ها`, `ക്‍ക`). `-` is excluded for
 * the same reason as ever: it is this profile's own extension, not an identifier character
 * Unicode assigns a status to, and {@link isXidContinue} already excludes it.
 */
function firstDisallowedIdentifierStatusCharacter(name: string): string | undefined {
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    // `character` iterates `name` code point by code point (see `skeleton.ts`'s own identical
    // note), so this is always defined; kept total rather than asserted.
    if (codePoint === undefined) continue;
    if (codePoint === ZWNJ || codePoint === ZWJ) continue;
    if (isXidContinue(codePoint) && !identifierStatusAllowed(codePoint)) {
      return character;
    }
  }
  return undefined;
}

/**
 * §8.2's record-scope check, applied to `names` (one record's own field names) under `policy`
 * (default {@link DEFAULT_NAME_POLICY}) -- the first mechanism that refuses something, or
 * `undefined` when every name in the scope passes all three.
 *
 * **Per-name mechanisms run first, in `names`' own order**, so the refusal a caller sees for a
 * scope with more than one problem is the earliest one a reader encountered rather than
 * whichever mechanism happens to run last. **Mechanism 1 runs last**, over the whole scope at
 * once, because it is a relation and needs every name collected before it can fire at all.
 *
 * This function decides *whether* a scope is refused; it does not itself throw, report, or know
 * the UTS #39 data version -- `reader/schemaless/tree.ts` is the one Part 1 caller, and
 * `core/errors.ts`'s `TsonNameHygieneRefusedError` is where {@link "./uts39.js"}'s
 * `UTS39_VERSION` is attached, per §8.2's own requirement that a refusal name it.
 */
export function nameHygieneRefusal(
  names: Iterable<string>,
  policy: NamePolicy = DEFAULT_NAME_POLICY,
): NameHygieneRefusal | undefined {
  const checkProfile = appliesIdentifierProfile(policy);
  const collected: string[] = [];
  for (const name of names) {
    collected.push(name);
    if (checkProfile) {
      const disallowed = firstDisallowedIdentifierStatusCharacter(name);
      if (disallowed !== undefined) {
        const codePoint = disallowed.codePointAt(0) ?? 0;
        return {
          mechanism: 'identifier-status',
          names: [name],
          detail:
            `'${name}' contains U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ` +
            `'${disallowed}', which is not Identifier_Status=Allowed (UTS #39 §3.1)`,
        };
      }
    }
    if (!satisfiesRestrictionLevel(name, policy.restrictionLevel, policy.restrictionUnit)) {
      const unit = policy.restrictionUnit === 'PER_SEGMENT' ? 'each segment of' : 'the whole of';
      return {
        mechanism: 'restriction-level',
        names: [name],
        detail:
          `'${name}' does not satisfy UTS #39 §5.2's ${policy.restrictionLevel} restriction ` +
          `level, applied to ${unit} the name`,
      };
    }
  }
  if (policy.skeletonDistinctness) {
    const collision = firstConfusableCollision(collected);
    if (collision !== undefined) {
      return {
        mechanism: 'skeleton-distinctness',
        names: [collision.first, collision.second],
        detail:
          `'${collision.second}' is confusable with '${collision.first}' -- the two are ` +
          'different names that read alike (UTS #39 skeleton), so one of them must be renamed',
      };
    }
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// The stated-once processor policy
// -------------------------------------------------------------------------------------------

/**
 * What this processor's own Unicode configuration does to a document's fate: the two policies
 * §8.2 defines (over names and over values) and the UTS #39 data version they were computed
 * against -- the port of the pinned Java reference's `TsonUnicodeProcessorPolicy`, reachable here
 * off {@link "../config.js"}'s `Tson.processorPolicy`.
 *
 * **Why this exists as a value at all**, rather than being folded into each refusal: §8.2's three
 * rules read data the Unicode Consortium does not freeze, so the same bytes may be accepted by
 * one deployment and refused by another, and that divergence is legitimate but must not be
 * unexplainable. A `Diagnostic` is the wrong carrier for the explanation, for three reasons this
 * type exists to fix:
 *
 * - **Cardinality.** The version is constant for the life of a `Tson` instance; twenty refusals
 *   in one document would otherwise carry twenty copies of a string that cannot differ between
 *   them.
 * - **Time.** A per-diagnostic copy arrives only on failure, after a sender has already written
 *   the document. What a sender needs in order not to fail is the same fact *before* it writes --
 *   which is what asking for this value up front, with no document in hand, gives it.
 * - **Direction.** A version says what refused a document; it does not say what would be
 *   accepted. `16.0` is not actionable the way `ASCII_ONLY` is.
 *
 * **The two policies are not interchangeable.** {@link ProcessorPolicy.identifierPolicy} governs
 * declared names, record field names, type-refs and annotation names, where all three of §8.2's
 * mechanisms apply; {@link ProcessorPolicy.tokenPolicy} governs values, where only the
 * restricted-script rule can (`TokenPolicy`'s own doc). A deployment that has relaxed one has said
 * nothing about the other, which is why both are stated together rather than one standing in for
 * the pair.
 */
export interface ProcessorPolicy {
  /** The policy applied to names -- `Config.identifierPolicy`. */
  readonly identifierPolicy: NamePolicy;
  /** The policy applied to token values -- `Config.tokenPolicy`. */
  readonly tokenPolicy: TokenPolicy;
  /** The UCD release {@link identifierPolicy}/{@link tokenPolicy} were computed against. */
  readonly unicodeDataVersion: string;
}

/**
 * Builds a {@link ProcessorPolicy} from `identifierPolicy`/`tokenPolicy` (each defaulting to its
 * own §8.2 default), stamped with this build's own {@link "./uts39.js"} `UTS39_VERSION`.
 *
 * The version is not a parameter: it is a property of the tables compiled into this library, not
 * a choice a caller makes, so there is nothing to pass for it.
 */
export function processorPolicy(
  identifierPolicy: NamePolicy = DEFAULT_NAME_POLICY,
  tokenPolicy: TokenPolicy = DEFAULT_TOKEN_POLICY,
): ProcessorPolicy {
  return { identifierPolicy, tokenPolicy, unicodeDataVersion: UTS39_VERSION };
}
