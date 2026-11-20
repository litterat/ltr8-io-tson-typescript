/**
 * The scope a foreign value is read in ([TSON-SCHEMA] §7.9): the foreign schema whose namespace its names resolve in,
 * the extern it was read through, and the schema declaring that extern, which is the enclosing scope's. A fact both
 * encodings' boundary readers state the same way, so a diagnostic raised inside a foreign value names its scopes in
 * one form whichever encoding read it ([TSON-JSON] §8.6).
 *
 * @module
 */

/** One boundary crossed: the extern, the schema declaring it, and the foreign schema the value is read in. */
export interface ForeignScope {
  readonly extern: string;
  readonly declaredIn: string;
  readonly schema: string;
}

/**
 * What a diagnostic raised inside foreign values adds to its message: every boundary crossed, `innermost` first, then
 * each enclosing one.
 */
export function foreignScopeSuffix(
  innermost: ForeignScope,
  enclosing: Iterable<ForeignScope>,
): string {
  let out = ` (read in the scope of ${innermost.schema}, through the extern '${innermost.extern}' of ${innermost.declaredIn}`;
  for (const outer of enclosing) out += `, within '${outer.extern}' of ${outer.declaredIn}`;
  return `${out}; [TSON-SCHEMA] §7.9)`;
}
