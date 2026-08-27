/**
 * A native RFC 9485 (I-Regexp) engine.
 *
 * Published as `@ltr8/tson/regex`. This subtree is a true leaf — it names no TSON type and
 * imports nothing outside itself, which an `import-x/no-restricted-paths` zone enforces. That
 * isolation is deliberate: I-Regexp is an external standard, and the engine could reasonably
 * become its own package.
 *
 * {@link parseRegex} validates a pattern against the RFC's grammar (`parse.ts`) and builds its
 * AST, rejecting anything outside the interoperable subset — `\d`/`\w`/`\s`, character-class
 * subtraction, capture/back-references, lookaround, Unicode blocks, non-greedy quantifiers — as
 * a {@link TsonRegexSyntaxError}, no separate rejection pass needed. The resulting {@link Regex}
 * matches in guaranteed linear time (`nfa.ts` Thompson-compiles the AST, `pike.ts` runs it — no
 * backtracking, so no ReDoS) and decides disjointness against another pattern exactly
 * (`disjoint.ts`'s product-NFA emptiness check, the primitive [TSON-SCHEMA] §5.4's choice
 * disjointness builds on for `regex`-constrained variants).
 *
 * **`\p{...}`/`\P{...}` resolves against `categories.ts`'s checked-in Unicode 16.0 tables**, not
 * a host regex engine: `java.util.regex`-equivalents accept a Perl-derived superset and drift
 * across JS engine versions, and TSON pins RFC 9485 as a strict gate — "an implementation MUST
 * implement the pinned dialect as specified... and MUST document any divergence it cannot
 * avoid" ([TSON-SCHEMA] §9). The one divergence, inherited from the RFC itself: RFC 9485 pins no
 * Unicode version, so a category test here can disagree with another conforming implementation
 * pinned to a different Unicode release, for a code point reassigned between the two versions.
 */
export * from './categories.js';
export * from './errors.js';
export type {
  Alternation,
  AnyChar,
  CategoryEscape,
  CharClass,
  ClassMember,
  ClassRange,
  Group,
  Literal,
  RegexNode,
  Repeat,
  Sequence,
} from './parse.js';
export { parseIRegex, toCodePoints } from './parse.js';

import { isDisjoint } from './disjoint.js';
import { type Instruction, compileNfa } from './nfa.js';
import { type RegexNode, parseIRegex, toCodePoints } from './parse.js';
import { runPike } from './pike.js';

/**
 * A parsed I-Regexp pattern (RFC 9485), ready to match input and to test disjointness against
 * another pattern. Returned by {@link parseRegex}; there is no other way to construct one, so
 * `ast`/`pattern` are always in sync with what actually parsed.
 */
export interface Regex {
  /** The source pattern text this was parsed from. */
  readonly pattern: string;
  /** The parsed syntax tree. */
  readonly ast: RegexNode;
  /**
   * Whether `input` matches this pattern in its entirety (RFC 9485 §3's full-match semantics).
   * Runs a Thompson-NFA/Pike-VM simulation in time linear in the input length — no backtracking,
   * so no catastrophic blow-up on an adversarial pattern. The compiled program is built on the
   * first call and reused by every call after it.
   */
  matches(input: string): boolean;
  /**
   * Whether this pattern and `other` are **disjoint** — no string matches both. Exact (regular
   * languages have decidable intersection emptiness), so this is a definitive yes/no, never
   * "unknown".
   *
   * **Not a [TSON-SCHEMA] §5.4 choice-disjointness derivation** — that rule is discrimination-
   * class distinctness and forbids proving more ("value-set separation such as disjoint numeric
   * bounds or disjoint patterns does not make a choice disjoint"), so two `regex`-constrained
   * choice variants are both string-class and keep their tags however separated their languages
   * are. This answers the narrower question, for a schema author reasoning about their own
   * patterns.
   */
  isDisjointFrom(other: Regex): boolean;
}

/**
 * Parses `pattern` as I-Regexp (RFC 9485 §3), returning a {@link Regex} ready to match and to
 * test disjointness.
 *
 * @throws TsonRegexSyntaxError if `pattern` is not valid I-Regexp; `position` is a code-point
 *   index into `pattern`.
 */
export function parseRegex(pattern: string): Regex {
  const ast = parseIRegex(pattern);

  // Compiled lazily on first `matches` call, then reused — a pattern that is only ever used for
  // `isDisjointFrom` (schema-authoring-time reasoning, never on a hot read path) never pays for
  // a program it doesn't need.
  let program: readonly Instruction[] | undefined;

  return {
    pattern,
    ast,
    matches(input: string): boolean {
      program ??= compileNfa(ast, pattern);
      return runPike(program, toCodePoints(input));
    },
    isDisjointFrom(other: Regex): boolean {
      return isDisjoint(ast, other.ast);
    },
  };
}
