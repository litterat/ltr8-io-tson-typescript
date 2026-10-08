import {
  profileSeparates,
  restrictedCharacterViolation,
  type IdentifierProfile,
} from './identifier-profile.js';
import { firstConfusableCollision } from './skeleton.js';
import {
  DEFAULT_RESTRICTION_LEVEL,
  DEFAULT_RESTRICTION_UNIT,
  NO_PERMITTED_SCRIPTS,
  satisfiesRestrictionLevel,
  type RestrictionLevel,
  type RestrictionUnit,
  type ScriptCombination,
} from './restriction-level.js';
import { limitsPolicyOf, type LimitsPolicy } from '../core/limits.js';
import { identifierStatusAllowed, UTS39_VERSION, type ScriptId } from './uts39.js';

/**
 * [TSON-DATA] §8.2's restricted-script rule as a policy a caller holds: a UTS #39 §5.2 restriction
 * level and the script combinations admitted over it. It is the **token policy** as it stands (the
 * value surface, §8.2 "Values"), and the script half of an {@link IdentifierPolicy}, which adds
 * what only a name has.
 *
 * **There is no unit.** `_` and `-` are word separators by convention in a name and ordinary
 * characters in a value, so segmenting a value would admit UTS #39's own `Toys-Я-Us`, the spoof a
 * strict token policy exists to refuse. The unit is {@link IdentifierPolicy.perSegment}'s, and a
 * script policy cannot state one.
 *
 * Immutable plain data; {@link permitting} and {@link withRestrictionLevel} return modified copies,
 * so relaxation is always a code decision at the call site and never ambient (§8.2).
 */
export interface ScriptPolicy {
  /**
   * The UTS #39 §5.2 restriction level (default {@link DEFAULT_RESTRICTION_LEVEL}, "Highly
   * Restrictive", for names). Every one of the six levels is a conforming position -- §8.2: "An
   * implementation MUST NOT offer a report-but-accept mode for the levels of mechanism 3" -- so
   * relaxing this field is a straight substitution, never a severity dial. `'UNRESTRICTED'` alone
   * also drops the identifier profile (§5.2), which is how mechanism 2 is relaxed.
   */
  readonly restrictionLevel: RestrictionLevel;
  /**
   * Script combinations admitted over and above {@link restrictionLevel} (default none) -- UTS #39
   * §5.2's own device for its Latn+Jpan/Latn+Hanb/Latn+Kore augmented sets, opened to a caller: a
   * deployment that knows it is Russian names `[SCRIPT_LATIN, SCRIPT_CYRILLIC]` rather than
   * dropping the level and losing the rule everywhere else. `satisfiesRestrictionLevel` checks this
   * list **before** the level's own rules, so an admitted combination overrides even
   * `SINGLE_SCRIPT`. Build one with {@link permitting}, which appends rather than replaces.
   */
  readonly permittedScripts: readonly ScriptCombination[];
}

/**
 * [TSON-DATA] §8.2's **identifier policy**: all three name-hygiene mechanisms, as a deployment
 * configures them for every position that holds a name. It is a {@link ScriptPolicy} (mechanism 3's
 * level, and mechanism 2, which the level carries: `Identifier_Status` applies at every level but
 * `'UNRESTRICTED'`, §5.2) plus the two things only a name has.
 *
 * Each axis is independently a deployment's to relax, and relaxing one never silently relaxes
 * another (§8.2: "A processor MUST allow a deployment to relax any of the three... and MUST NOT
 * allow that relaxation to be silent"). Skeleton distinctness has a switch of its own because no
 * level reaches it: UTS #39 ties `Identifier_Status` to Unrestricted, and nothing ties a relation
 * over a set to a level that judges one name.
 */
