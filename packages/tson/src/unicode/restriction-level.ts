import {
  scriptOf,
  SCRIPT_BOPOMOFO,
  SCRIPT_COMMON,
  SCRIPT_CYRILLIC,
  SCRIPT_GREEK,
  SCRIPT_HAN,
  SCRIPT_HANGUL,
  SCRIPT_HIRAGANA,
  SCRIPT_INHERITED,
  SCRIPT_KATAKANA,
  SCRIPT_LATIN,
  SCRIPT_UNKNOWN,
  type ScriptId,
} from './uts39.js';

/**
 * UTS #39 §5.2's six restriction levels — [TSON-DATA] §8.2 mechanism 3.
 *
 * A level says which script combinations a single **unit** of text may mix; {@link RestrictionUnit}
 * is the axis §8.2 adds on top, orthogonal to the level: whether that check applies to a name's
 * whole text or to each `_`/`-` delimited segment of it separately. The two axes are genuinely
 * independent — per-segment {@link "HIGHLY_RESTRICTIVE"} and whole-name
 * {@link "MODERATELY_RESTRICTIVE"} are incomparable, the first admitting `id_пользователя` (Latin
 * and Cyrillic, never inside one word) while refusing Latin+Devanagari, the second the reverse —
 * so a single ordered knob cannot express both, which is why {@link satisfiesRestrictionLevel}
 * takes them as two separate parameters.
 *
 * §8.2's own reasons for keeping this a policy rather than a validity rule: the levels are
 * computed from `Script`, which the Unicode Consortium does not freeze, so a verdict can change
 * under a routine Unicode Character Database refresh — nothing here may decide whether a document
 * is *valid*, only whether this processor accepts it under a stated policy and UTS #39 data
 * version ({@link "./uts39.js"} `UTS39_VERSION`).
 */
export type RestrictionLevel =
  /** Every character in the ASCII range. */
  | 'ASCII_ONLY'
  /** ASCII-only, or covered by one script (Common and Inherited ignored). */
  | 'SINGLE_SCRIPT'
  /** Single-script, or one of Latin+Jpan, Latin+Hanb, Latin+Kore (§5.2's augmented sets). */
  | 'HIGHLY_RESTRICTIVE'
  /** Highly Restrictive, or Latin and any one other script except Cyrillic and Greek. */
  | 'MODERATELY_RESTRICTIVE'
  /** No script restriction. The identifier profile (mechanism 2) still applies. */
  | 'MINIMALLY_RESTRICTIVE'
  /**
   * No script restriction, and — unlike every level above — the identifier profile does not
   * apply either: §5.2 is explicit that this level alone drops it, taking the obsolete/technical
   * exclusions and the joiner restriction with it. A deployment that means "stop checking
   * scripts" wants {@link "MINIMALLY_RESTRICTIVE"}; §5.2 calls this one a diagnostic tool. Whether
   * the identifier profile applies is outside this module's job — {@link satisfiesRestrictionLevel}
   * answers only the script question, and a caller composing mechanism 2 on top decides for
   * itself whether this level's text still needs it.
   */
  | 'UNRESTRICTED';

/**
 * §8.2's one refinement over UTS #39 §5.2: which slice of a name a level is checked against.
 * `_`/`-` are word separators in a name and ordinary characters in a value (§8.2 "Values"), so
 * this axis applies to names only.
 */
export type RestrictionUnit =
  /** The level applies to the name's complete text. */
  | 'WHOLE_NAME'
  /** The level applies to each `_`/`-` delimited segment independently. */
  | 'PER_SEGMENT';

/** §8.2's RECOMMENDED default level. */
export const DEFAULT_RESTRICTION_LEVEL: RestrictionLevel = 'HIGHLY_RESTRICTIVE';

/** §8.2's RECOMMENDED default unit — the whole name, not per-segment. */
export const DEFAULT_RESTRICTION_UNIT: RestrictionUnit = 'WHOLE_NAME';

/** Latin + Han + Hiragana + Katakana (Latn + Jpan). */
const JPAN: ReadonlySet<ScriptId> = new Set([
  SCRIPT_LATIN,
  SCRIPT_HAN,
  SCRIPT_HIRAGANA,
  SCRIPT_KATAKANA,
]);

/** Latin + Han + Bopomofo (Latn + Hanb). */
const HANB: ReadonlySet<ScriptId> = new Set([SCRIPT_LATIN, SCRIPT_HAN, SCRIPT_BOPOMOFO]);

/** Latin + Han + Hangul (Latn + Kore). */
const KORE: ReadonlySet<ScriptId> = new Set([SCRIPT_LATIN, SCRIPT_HAN, SCRIPT_HANGUL]);

