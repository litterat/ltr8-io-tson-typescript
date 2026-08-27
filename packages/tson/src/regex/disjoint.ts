import {
  type CodePointSet,
  EMPTY_CODE_POINT_SET,
  MAX_CODE_POINT,
  codePointRange,
  codePointSetContains,
  codePointSetOfCategory,
  complementCodePointSet,
  singleCodePoint,
  unionCodePointSets,
} from './codePointSet.js';
import type { CategoryEscape, CharClass, ClassMember, RegexNode, Repeat } from './parse.js';

/**
 * Decides whether two I-Regexp patterns are **disjoint** — no string matches both — by
 * exploring the product of their symbolic NFAs and asking whether any pair of accepting states
 * is jointly reachable. Regular-language intersection emptiness is decidable, so this is
 * **exact**: it returns a definitive yes/no, never a conservative "unknown".
 *
 * This is a general-purpose primitive over two regular languages, not [TSON-SCHEMA] §5.4's
 * choice-disjointness derivation — that rule is discrimination-class distinctness and forbids
 * proving more ("value-set separation such as disjoint numeric bounds or disjoint patterns does
 * not make a choice disjoint"). Two `regex`-constrained choice variants stay string-class and
 * therefore never disjoint by that rule, however separated their languages actually are; this
 * function answers the narrower question, for a schema author reasoning about their own
 * patterns, or for anything else that genuinely needs exact regular-language intersection
 * emptiness.
 *
 * The alphabet is Unicode-sized, so the product is explored symbolically: at each product
 * configuration (a set of active states in each NFA, epsilon-closed), the outgoing transition
 * label sets are partitioned into elementary intervals over which every transition's firing is
 * constant; one representative code point per elementary interval advances both sides. A
 * configuration is revisited at most once, so the search terminates.
 */
export function isDisjoint(a: RegexNode, b: RegexNode): boolean {
  const na = buildSymbolicNfa(a);
  const nb = buildSymbolicNfa(b);

  const start: Config = {
    a: closureOfState(na, na.start),
    b: closureOfState(nb, nb.start),
  };
  // A plain array doubling as a FIFO queue: pushing onto `queue` while this `for...of` is still
  // running is well-defined for arrays (the iterator re-reads `length` each step), so a
  // configuration discovered mid-search is visited without a second pass.
  const queue: Config[] = [start];
  const visited = new Set<string>();

  for (const config of queue) {
    const key = configKey(config);
    if (visited.has(key)) continue;
    visited.add(key);

    if (config.a.has(na.accept) && config.b.has(nb.accept)) {
      return false; // a common string reaches acceptance in both -- not disjoint
    }

    for (const representative of representatives(na, config.a, nb, config.b)) {
      const nextA = step(na, config.a, representative);
      if (nextA.size === 0) continue; // a cannot consume this character
      const nextB = step(nb, config.b, representative);
      if (nextB.size === 0) continue;
      queue.push({ a: nextA, b: nextB });
    }
  }
  return true; // no jointly-accepting configuration is reachable
}

/** A product configuration: the epsilon-closed active-state sets of each NFA. */
interface Config {
  readonly a: ReadonlySet<number>;
  readonly b: ReadonlySet<number>;
}

function configKey(config: Config): string {
  return `${sortedKey(config.a)}|${sortedKey(config.b)}`;
}

function sortedKey(states: ReadonlySet<number>): string {
  return [...states].sort((x, y) => x - y).join(',');
}

/** Epsilon-closure of a set of states (a single state closes via `new Set([start])`). */
function closureOfState(nfa: SymbolicNfa, start: number): Set<number> {
  return closureOfStates(nfa, new Set([start]));
}

function closureOfStates(nfa: SymbolicNfa, states: ReadonlySet<number>): Set<number> {
  const closed = new Set<number>();
  const stack = [...states];
  for (let state = stack.pop(); state !== undefined; state = stack.pop()) {
    if (closed.has(state)) continue;
    closed.add(state);
    for (const target of nfa.epsilon[state] ?? []) stack.push(target);
  }
  return closed;
}

/** The states reachable from `states` by consuming `codePoint`, epsilon-closed. */
function step(nfa: SymbolicNfa, states: ReadonlySet<number>, codePoint: number): Set<number> {
  const targets = new Set<number>();
  for (const s of states) {
    for (const edge of nfa.labelled[s] ?? []) {
      if (codePointSetContains(edge.set, codePoint)) targets.add(edge.to);
    }
  }
  return closureOfStates(nfa, targets);
}

/**
 * One representative code point per elementary interval of all outgoing transition labels from
 * both configurations — the minterms over which each transition fires constantly. Stepping
 * every representative covers every distinguishable next character finitely.
 */
function representatives(
  na: SymbolicNfa,
  a: ReadonlySet<number>,
  nb: SymbolicNfa,
  b: ReadonlySet<number>,
): readonly number[] {
  const boundaries = new Set<number>();
  collectBoundaries(na, a, boundaries);
  collectBoundaries(nb, b, boundaries);
  return [...boundaries].filter((boundary) => boundary <= MAX_CODE_POINT).sort((x, y) => x - y);
}

function collectBoundaries(
  nfa: SymbolicNfa,
  states: ReadonlySet<number>,
  boundaries: Set<number>,
): void {
  for (const s of states) {
    for (const edge of nfa.labelled[s] ?? []) {
      for (let k = 0; k < edge.set.length; k += 2) {
        const lo = edge.set[k];
        const hi = edge.set[k + 1];
        if (lo === undefined || hi === undefined) continue; // malformed set; nothing to record
        boundaries.add(lo);
        boundaries.add(hi + 1);
      }
    }
  }
}

