/**
 * {@link JsonTypeReader}: the one contract every schema-directed JSON reader in this package
 * implements, in tree mode (the only mode this package builds — bind mode is `STATUS.md`'s own known gap,
 * matching `IDIOM-DEBT.md`'s "the parallel JSON stack" entry). Mirrors `reader/contracts.ts`'s own
 * `TypeReader<T>`, restated here rather than imported: the `src/json/**` ESLint zone
 * (`eslint.config.js`) forbids reaching into `reader/` at all.
 *
 * `read` returns `Task<T | undefined>`: `undefined` means this position reported at least one
 * problem and produced no value — the all-or-nothing rule [TSON-JSON] §9.1 states in one place
 * ("diagnostics all reported, no value if any was") and every reader in `json/schema/**` upholds
 * by never returning a partial `T`.
 */
import type { Task } from '../../io/bytes.js';
import type { JsonReadContext } from '../readContext.js';

export interface JsonTypeReader<T = unknown> {
  read(ctx: JsonReadContext): Task<T | undefined>;
}