/** §5.2 names these two as the exceptions Moderately Restrictive does *not* pair with Latin. */
const CONFUSABLE_WITH_LATIN: ReadonlySet<ScriptId> = new Set([SCRIPT_CYRILLIC, SCRIPT_GREEK]);

function isSubsetOf(scripts: ReadonlySet<ScriptId>, of: ReadonlySet<ScriptId>): boolean {
  for (const script of scripts) if (!of.has(script)) return false;
  return true;
}

/** The scripts `unit` is written in, ignoring Common, Inherited, and Unknown (§5.1). */
function scriptsOf(unit: string): Set<ScriptId> {
  const seen = new Set<ScriptId>();
  for (let i = 0; i < unit.length;) {
    // `i < unit.length` already guarantees a code point here; the fallback is unreachable and
    // never a valid script id, so it costs nothing to keep this total rather than asserted.
    const codePoint = unit.codePointAt(i) ?? -1;
    i += codePoint > 0xffff ? 2 : 1;
    const script = scriptOf(codePoint);
    if (script !== SCRIPT_COMMON && script !== SCRIPT_INHERITED && script !== SCRIPT_UNKNOWN) {
      seen.add(script);
    }
  }
  return seen;
}

/** Whether `scripts` — already known to mix more than one script — is a combination `level` admits. */
function covered(scripts: ReadonlySet<ScriptId>, level: RestrictionLevel): boolean {
  if (level === 'SINGLE_SCRIPT') return false;
  if (isSubsetOf(scripts, JPAN) || isSubsetOf(scripts, HANB) || isSubsetOf(scripts, KORE))
    return true;
  if (level !== 'MODERATELY_RESTRICTIVE') return false;

  // Latin and any one other script, except the two §5.2 names as confusable with Latin.
  if (!scripts.has(SCRIPT_LATIN)) return false;
  let other: ScriptId | undefined;
  for (const script of scripts) {
    if (script === SCRIPT_LATIN) continue;
    if (other !== undefined) return false;
    other = script;
  }
  return other !== undefined && !CONFUSABLE_WITH_LATIN.has(other);
}

/**
 * Whether one unit of text — the whole name, or one `_`/`-` delimited segment of it — satisfies
 * `level`.
 *
 * Empty text always satisfies every level: {@link satisfiesRestrictionLevel} is what decides
 * whether `unit` is itself empty (a leading, trailing, or repeated separator under
 * `'PER_SEGMENT'`) and skips calling this at all in that case, matching §8.2's own segmentation,
 * which considers only the non-empty runs between separators.
 */
function satisfiesLevelOverUnit(unit: string, level: RestrictionLevel): boolean {
  if (level === 'MINIMALLY_RESTRICTIVE' || level === 'UNRESTRICTED') return true;

  if (level === 'ASCII_ONLY') {
    for (let i = 0; i < unit.length; i++) if (unit.charCodeAt(i) >= 0x80) return false;
    return true;
  }

  const scripts = scriptsOf(unit);
  return scripts.size <= 1 || covered(scripts, level);
}

/**
 * Whether `text` satisfies `level` (default {@link DEFAULT_RESTRICTION_LEVEL}) applied over
 * `unit` (default {@link DEFAULT_RESTRICTION_UNIT}) — UTS #39 §5.2, refined by [TSON-DATA] §8.2's
 * unit distinction.
 *
 * `'WHOLE_NAME'` checks `text` as one unit; empty text satisfies every level. `'PER_SEGMENT'`
 * splits on `_`/`-`, checking each non-empty segment independently and skipping empty ones (a
 * leading, trailing, or doubled separator) — a leading/trailing/doubled separator is not itself
 * a script-mixing problem this mechanism exists to catch.
 */
export function satisfiesRestrictionLevel(
  text: string,
  level: RestrictionLevel = DEFAULT_RESTRICTION_LEVEL,
  unit: RestrictionUnit = DEFAULT_RESTRICTION_UNIT,
): boolean {
  if (level === 'MINIMALLY_RESTRICTIVE' || level === 'UNRESTRICTED') return true;

  if (unit === 'WHOLE_NAME') {
    return text.length === 0 || satisfiesLevelOverUnit(text, level);
  }

  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (
      i < text.length &&
      text.charCodeAt(i) !== 0x5f /* _ */ &&
      text.charCodeAt(i) !== 0x2d /* - */
    ) {
      continue;
    }
    if (i > start && !satisfiesLevelOverUnit(text.slice(start, i), level)) return false;
    start = i + 1;
  }
  return true;
}
