/**
 * The I-Regexp engine's own error type.
 *
 * This extends `Error` rather than `TsonError`, deliberately, and it is not a gap to be closed
 * later. `regex/` is a leaf: an `import-x/no-restricted-paths` zone forbids it reaching anything
 * outside itself, `core/` included, because the engine names no TSON type and could reasonably
 * ship as its own package. An error class living in `core/` and thrown from here would violate
 * that zone — which is exactly what happened before this file existed. The reference
 * implementation makes the same call: `TsonRegexSyntaxException` lives in `io.ltr8.tson.regex`
 * and extends `RuntimeException`, not any TSON base.
 *
 * The consequence is worth stating rather than discovering: `instanceof TsonError` does **not**
 * catch this. The schema layer that compiles a pattern is what wraps it — a bad pattern in a
 * schema surfaces to a caller as a `TsonSchemaValidationError`, never as this type.
 */
export class TsonRegexSyntaxError extends Error {
  override readonly name = 'TsonRegexSyntaxError';

  /** The pattern that failed to parse. */
  readonly pattern: string;

  /**
   * The **code-point** index into `pattern` where parsing failed.
   *
   * Code points, not UTF-16 units: a pattern containing an astral character would otherwise
   * report a position that does not correspond to any character a reader can count to.
   */
  readonly position: number;

  constructor(message: string, pattern: string, position: number) {
    super(`${message} (at position ${String(position)} in "${pattern}")`);
    // Restores the prototype chain across the ES5 target that `extends Error` otherwise breaks,
    // so `instanceof` holds for this class and for any subclass.
    Object.setPrototypeOf(this, new.target.prototype);
    this.pattern = pattern;
    this.position = position;
  }
}
