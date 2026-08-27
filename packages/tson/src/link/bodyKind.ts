/**
 * Distinguishes a {@link Data} body from every other {@link Top} member sharing its shape of
 * discriminant.
 *
 * Every other `Top` branch but two carries a `kind` that is a fixed string *literal*
 * (`'record'`, `'integer_type'`, …), which lets an ordinary `switch (body.kind)` narrow on its
 * own. `Data.kind` is deliberately a bare `string` instead (`schema/meta/typedef.ts`'s own note:
 * "the constructor's own name... this model cannot enumerate in advance"), so a literal `case`
 * label can never *exclude* it — a switch over every known literal still leaves `Data` a
 * possibility in each branch as far as the type checker can tell, and TypeScript cannot narrow a
 * `string`-typed discriminant away from a set of literals by exhaustion alone. This module is the
 * explicit exclusion every other file in `link/` needs instead: check {@link isDataBody} (or its
 * negation) *before* switching on `.kind`, so the body handed to each `case` is provably not
 * `Data` — a real type-predicate narrowing, not a structural one, which is why this has to be a
 * function rather than a `KNOWN_BODY_KINDS.has(...)` check inlined at each call site.
 */
import type { Product, Sum } from '../schema/meta/algebra.js';
import type { Atom, Data, Reference } from '../schema/meta/typedef.js';

/** Every `kind` literal a non-`Data`, non-held `Top` member carries. */
const KNOWN_BODY_KINDS: ReadonlySet<string> = new Set([
  'record',
  'array',
  'map',
  'tuple',
  'choice',
  'reference',
  'unit',
  'enum',
  'integer_type',
  'text_type',
  'uri_type',
  'regex_type',
  'decimal_type',
  'float_type',
  'rational_type',
  'uuid_type',
  'binary',
  'date_type',
  'time_type',
  'datetime_type',
  'duration_type',
  'cidr4_type',
  'cidr6_type',
  'email_type',
  'mac_type',
  'ipv4_type',
  'ipv6_type',
  'complex_type',
  'unknown_type',
  'extern',
]);

/** `body`, once a held `TemplateBody` has already been excluded (that member carries no `kind` at all). */
export type NonHeldTop = Atom | Product | Sum | Reference | Data;

/**
 * The complement of {@link Data} within {@link NonHeldTop} — spelled directly as the four
 * constituent unions rather than as `Exclude<NonHeldTop, Data>`. `Data`'s own `references` is
 * optional and its `kind` is `string`, so every other member is structurally *assignable to*
 * `Data` (a wider shape with an optional method and a widened discriminant) — which is exactly
 * backwards from what narrowing needs, and would make a structural `Exclude` collapse to
 * `never`. Naming the four unions directly sidesteps the question rather than depending on how
 * TypeScript's structural assignability happens to answer it.
 */
export type NonDataTop = Atom | Product | Sum | Reference;

/**
 * `true` for a body describing something other than a data value (§4.1's fourth base kind) --
 * `false` for every other non-held `Top` member. Narrows only the positive (`true`) branch —
 * see {@link NonDataTop}'s own note on why the negative branch is not trusted to narrow itself;
 * a caller wanting the negative branch typed casts explicitly to {@link NonDataTop} once this
 * has returned `false`.
 */
export function isDataBody(body: NonHeldTop): body is Data {
  return !KNOWN_BODY_KINDS.has(body.kind);
}