export interface IdentifierPolicy extends ScriptPolicy {
  /**
   * Mechanism 3's unit: `false` applies {@link ScriptPolicy.restrictionLevel} to the name's
   * complete text, `true` to each `_`/`-` (or profile-separator) delimited segment of it. §8.2
   * names this, not the level, as "the relaxation to reach for first".
   */
  readonly perSegment: boolean;
  /**
   * Mechanism 1: no two names in one scope may share a UTS #39 `skeleton()`
   * (`./skeleton.js`'s `firstConfusableCollision`). A relation over the scope, not a property of
   * one name -- it never fires on a lone name, `id_пользователя` included.
   */
  readonly skeletonDistinctness: boolean;
}

/** §8.2's recommended identifier policy: Highly Restrictive over the whole name, all three mechanisms on, no admitted combinations. */
export const DEFAULT_IDENTIFIER_POLICY: IdentifierPolicy = {
  restrictionLevel: DEFAULT_RESTRICTION_LEVEL,
  permittedScripts: NO_PERMITTED_SCRIPTS,
  perSegment: false,
  skeletonDistinctness: true,
};

/**
 * An identifier policy that judges nothing: Unrestricted (which drops the identifier profile too),
 * no skeleton distinctness. For a source whose names did not come from document text, and for a
 * read that holds no position at which a member is a name.
 */
export const NO_IDENTIFIER_POLICY: IdentifierPolicy = {
  restrictionLevel: 'UNRESTRICTED',
  permittedScripts: NO_PERMITTED_SCRIPTS,
  perSegment: false,
  skeletonDistinctness: false,
};

/**
 * `policy` with one further script combination admitted (mechanism 3's own relaxation device) --
 * the narrowest relaxation available. Appends to whatever `policy` already admits rather than
 * replacing it, so a caller building up several combinations calls this once per combination.
 *
 * Generic over {@link ScriptPolicy} and {@link IdentifierPolicy} alike.
 */
export function permitting<P extends ScriptPolicy>(policy: P, ...scripts: readonly ScriptId[]): P {
  return { ...policy, permittedScripts: [...policy.permittedScripts, scripts] };
}

/** `policy` with mechanism 1 (skeleton distinctness) switched on or off. A code decision, never read from the environment (§8.2). */
export function withSkeletonDistinctness(
  policy: IdentifierPolicy,
  enabled: boolean,
): IdentifierPolicy {
  return { ...policy, skeletonDistinctness: enabled };
}

/**
 * `policy` at `level`. §8.2's own advice: reach for {@link perSegment} before reaching for a
 * looser level -- it still refuses every within-word homograph while admitting `id_пользователя`,
 * `url_адрес`, `alpha_α`.
 */
export function withRestrictionLevel<P extends ScriptPolicy>(
  policy: P,
  level: RestrictionLevel,
): P {
  return { ...policy, restrictionLevel: level };
}

/** `policy` with mechanism 3 applied per segment (or, with `false`, to the whole name) -- the relaxation §8.2 recommends trying first. */
export function perSegment(policy: IdentifierPolicy, enabled = true): IdentifierPolicy {
  return { ...policy, perSegment: enabled };
}

/** The unit `policy` applies its level over, in `restriction-level.ts`'s vocabulary. */
function unitOf(policy: IdentifierPolicy): RestrictionUnit {
  return policy.perSegment ? 'PER_SEGMENT' : DEFAULT_RESTRICTION_UNIT;
}

/** A {@link ScriptPolicy} at `restrictionLevel`, admitting no further combinations. */
export function scriptPolicy(restrictionLevel: RestrictionLevel): ScriptPolicy {
  return { restrictionLevel, permittedScripts: NO_PERMITTED_SCRIPTS };
}

/** §8.2's default for tokens: Unrestricted, so no scan runs at all, and no admitted combinations. */
export const DEFAULT_TOKEN_POLICY: ScriptPolicy = scriptPolicy('UNRESTRICTED');

/**
 * Whether mechanism 2 (`Identifier_Status`) runs for `policy`: at every level but `'UNRESTRICTED'`,
 * which UTS #39 §5.2 says alone drops the identifier profile ("taking `Identifier_Status` with it").
 */
export function appliesIdentifierProfile(policy: ScriptPolicy): boolean {
  return policy.restrictionLevel !== 'UNRESTRICTED';
}

