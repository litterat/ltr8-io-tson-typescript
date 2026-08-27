import { isInCategory } from './categories.js';
import { TsonRegexSyntaxError } from './errors.js';
import type { CategoryEscape, CharClass, ClassMember, RegexNode, Repeat } from './parse.js';

/**
 * A {@link RegexNode} AST compiled to a Thompson NFA expressed as a flat Pike-VM instruction
 * list — `pike.ts` simulates it as a set of active threads advanced in lockstep over the input,
 * so matching is O(input × program) with no backtracking and hence no catastrophic-backtracking
 * (ReDoS) blow-up. This is the payoff of I-Regexp being a true regular language (no
 * back-references or lookaround): a pattern like `(a+)+b` that hangs a backtracking engine runs
 * in linear time here.
 *
 * Distinct from `disjoint.ts`'s symbolic construction: same Thompson construction, different
 * transition labels (an opaque predicate here, a `CodePointSet` interval set there), chosen for
 * a different downstream operation — a Pike-VM thread only ever asks "does this consumed
 * character match?", where the disjointness search needs to intersect and enumerate label sets.
 */
export type Instruction =
  ConsumeInstruction | SplitInstruction | JumpInstruction | MatchInstruction;

/** Advances one input code point if `test` holds; falls through to the next instruction otherwise. */
export interface ConsumeInstruction {
  readonly op: 'consume';
  readonly test: (codePoint: number) => boolean;
}

/** An epsilon transition to either of two instructions. */
export interface SplitInstruction {
  readonly op: 'split';
  readonly x: number;
  readonly y: number;
}

/** An unconditional epsilon transition. */
export interface JumpInstruction {
  readonly op: 'jump';
  readonly x: number;
}

/** Accepts — reachable only once the whole input has been consumed (`pike.ts` is full-match). */
export interface MatchInstruction {
  readonly op: 'match';
}

/** A guard against a pathological pattern (e.g. deeply nested large `{n,m}` repeats) compiling to an unbounded program. */
const MAX_INSTRUCTIONS = 200_000;

// ── Construction-time instruction shapes ────────────────────────────────────
//
// Mutable twins of the public, readonly `Instruction` variants. `x`/`y` targets start at a `-1`
// placeholder and are patched in place once the instruction(s) they point to have themselves
// been emitted (a SPLIT/JUMP may target a forward reference) — plain field assignment, never a
// re-read of a possibly-still-unset value, so nothing here is ever `undefined`. A
// `MutableInstruction` is structurally a mutable `Instruction`, so the finished program needs no
// conversion pass: `prog` is handed back as `readonly Instruction[]` directly.

interface MutableConsume {
  readonly op: 'consume';
  readonly test: (codePoint: number) => boolean;
}
interface MutableSplit {
  readonly op: 'split';
  x: number;
  y: number;
}
interface MutableJump {
  readonly op: 'jump';
  x: number;
}
interface MutableMatch {
  readonly op: 'match';
}
type MutableInstruction = MutableConsume | MutableSplit | MutableJump | MutableMatch;

/**
 * Compiles `ast` (parsed from `pattern`, kept only for the error this throws) into a Pike-VM
 * instruction program via Thompson construction, ending in a {@link MatchInstruction}.
 *
 * @throws TsonRegexSyntaxError if the program would exceed {@link MAX_INSTRUCTIONS} instructions.
 */
export function compileNfa(ast: RegexNode, pattern: string): readonly Instruction[] {
  const prog: MutableInstruction[] = [];

  function emit(inst: MutableInstruction): number {
    if (prog.length >= MAX_INSTRUCTIONS) {
      throw new TsonRegexSyntaxError('pattern expands to too many states to compile', pattern, 0);
    }
    prog.push(inst);
    return prog.length - 1;
  }

  function node(n: RegexNode): void {
    switch (n.kind) {
      case 'literal': {
        const codePoint = n.codePoint;
        emit({ op: 'consume', test: (cp) => cp === codePoint });
        break;
      }
      case 'any-char':
        emit({ op: 'consume', test: (cp) => cp !== 0x0a && cp !== 0x0d });
        break;
      case 'category-escape':
        emit({ op: 'consume', test: categoryPredicate(n) });
        break;
      case 'char-class':
        emit({ op: 'consume', test: charClassPredicate(n) });
        break;
      case 'group':
        node(n.body);
        break;
      case 'sequence':
        for (const piece of n.pieces) node(piece);
        break;
      case 'alternation':
        alternation(n.alternatives);
        break;
      case 'repeat':
        repeat(n);
        break;
    }
  }

  /** `a|b|c`: each non-final branch guarded by a SPLIT, each branch jumping to a shared end. */
  function alternation(alternatives: readonly RegexNode[]): void {
    const jumpsToEnd: MutableJump[] = [];
    const lastIndex = alternatives.length - 1;
    alternatives.forEach((alt, i) => {
      const last = i === lastIndex;
      let split: MutableSplit | undefined;
      if (!last) {
        split = { op: 'split', x: -1, y: -1 };
        emit(split);
        split.x = prog.length; // branch body starts next
      }
      node(alt);
      if (!last && split) {
        const jump: MutableJump = { op: 'jump', x: -1 };
        emit(jump);
        jumpsToEnd.push(jump);
        split.y = prog.length; // the "try the next branch" path
      }
    });
    const end = prog.length;
    for (const jump of jumpsToEnd) jump.x = end;
  }

  function repeat(rep: Repeat): void {
    for (let i = 0; i < rep.min; i++) node(rep.atom);
    if (rep.max === undefined) {
      star(rep.atom);
    } else {
      optionalCopies(rep.atom, rep.max - rep.min);
    }
  }

  /** `atom*`: `L: split BODY, END; BODY: <atom>; jmp L; END:` */
  function star(atom: RegexNode): void {
    const split: MutableSplit = { op: 'split', x: -1, y: -1 };
    const splitIndex = emit(split);
    split.x = prog.length;
    node(atom);
    emit({ op: 'jump', x: splitIndex });
    split.y = prog.length;
  }

  /** `count` optional copies of `atom`, each SPLIT skipping to a shared end (`{n,m}`). */
  function optionalCopies(atom: RegexNode, count: number): void {
    const splits: MutableSplit[] = [];
    for (let i = 0; i < count; i++) {
      const split: MutableSplit = { op: 'split', x: -1, y: -1 };
      emit(split);
      splits.push(split);
      split.x = prog.length;
      node(atom);
    }
    const end = prog.length;
    for (const split of splits) split.y = end;
  }

  node(ast);
  emit({ op: 'match' });

  return prog;
}

// ── Predicates ─────────────────────────────────────────────────────────────

function categoryPredicate(cat: CategoryEscape): (codePoint: number) => boolean {
  const base = (cp: number): boolean => isInCategory(cat.category, cp);
  return cat.complement ? (cp) => !base(cp) : base;
}

function charClassPredicate(cc: CharClass): (codePoint: number) => boolean {
  const predicates = cc.members.map(memberPredicate);
  const union = (cp: number): boolean => predicates.some((test) => test(cp));
  return cc.negated ? (cp) => !union(cp) : union;
}

function memberPredicate(member: ClassMember): (codePoint: number) => boolean {
  switch (member.kind) {
    case 'literal': {
      const codePoint = member.codePoint;
      return (cp) => cp === codePoint;
    }
    case 'class-range': {
      const { low, high } = member;
      return (cp) => cp >= low && cp <= high;
    }
    case 'category-escape':
      return categoryPredicate(member);
  }
}
