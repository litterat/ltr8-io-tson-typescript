/**
 * An RFC 9485 I-Regexp engine.
 *
 * Published as `@ltr8/tson/regex`. This subtree is a true leaf — it names no TSON type and imports
 * nothing outside itself, which an `import-x/no-restricted-paths` zone enforces. That isolation is
 * deliberate: I-Regexp is an external standard, and the engine could reasonably become its own
 * package.
 *
 * The engine itself is not implemented yet. It is a Thompson NFA driven by a Pike VM — linear time,
 * no backtracking, so it is ReDoS-safe by construction — plus the product-NFA emptiness check that
 * decides whether two patterns share any string, which §5.4's choice disjointness needs.
 */
export {};