/** Whether `text` satisfies `policy` (default {@link DEFAULT_TOKEN_POLICY}, which checks nothing). */
export function tokenSatisfiesPolicy(
  text: string,
  policy: ScriptPolicy = DEFAULT_TOKEN_POLICY,
): boolean {
  return satisfiesRestrictionLevel(
    text,
    policy.restrictionLevel,
    'WHOLE_NAME',
    policy.permittedScripts,
  );
}

/**
 * §8.2's "Values" paragraph, applied to `text` (default {@link DEFAULT_TOKEN_POLICY}, which
 * checks nothing): `undefined` when `text` satisfies `policy`, else prose a caller composes into
 * a refusal message.
 *
 * **Restricted-script is the only rule this can fire** — {@link ScriptPolicy}'s own doc explains
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
  policy: ScriptPolicy = DEFAULT_TOKEN_POLICY,
): string | undefined {
  if (tokenSatisfiesPolicy(text, policy)) return undefined;
  return `does not satisfy UTS #39 §5.2's ${policy.restrictionLevel} restriction level (§8.2 "Values")`;
}

// -------------------------------------------------------------------------------------------
// Applying a IdentifierPolicy over a scope
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

/** U+002D HYPHEN-MINUS -- this profile's own token-form extension, excluded below on the same terms as ZWNJ/ZWJ. */
const HYPHEN = 0x2d;

/**
 * The first character of `name` that is not `Identifier_Status=Allowed`, or `undefined` when
 * every character is allowed.
 *
 * **Checks every character, not only ones that are already `XID_Continue`.** A TSON text name
 * reaching this function was already proven `XID_Start`/`XID_Continue`-shaped by the lexer before
 * hygiene ever runs (`unicode/identifier-profile.ts`'s `isIdentifierText`), so for that caller the
 * two conditions coincide. **A JSON member name is not so constrained** ([TSON-JSON] §9.4 reaches
 * "every member name... that matches no declared field") -- it is an arbitrary JSON string, and a
 * character like U+0020 SPACE is outside the identifier profile entirely rather than merely
 * `Identifier_Status=Restricted` within it, so this scan must check it directly rather than gating
 * on `XID_Continue` first, which would let such a character through every one of §8.2's three
 * mechanisms at a JSON position and leave it reported as an ordinary closure error instead of the
 * refusal mechanism 2 exists for. The pinned Java reference's own `IdentifierProfile.hygiene`
 * (`tson-compiler/.../atom/IdentifierParser.java`) checks unconditionally for the same reason
 * (`json-name-hygiene.test.ts`'s own port of the reference's `JsonNameHygieneTest` pins the case:
 * a field name `"no te"` at a position with no field of that name is `RESTRICTED_CHARACTER`, not
 * `UNRECOGNIZED_FIELD`).
 *
 * **ZWNJ, ZWJ and `-` are excluded from this scan, matching the pinned Java reference.** ZWNJ/ZWJ
 * are `Identifier_Status=Restricted`, so a naive scan would refuse them everywhere, but §7.7 rule
 * 2 already carves the exception UTS #39 §3.1.1.1 defines: a joiner is admitted only where it has
 * a shaping effect (a Persian compound, an Indic conjunct) and refused everywhere else --
 * `isIdentifierText` enforces exactly that as a matter of **form**, ahead of this mechanism, for
 * every *text*-side name this function is ever handed. So by the time a joiner reaches this scan
 * by that route it has already been proven to sit in a permitted context, and mechanism 2 has
 * nothing further to say about it -- treating it as a restricted character here would refuse the
 * very names §7.7 rule 2 exists to admit (`کتاب‌ها`, `ക്‍ക`). A JSON member name carrying a joiner
 * with no shaping context reaches this same exclusion and so is not refused by this mechanism
 * either -- conservative (admits rather than wrongly refuses) but not a full implementation of
 * §7.7 rule 2's contextual test at the JSON layer, a recorded gap (`STATUS.md`'s own "Known
 * gaps"). `-` is excluded because it is this profile's own token-form extension, not an
 * identifier character Unicode assigns a status to.
 */
