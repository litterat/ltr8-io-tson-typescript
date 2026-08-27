import type { Instruction } from './nfa.js';

/**
 * Runs a Pike-VM simulation of `program` (compiled by `nfa.ts`'s `compileNfa`) against `input` —
 * a set of active threads advanced in lockstep over the input, so this is linear in
 * `input.length × program.length` with **no backtracking**, and hence no catastrophic-blow-up
 * (ReDoS) on an adversarial pattern: `(a+)+b` runs in linear time here.
 *
 * Matching is **full-match** (RFC 9485 §3's XSD Boolean semantics): the whole of `input` must be
 * consumed reaching an accepting `match` instruction, never "does some prefix or substring
 * match". `input` is code points, not UTF-16 units — `parse.ts`'s `toCodePoints` is the shared
 * conversion, so a supplementary-plane character is one step of the simulation, never two.
 */
export function runPike(program: readonly Instruction[], input: readonly number[]): boolean {
  const n = program.length;
  const seen = new Int32Array(n);
  let gen = 1;
  let current = addThreads(program, [0], seen, gen);

  for (const ch of input) {
    if (current.length === 0) return false; // no live threads and input remains -- cannot full-match
    gen += 1;
    const nextStarts: number[] = [];
    for (const pc of current) {
      const inst = program[pc];
      if (inst?.op === 'consume' && inst.test(ch)) {
        nextStarts.push(pc + 1);
      }
    }
    current = addThreads(program, nextStarts, seen, gen);
  }

  return current.some((pc) => program[pc]?.op === 'match');
}

/**
 * The epsilon-closure of `starts`, deduped by `seen`/`gen` so each instruction is visited at
 * most once per step — this is what keeps a step linear in `program.length` regardless of how
 * many epsilon transitions a SPLIT/JUMP chain contains. Returns the CONSUME/MATCH instructions
 * reached (the two kinds that actually stop a thread rather than continuing through it).
 */
function addThreads(
  program: readonly Instruction[],
  starts: readonly number[],
  seen: Int32Array,
  gen: number,
): number[] {
  const list: number[] = [];
  const stack = [...starts];
  for (let pc = stack.pop(); pc !== undefined; pc = stack.pop()) {
    if (seen[pc] === gen) continue;
    seen[pc] = gen;
    const inst = program[pc];
    if (inst === undefined) continue; // unreachable for a program this module compiled
    switch (inst.op) {
      case 'jump':
        stack.push(inst.x);
        break;
      case 'split':
        stack.push(inst.x, inst.y);
        break;
      default:
        list.push(pc); // consume or match -- a stopping instruction
    }
  }
  return list;
}
