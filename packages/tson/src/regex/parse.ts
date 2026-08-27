import { isCategoryName } from './categories.js';
import { TsonRegexSyntaxError } from './errors.js';

/**
 * The abstract syntax tree of a parsed I-Regexp pattern (RFC 9485), mirroring the RFC's own
 * grammar productions. Produced by {@link parseIRegex}; nodes are pure, immutable values with no
 * matching behaviour of their own — `nfa.ts`/`pike.ts` compile and run them, `disjoint.ts`
 * decides emptiness over a product of them.
 *
 * I-Regexp has no anchors (`^`/`$` are ordinary literal characters, never assertions), no
 * capture, and no back-references — so there is no anchor, capture-group, or back-reference
 * node.
 */
export type RegexNode =
  Alternation | Sequence | Repeat | Group | AnyChar | Literal | CharClass | CategoryEscape;

/** `a|b|c` — two or more alternative branches; a single branch is never wrapped in one. */
export interface Alternation {
  readonly kind: 'alternation';
  readonly alternatives: readonly RegexNode[];
}

/** A concatenation of pieces (a `branch`); an empty sequence matches the empty string. */
export interface Sequence {
  readonly kind: 'sequence';
  readonly pieces: readonly RegexNode[];
}

/**
 * A quantified atom (a `piece`). `min` is the lower bound; an absent `max` means unbounded.
 * `*` is `(0, ∞)`, `+` is `(1, ∞)`, `?` is `(0, 1)`, `{n}` is `(n, n)`, `{n,}` is `(n, ∞)`,
 * `{n,m}` is `(n, m)`.
 */
export interface Repeat {
  readonly kind: 'repeat';
  readonly atom: RegexNode;
  readonly min: number;
  readonly max?: number;
}

/** A parenthesised sub-expression `( ... )` — grouping only; I-Regexp has no capture. */
export interface Group {
  readonly kind: 'group';
  readonly body: RegexNode;
}

/** `.` — matches any single character except line feed (U+000A) and carriage return (U+000D). */
export interface AnyChar {
  readonly kind: 'any-char';
}

/** A single literal code point — a `NormalChar` or a `SingleCharEsc`. Also a {@link ClassMember}. */
export interface Literal {
  readonly kind: 'literal';
  readonly codePoint: number;
}

/** `[...]` / `[^...]` — a character class, optionally negated, over one or more members. */
export interface CharClass {
  readonly kind: 'char-class';
  readonly negated: boolean;
  readonly members: readonly ClassMember[];
}

/**
 * `\p{Cat}` / `\P{Cat}` — a Unicode general-category class (`complement` for `\P`). `category`
 * is always one of {@link CATEGORY_NAMES} `categories.ts` exports; a name outside that set is
 * rejected at parse time, never carried into this node. Also a {@link ClassMember}.
 */
export interface CategoryEscape {
  readonly kind: 'category-escape';
  readonly category: string;
  readonly complement: boolean;
}

/** `a-z` inside a class — an inclusive code-point range, `low <= high`. Member-only: never a bare atom. */
export interface ClassRange {
  readonly kind: 'class-range';
  readonly low: number;
  readonly high: number;
}

/** A member of a {@link CharClass}: a single {@link Literal}, a {@link ClassRange}, or a {@link CategoryEscape}. */
export type ClassMember = Literal | ClassRange | CategoryEscape;

/**
 * Splits `text` into an array of code points, iterating by Unicode scalar value rather than
 * UTF-16 unit — the string iterator protocol already does this, so a surrogate pair reads as one
 * entry. Shared by the parser (pattern text) and the matcher (input text): I-Regexp is
 * code-point addressed throughout (RFC 9485 §3), so a supplementary-plane character — an emoji,
 * for instance — is always a single atom, never two.
 */
export function toCodePoints(text: string): readonly number[] {
  const points: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    // The string iterator never yields an empty grapheme, so `codePointAt(0)` is always defined;
    // the check is stated rather than asserted away, matching this module's cursor functions.
    if (codePoint === undefined) {
      throw new RangeError('string iteration yielded an empty grapheme');
    }
    points.push(codePoint);
  }
  return points;
}