function firstDisallowedIdentifierStatusCharacter(name: string): string | undefined {
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    // `character` iterates `name` code point by code point (see `skeleton.ts`'s own identical
    // note), so this is always defined; kept total rather than asserted.
    if (codePoint === undefined) continue;
    if (codePoint === ZWNJ || codePoint === ZWJ || codePoint === HYPHEN) continue;
    if (!identifierStatusAllowed(codePoint)) {
      return character;
    }
  }
  return undefined;
}

/**
 * §8.2's record-scope check, applied to `names` (one record's own field names) under `policy`
 * (default {@link DEFAULT_IDENTIFIER_POLICY}) -- the first mechanism that refuses something, or
 * `undefined` when every name in the scope passes all three.
 *
 * **Mechanism 1 (skeleton distinctness) runs first, over the whole scope at once**, matching the
 * pinned Java reference's own `TsonSchemaLinker.checkScope`: "its own collision relation, then
 * each name's own two rules". It has to see every name before it can fire at all, since it is a
 * relation rather than a property of one name, which is also why running it first costs nothing
 * a per-name-first order would have saved. **The per-name mechanisms run second, in `names`' own
 * order**, so the refusal a caller sees for a scope where mechanism 1 stays silent is the
 * earliest per-name problem a reader encountered. This ordering matters whenever a pair is both
 * confusable *and* individually mixed-script -- `'admin'`/Cyrillic `'аdmin'` is exactly that pair,
 * and reporting it as `restriction-level` rather than `skeleton-distinctness` would name the wrong
 * remedy: renaming the mixed-script spelling to a single-script one that still collides with
 * `'admin'` would leave the document refused for a reason the diagnostic never mentioned.
 *
 * This function decides *whether* a scope is refused; it does not itself throw, report, or know
 * the UTS #39 data version -- `reader/schemaless/tree.ts` is the one Part 1 caller, and
 * `core/errors.ts`'s `TsonNameHygieneRefusedError` is where {@link "./uts39.js"}'s
 * `UTS39_VERSION` is attached, per §8.2's own requirement that a refusal name it.
 */