// ── Symbolic NFA construction ────────────────────────────────────────────
//
// A `RegexNode` AST as a Thompson NFA whose consuming transitions are labelled with concrete
// `CodePointSet`s (not opaque predicates), so the product search above can intersect and
// enumerate them. Distinct from `nfa.ts`'s Pike-VM program: same Thompson construction, different
// transition labels, chosen for this module's different downstream operation.

interface Edge {
  readonly set: CodePointSet;
  readonly to: number;
}

interface SymbolicNfa {
  readonly epsilon: readonly (readonly number[])[];
  readonly labelled: readonly (readonly Edge[])[];
  readonly start: number;
  readonly accept: number;
}

/** A fragment under construction: its own start and accept states, not yet wired to anything else. */
interface Fragment {
  readonly start: number;
  readonly end: number;
}

function buildSymbolicNfa(ast: RegexNode): SymbolicNfa {
  const epsilon: number[][] = [];
  const labelled: Edge[][] = [];

  function newState(): number {
    epsilon.push([]);
    labelled.push([]);
    return epsilon.length - 1;
  }

  function epsilonList(state: number): number[] {
    const list = epsilon[state];
    if (list === undefined) throw new RangeError(`unknown NFA state ${String(state)}`);
    return list;
  }

  function labelledList(state: number): Edge[] {
    const list = labelled[state];
    if (list === undefined) throw new RangeError(`unknown NFA state ${String(state)}`);
    return list;
  }

  function addEpsilon(from: number, to: number): void {
    epsilonList(from).push(to);
  }

  function addEdge(from: number, set: CodePointSet, to: number): void {
    labelledList(from).push({ set, to });
  }

  function node(n: RegexNode): Fragment {
    switch (n.kind) {
      case 'literal':
        return consuming(singleCodePoint(n.codePoint));
      case 'any-char':
        return consuming(anyCharSet());
      case 'category-escape':
        return consuming(categorySet(n));
      case 'char-class':
        return consuming(charClassSet(n));
      case 'group':
        return node(n.body);
      case 'sequence':
        return chain(n.pieces.map(node));
      case 'alternation':
        return alternation(n.alternatives);
      case 'repeat':
        return repeatFragment(n);
    }
  }

  function consuming(set: CodePointSet): Fragment {
    const s = newState();
    const e = newState();
    addEdge(s, set, e);
    return { start: s, end: e };
  }

  function alternation(alternatives: readonly RegexNode[]): Fragment {
    const s = newState();
    const e = newState();
    for (const alt of alternatives) {
      const fragment = node(alt);
      addEpsilon(s, fragment.start);
      addEpsilon(fragment.end, e);
    }
    return { start: s, end: e };
  }

  function repeatFragment(rep: Repeat): Fragment {
    const fragments: Fragment[] = [];
    for (let i = 0; i < rep.min; i++) fragments.push(node(rep.atom));
    if (rep.max === undefined) {
      fragments.push(star(rep.atom));
    } else {
      for (let i = 0; i < rep.max - rep.min; i++) fragments.push(optional(rep.atom));
    }
    return chain(fragments);
  }

  /** `atom*` */
  function star(atom: RegexNode): Fragment {
    const s = newState();
    const e = newState();
    const fragment = node(atom);
    addEpsilon(s, fragment.start);
    addEpsilon(s, e);
    addEpsilon(fragment.end, fragment.start);
    addEpsilon(fragment.end, e);
    return { start: s, end: e };
  }

  /** `atom?` */
  function optional(atom: RegexNode): Fragment {
    const s = newState();
    const e = newState();
    const fragment = node(atom);
    addEpsilon(s, fragment.start);
    addEpsilon(s, e);
    addEpsilon(fragment.end, e);
    return { start: s, end: e };
  }

  /** Concatenates fragments end-to-start; an empty list is a single state matching the empty string. */
  function chain(fragments: readonly Fragment[]): Fragment {
    let first: Fragment | undefined;
    let previous: Fragment | undefined;
    for (const fragment of fragments) {
      if (previous !== undefined) addEpsilon(previous.end, fragment.start);
      first ??= fragment;
      previous = fragment;
    }
    if (first === undefined || previous === undefined) {
      const s = newState();
      return { start: s, end: s };
    }
    return { start: first.start, end: previous.end };
  }

  const fragment = node(ast);
  return { epsilon, labelled, start: fragment.start, accept: fragment.end };
}

// ── Transition label sets ──────────────────────────────────────────────────

function anyCharSet(): CodePointSet {
  // any code point except line feed and carriage return
  return complementCodePointSet(unionCodePointSets(singleCodePoint(0x0a), singleCodePoint(0x0d)));
}

function categorySet(cat: CategoryEscape): CodePointSet {
  const set = codePointSetOfCategory(cat.category);
  return cat.complement ? complementCodePointSet(set) : set;
}

function charClassSet(cc: CharClass): CodePointSet {
  let set: CodePointSet = EMPTY_CODE_POINT_SET;
  for (const member of cc.members) set = unionCodePointSets(set, memberSet(member));
  return cc.negated ? complementCodePointSet(set) : set;
}

function memberSet(member: ClassMember): CodePointSet {
  switch (member.kind) {
    case 'literal':
      return singleCodePoint(member.codePoint);
    case 'class-range':
      return codePointRange(member.low, member.high);
    case 'category-escape':
      return categorySet(member);
  }
}
