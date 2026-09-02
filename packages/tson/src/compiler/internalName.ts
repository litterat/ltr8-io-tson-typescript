/**
 * §8.2's per-segment sanitiser: turns one author-written token into something safe to splice into
 * a minted internal name — ASCII, admitted by §7.7's `identifier` profile (`XID_Continue` plus
 * `-`), and capped at {@link MAX_PART} characters including a trailing hash.
 *
 * `derivedName.ts`'s two naming families both splice author-written content into a minted name's
 * readable half — `desugar.ts` from a lifted binding record, `templates.ts` from an application's
 * head and value arguments — which makes a derived name a place where a document's own text
 * reaches the schema namespace. Two things follow, and the second is why the first is not enough
 * on its own.
 *
 * - **§8.2's freshness MUST**: an internal name is itself a valid `identifier`. Splicing raw text
 *   breaks that outright — a `text` field holding a path puts `/` in a name, and §7.7 admits only
 *   `XID_Continue` and `-`.
 * - **§8.2's own name-hygiene walk has to be able to judge the result.** Admitting every
 *   `XID_Continue` character would keep the name legal and still let a document's own text shape
 *   it: a Cyrillic character in a value would sit in a namespace name, and an ASCII head spliced
 *   with non-ASCII content is mixed-script by construction — so the hygiene walk would either
 *   refuse ordinary schemas or have to exempt minted names from it entirely, which would leave the
 *   namespace taking on whatever a document happens to contain, unchecked. Restricting to ASCII is
 *   what lets the walk stay on for minted names too: an ASCII name is single-script and inside the
 *   identifier profile, so it satisfies all three of §8.2's hygiene rules at every restriction
 *   level.
 *
 * **What is not ASCII is hashed rather than dropped.** Replacing it would collapse two different
 * values onto one readable half; hashing keeps them visibly distinct and keeps the name
 * inspectable — a reader who has the schema can hash the same text and match it. Nothing is lost
 * that identity depends on either way: that is carried by the structural hash `derivedName.ts`
 * computes over the binding itself, never over this text.
 */
import { isXidContinue } from '../unicode/xid.js';

/**
 * The longest one part of a derived name may be, hash included.
 *
 * Nothing in the series bounds a name: §8.2 asks for freshness, stability and a content-derived
 * spelling, and §7.7's grammar is unbounded. But a part is spliced from author-written content and
 * a caller may walk a whole binding record, nested records and arrays included, so an unbounded
 * rule makes name length a function of document size — a realistic REST path already mints well
 * past a hundred characters. Past a point the readable half has stopped being readable and is only
 * cost — in the schema map, at every reference to the entry, and in §8 output.
 */
export const MAX_PART = 64;

/** `h` plus eight hex digits, the fixed width {@link hash} renders. */
const HASH_WIDTH = 9;

/** What is left for readable text once a part carries a hash and the `_` joining the two. */
const READABLE_BUDGET = MAX_PART - HASH_WIDTH - 1;

const HYPHEN = 0x2d;

/**
 * `text` as one part of a derived name — its head, or one of its segments. Three cases, tested in
 * order:
 *
 * 1. ASCII, admitted by §7.7, and within {@link MAX_PART} — spliced verbatim (`order_line`,
 *    `some-name`). The ordinary case: a type name, a verb, a bound, an enum member.
 * 2. ASCII, but not admitted or too long — the admitted characters, truncated to the budget, then
 *    a hash of the whole (`"/x"` reads `x_h00000f2f`, `"1.0"` reads `1_0_h0002f0a5`): the readable
 *    part still says what it came from, and the hash keeps two texts that sanitise alike — or that
 *    share a truncated prefix — apart.
 * 3. Anything else (any non-ASCII character present) — the hash alone, so no non-ASCII character
 *    ever reaches a minted name. Unrecognisable by design: the price of the hygiene walk being
 *    able to run on a minted name at all.
 *
 * `XID_Continue` rather than `XID_Start` for the admitted set: a head is a constructor or template
 * name and so already starts legally, and everything spliced after it sits at a continue position.
 */
export function part(text: string): string {
  if (isAdmittedAscii(text) && text.length <= MAX_PART) {
    return text;
  }
  return isAscii(text) ? joined(truncated(admittedOf(text)), hash(text)) : hash(text);
}

/** Every character ASCII and admitted by §7.7 — the case that needs no rewriting at all. */
function isAdmittedAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f || !(isXidContinue(code) || code === HYPHEN)) {
      return false;
    }
  }
  return true;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * The admitted characters of `text`, each run of the rest collapsed to one `_` and the edges
 * trimmed — parts are already joined by `_`, so a replacement here would only double a separator
 * that is already present.
 */
function admittedOf(text: string): string {
  let out = '';
  let replacing = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isXidContinue(code) || code === HYPHEN) {
      out += text.charAt(i);
      replacing = false;
    } else if (!replacing) {
      out += '_';
      replacing = true;
    }
  }
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === '_') start += 1;
  while (end > start && out[end - 1] === '_') end -= 1;
  return out.slice(start, end);
}

/**
 * The readable text cut to {@link READABLE_BUDGET}. Safe by UTF-16 units rather than code points
 * because only the ASCII branch reaches here — what is not ASCII never contributes readable text
 * at all.
 */
function truncated(admitted: string): string {
  return admitted.length <= READABLE_BUDGET ? admitted : admitted.slice(0, READABLE_BUDGET);
}

function joined(admitted: string, hashed: string): string {
  return admitted === '' ? hashed : `${admitted}_${hashed}`;
}

function hash(text: string): string {
  return `h${fnv1a32(text).toString(16).padStart(8, '0')}`;
}

/**
 * A 32-bit FNV-1a hash of `text`, rendered as an unsigned 32-bit integer. Deterministic by
 * construction — `String.charCodeAt`, `Math.imul` and `>>> 0` are all specified exactly by
 * ECMA-262, so this is stable across hosts and across runs on the same input.
 *
 * The exact algorithm is this port's own business, never a conformance point: [TSON-SCHEMA] §8.2
 * states a minted name's hash spelling is non-normative implementation business (the spec's own
 * bundled fixtures spell it as the literal placeholder `xxhash` for exactly this reason), so this
 * needs to be deterministic on one host, nothing more. Shared by {@link part}'s own per-segment
 * hash and `derivedName.ts`'s structural hash over a whole rendering, so the two independent
 * things this module and `derivedName.ts` each hash go through one implementation rather than two
 * that might quietly disagree about what "the hash" means.
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