export function nameHygieneRefusal(
  names: Iterable<string>,
  policy: IdentifierPolicy = DEFAULT_IDENTIFIER_POLICY,
): NameHygieneRefusal | undefined {
  const collected = [...names];

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

  const checkProfile = appliesIdentifierProfile(policy);
  for (const name of collected) {
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
    if (
      !satisfiesRestrictionLevel(
        name,
        policy.restrictionLevel,
        unitOf(policy),
        policy.permittedScripts,
      )
    ) {
      const unit = policy.perSegment ? 'each segment of' : 'the whole of';
      return {
        mechanism: 'restriction-level',
        names: [name],
        detail:
          `'${name}' does not satisfy UTS #39 §5.2's ${policy.restrictionLevel} restriction ` +
          `level, applied to ${unit} the name`,
      };
    }
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// The stated-once processor policy
// -------------------------------------------------------------------------------------------

/**
 * What this processor will admit and what it will spend -- everything about a read that is neither
 * in the document nor in the schema: the two policies §8.2 defines (over names and over values),
 * §9.1's limits, and the UTS #39 data version the rules were computed against. Reachable off
 * {@link "../config.js"}'s `Tson.processorPolicy`, with no document in hand.
 *
 * **Why this exists as a value at all**, rather than being folded into each refusal: §8.2's three
 * rules read data the Unicode Consortium does not freeze, so the same bytes may be accepted by
 * one deployment and refused by another, and that divergence is legitimate but must not be
 * unexplainable. A `Diagnostic` is the wrong carrier for the explanation, for three reasons:
 *
 * - **Cardinality.** The version is constant for the life of a `Tson` instance; twenty refusals
 *   in one document would otherwise carry twenty copies of a string that cannot differ.
 * - **Time.** A per-diagnostic copy arrives only on failure, after a sender has already written
 *   the document. What a sender needs in order not to fail is the same fact *before* it writes.
 * - **Direction.** A version says what refused a document; it does not say what would be
 *   accepted. `16.0` is not actionable the way `ASCII_ONLY` is.
 *
 * **The two policies are not interchangeable, and have different types because they have
 * different shapes.** {@link ProcessorPolicy.identifierPolicy} governs names, where all three of
 * §8.2's mechanisms apply; {@link ProcessorPolicy.tokenPolicy} governs values, where only the
 * restricted-script rule can. A per-segment token policy is not refused but unwritable. A
 * deployment that has relaxed one has said nothing about the other, which is why both are stated.
 */
export interface ProcessorPolicy {
  /** The policy applied to names -- `Config.identifierPolicy`. */
  readonly identifierPolicy: IdentifierPolicy;
  /** The policy applied to token values -- `Config.tokenPolicy`. */
  readonly tokenPolicy: ScriptPolicy;
  /** What this processor will spend reading a document -- §9.1 and [TSON-SCHEMA] §11.5. */
  readonly limits: LimitsPolicy;
  /** The UCD release {@link identifierPolicy}/{@link tokenPolicy} were computed against. */
  readonly unicodeDataVersion: string;
}

/**
 * Builds a {@link ProcessorPolicy} from its three settings (each defaulting to its own §8.2/§9.1
 * default), stamped with this build's own {@link "./uts39.js"} `UTS39_VERSION`.
 *
 * The version is not a parameter: it is a property of the tables compiled into this library, not
 * a choice a caller makes, so there is nothing to pass for it.
 */
export function processorPolicy(
  identifierPolicy: IdentifierPolicy = DEFAULT_IDENTIFIER_POLICY,
  tokenPolicy: ScriptPolicy = DEFAULT_TOKEN_POLICY,
  limits: LimitsPolicy = limitsPolicyOf(),
): ProcessorPolicy {
  return { identifierPolicy, tokenPolicy, limits, unicodeDataVersion: UTS39_VERSION };
}

// -------------------------------------------------------------------------------------------
// A name judged under its family's profile
// -------------------------------------------------------------------------------------------

/** One per-name rule a name failed (§8.2): which mechanism, and why -- the detail opens with the name or unit refused. */
export interface NameViolation {
  readonly mechanism: 'identifier-status' | 'restriction-level';
  readonly detail: string;
}

/**
 * §8.2's two per-name rules over `name` under `profile`: **every** rule it fails, the
 * restricted-character rule first, or an empty list. A name may fail both, and each wants its own
 * fix -- a character to change, a script to relax -- so each is reported under its own mechanism.
 *
 * A name is judged under its family's profile as well as the policy. The profile says what the
 * name's own characters are: one it adds -- §7.7's `-`, a profile's `$` -- meets no
 * restricted-character rule, and one it adds that is not `XID_Continue` divides the name into
 * segments ({@link profileSeparates}). The policy is the deployment's and the profile the schema's,
 * and neither stands in for the other: §8.2 forbids a schema to carry a policy, and a profile only
 * ever decides what is a name. Skeleton distinctness is a relation over a scope and is judged
 * where a scope is enumerated, not here.
 */
export function judgeName(
  name: string,
  profile: IdentifierProfile,
  policy: IdentifierPolicy,
): readonly NameViolation[] {
  const violations: NameViolation[] = [];
  if (appliesIdentifierProfile(policy)) {
    const detail = restrictedCharacterViolation(profile, name);
    if (detail !== undefined) violations.push({ mechanism: 'identifier-status', detail });
  }
  if (
    !satisfiesRestrictionLevel(
      name,
      policy.restrictionLevel,
      unitOf(policy),
      policy.permittedScripts,
      (codePoint) => profileSeparates(profile, codePoint),
    )
  ) {
    const unit = policy.perSegment ? 'each segment of' : 'the whole of';
    violations.push({
      mechanism: 'restriction-level',
      detail:
        `'${name}' does not satisfy UTS #39 §5.2's ${policy.restrictionLevel} restriction ` +
        `level, applied to ${unit} the name`,
    });
  }
  return violations;
}
