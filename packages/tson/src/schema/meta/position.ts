/**
 * Where in some original schema source text a resolved value — chiefly a {@link
 * TypeDefinition} — was declared: line, column, and byte offset (Part 2 §8.1's `position`
 * is this package's own addition to `type_definition`, carried for diagnostics; the kernel
 * declares no such field).
 *
 * `schema/meta` depends on nothing but itself and `core/` (see this package's module note),
 * yet a `SourcePosition` should be fillable with zero conversion from a real lexer position
 * produced elsewhere in this library. Rather than import `core/position.ts`'s `Position` and
 * couple this package to *that* module's identity, this interface is declared independently
 * with the same three property names and types `Position` already has (`line`, `column`,
 * `offset`) — TypeScript's structural typing then makes every `Position` a `SourcePosition`
 * for free, with no adapter and no cast. This is the same local-stand-in shape this package
 * uses for {@link Token} (which mirrors `ast.TokenValue`): a shape declared here so a
 * dependent module can satisfy it, never the reverse.
 *
 * The Java original names its third field `byteOffset()`; it is `offset` here instead,
 * specifically so this structural match holds — `core/position.ts`'s `Position` is frozen
 * and uses `offset`, and a renamed field here would silently break the "any `Position` is a
 * `SourcePosition`" property this type exists to provide.
 */
export interface SourcePosition {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, counted in Unicode code points. */
  readonly column: number;
  /** 0-based offset in UTF-8 bytes, after any leading BOM. */
  readonly offset: number;
}