/**
 * Parses `pattern` as I-Regexp (RFC 9485 §3), returning its {@link RegexNode} AST.
 *
 * A recursive-descent parser over `pattern`'s code points (so a supplementary-plane character is
 * one atom, never a surrogate half). The grammar itself is the subset gate: anything the
 * productions don't admit — `\d`/`\w`/`\s`, character-class subtraction, capture/back-references,
 * lookaround, Unicode blocks, non-greedy quantifiers — is a {@link TsonRegexSyntaxError}, no
 * separate rejection pass needed.
 *
 * @throws TsonRegexSyntaxError if `pattern` is not valid I-Regexp; `position` is a code-point
 *   index into `pattern`.
 */
export function parseIRegex(pattern: string): RegexNode {
  const cp = toCodePoints(pattern);
  let pos = 0;

  // ── Cursor ─────────────────────────────────────────────────────────────

  function atEnd(): boolean {
    return pos >= cp.length;
  }

  /** The code point at the cursor. Only ever called where the grammar has already checked `!atEnd()`. */
  function current(): number {
    const c = cp[pos];
    if (c === undefined) {
      throw error('unexpected end of pattern');
    }
    return c;
  }

  function peek(ch: number): boolean {
    return !atEnd() && cp[pos] === ch;
  }

  function peekAt(index: number): number {
    if (index < 0 || index >= cp.length) return -1;
    const c = cp[index];
    return c ?? -1;
  }

  function advance(): void {
    pos += 1;
  }

  function expect(ch: number): void {
    if (atEnd() || cp[pos] !== ch) {
      throw error(`expected '${display(ch)}'`);
    }
    pos += 1;
  }

  function error(message: string): TsonRegexSyntaxError {
    return new TsonRegexSyntaxError(message, pattern, pos);
  }

  function display(codePoint: number): string {
    return codePoint < 0 ? '<end>' : String.fromCodePoint(codePoint);
  }

  // ── Grammar productions ───────────────────────────────────────────────

  /** `i-regexp = branch *( "|" branch )` */
  function iRegexp(): RegexNode {
    const first = branch();
    const rest: RegexNode[] = [];
    while (peek(0x7c) /* | */) {
      advance();
      rest.push(branch());
    }
    return rest.length === 0 ? first : { kind: 'alternation', alternatives: [first, ...rest] };
  }

  /** `branch = *piece` — stops at `|`, `)`, or end. */
  function branch(): RegexNode {
    if (atEnd() || peek(0x7c) /* | */ || peek(0x29) /* ) */) {
      return { kind: 'sequence', pieces: [] };
    }
    const first = piece();
    const rest: RegexNode[] = [];
    while (!atEnd() && !peek(0x7c) /* | */ && !peek(0x29) /* ) */) {
      rest.push(piece());
    }
    return rest.length === 0 ? first : { kind: 'sequence', pieces: [first, ...rest] };
  }

  /** `piece = atom [ quantifier ]` */
  function piece(): RegexNode {
    const atomNode = atom();
    const q = quantifier();
    return q === undefined
      ? atomNode
      : q.max === undefined
        ? { kind: 'repeat', atom: atomNode, min: q.min }
        : { kind: 'repeat', atom: atomNode, min: q.min, max: q.max };
  }

  /** `atom = NormalChar / charClass / ( "(" i-regexp ")" )` */
  function atom(): RegexNode {
    const c = current();
    if (c === 0x28 /* ( */) {
      advance();
      const body = iRegexp();
      expect(0x29 /* ) */);
      return { kind: 'group', body };
    }
    if (c === 0x2e /* . */) {
      advance();
      return { kind: 'any-char' };
    }
    if (c === 0x5c /* \ */) {
      return escape();
    }
    if (c === 0x5b /* [ */) {
      return charClassExpr();
    }
    if (isNormalChar(c)) {
      advance();
      return { kind: 'literal', codePoint: c };
    }
    throw error(`unexpected '${display(c)}' where an atom was expected`);
  }

  /** `SingleCharEsc` (a literal) or `charClassEsc` (`\p`/`\P`). */
  function escape(): RegexNode {
    advance(); // the backslash
    if (atEnd()) {
      throw error("trailing '\\' escape");
    }
    const c = current();
    if (c === 0x70 /* p */ || c === 0x50 /* P */) {
      return categoryEscape();
    }
    return { kind: 'literal', codePoint: singleCharEsc() };
  }

  /** `catEsc`/`complEsc` — `\p{Cat}`/`\P{Cat}`; the cursor is on `p`/`P`. */
  function categoryEscape(): CategoryEscape {
    const complement = current() === 0x50; /* P */
    advance(); // 'p' or 'P'
    expect(0x7b /* { */);
    let name = '';
    while (!atEnd() && current() !== 0x7d /* } */) {
      name += String.fromCodePoint(current());
      advance();
    }
    expect(0x7d /* } */);
    if (!isCategoryName(name)) {
      throw error(`'\\p{${name}}' is not a valid I-Regexp Unicode category`);
    }
    return { kind: 'category-escape', category: name, complement };
  }

  /** `charClassExpr = "[" [ "^" ] ( "-" / CCE1 ) *CCE1 [ "-" ] "]"` */
  function charClassExpr(): CharClass {
    advance(); // '['
    const negated = !atEnd() && current() === 0x5e; /* ^ */
    if (negated) advance();
    const members: ClassMember[] = [];
    let first = true;
    for (;;) {
      if (atEnd()) {
        throw error('unterminated character class');
      }
      const c = current();
      if (c === 0x5d /* ] */) {
        if (first) {
          throw error('empty character class');
        }
        break;
      }
      if (c === 0x2d /* - */ && (first || peekAt(pos + 1) === 0x5d) /* ] */) {
        // A '-' is a literal only as the first member or immediately before the closing ']'.
        members.push({ kind: 'literal', codePoint: 0x2d });
        advance();
      } else if (
        c === 0x5c /* \ */ &&
        (peekAt(pos + 1) === 0x70 /* p */ || peekAt(pos + 1) === 0x50) /* P */
      ) {
        advance(); // '\'
        members.push(categoryEscape());
      } else {
        const lo = ccChar();
        if (
          !atEnd() &&
          current() === 0x2d /* - */ &&
          peekAt(pos + 1) !== -1 &&
          peekAt(pos + 1) !== 0x5d /* ] */
        ) {
          advance(); // '-'
          const hi = ccChar();
          if (hi < lo) {
            throw error(`character range '${display(lo)}-${display(hi)}' is out of order`);
          }
          members.push({ kind: 'class-range', low: lo, high: hi });
        } else {
          members.push({ kind: 'literal', codePoint: lo });
        }
      }
      first = false;
    }
    advance(); // ']'
    return { kind: 'char-class', negated, members };
  }

  /** `CCchar` — a bare class character or a `SingleCharEsc`. */
  function ccChar(): number {
    const c = current();
    if (c === 0x5c /* \ */) {
      advance();
      if (atEnd()) {
        throw error("trailing '\\' in character class");
      }
      return singleCharEsc();
    }
    if (isCCchar(c)) {
      advance();
      return c;
    }
    throw error(`'${display(c)}' is not valid inside a character class`);
  }

  /** A `SingleCharEsc` body (the char after `\`); returns the literal code point it denotes. */
  function singleCharEsc(): number {
    const c = current();
    let decoded: number;
    switch (c) {
      case 0x6e /* n */:
        decoded = 0x0a; // \n
        break;
      case 0x72 /* r */:
        decoded = 0x0d; // \r
        break;
      case 0x74 /* t */:
        decoded = 0x09; // \t
        break;
      default:
        if (isSingleCharEscMeta(c)) {
          decoded = c;
        } else {
          throw error(`'\\${display(c)}' is not a valid I-Regexp escape`);
        }
    }
    advance();
    return decoded;
  }

  /** A parsed quantifier's bounds; an absent `max` means unbounded. */
  interface Quant {
    readonly min: number;
    readonly max?: number;
  }

  /** `quantifier` — `* + ?` or a `{n}`/`{n,}`/`{n,m}` range; `undefined` if none. */
  function quantifier(): Quant | undefined {
    if (atEnd()) return undefined;
    switch (current()) {
      case 0x2a /* * */:
        advance();
        return { min: 0 };
      case 0x2b /* + */:
        advance();
        return { min: 1 };
      case 0x3f /* ? */:
        advance();
        return { min: 0, max: 1 };
      case 0x7b /* { */:
        return rangeQuantifier();
      default:
        return undefined;
    }
  }

  /** `range-quantifier = "{" QuantExact [ "," [ QuantExact ] ] "}"` */
  function rangeQuantifier(): Quant {
    advance(); // '{'
    const min = quantExact();
    let max: number | undefined;
    if (!atEnd() && current() === 0x2c /* , */) {
      advance();
      if (!atEnd() && current() === 0x7d /* } */) {
        max = undefined; // {n,}
      } else {
        const m = quantExact();
        if (m < min) {
          throw error(`quantifier {${String(min)},${String(m)}} is out of order`);
        }
        max = m;
      }
    } else {
      max = min; // {n}
    }
    expect(0x7d /* } */);
    return max === undefined ? { min } : { min, max };
  }

  /** `QuantExact = 1*DIGIT` */
  function quantExact(): number {
    if (atEnd() || !isDigit(current())) {
      throw error('expected a decimal quantity');
    }
    let value = 0;
    while (!atEnd() && isDigit(current())) {
      value = value * 10 + (current() - 0x30);
      if (value > 0x7fffffff /* Java int max, the reference's own quantifier ceiling */) {
        throw error('quantifier is too large');
      }
      advance();
    }
    return value;
  }

  // ── Character-class predicates (verbatim from the RFC's code-point ranges) ─

  /** `NormalChar` — every code point except the twelve metacharacters and the surrogate range. */
  function isNormalChar(c: number): boolean {
    return (
      (c >= 0x00 && c <= 0x27) || // up to '
      c === 0x2c || // ,
      c === 0x2d || // -
      (c >= 0x2f && c <= 0x3e) || // / .. > (excludes '.')
      (c >= 0x40 && c <= 0x5a) || // @ A-Z
      (c >= 0x5e && c <= 0x7a) || // ^ _ ` a-z
      (c >= 0x7e && c <= 0xd7ff) || // ~ .. (before surrogates)
      (c >= 0xe000 && c <= 0x10ffff) // (after surrogates)
    );
  }

  /** `CCchar` — a bare character permitted inside a class (excludes `- [ \ ]` and surrogates). */
  function isCCchar(c: number): boolean {
    return (
      (c >= 0x00 && c <= 0x2c) || // up to ',' (excludes '-')
      (c >= 0x2e && c <= 0x5a) || // . .. Z (excludes '[')
      (c >= 0x5e && c <= 0xd7ff) || // ^ .. (excludes '\' and ']')
      (c >= 0xe000 && c <= 0x10ffff)
    );
  }

  /** The metacharacters a `SingleCharEsc` may escape (besides `\n \r \t`). */
  function isSingleCharEscMeta(c: number): boolean {
    return (
      (c >= 0x28 && c <= 0x2b) || // ( ) * +
      c === 0x2d || // -
      c === 0x2e || // .
      c === 0x3f || // ?
      (c >= 0x5b && c <= 0x5e) || // [ \ ] ^
      (c >= 0x7b && c <= 0x7d) // { | }
    );
  }

  function isDigit(c: number): boolean {
    return c >= 0x30 && c <= 0x39;
  }

  // ── Entry point ────────────────────────────────────────────────────────

  const node = iRegexp();
  if (!atEnd()) {
    throw error(`unexpected '${display(current())}'`);
  }
  return node;
}
