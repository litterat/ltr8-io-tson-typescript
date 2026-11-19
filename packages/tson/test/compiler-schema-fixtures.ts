/**
 * Test-only fixtures for `compiler/compile.ts`'s own integration tests -- not itself a `*.test.ts`
 * file, so vitest never tries to run it. Registers the six real, vendored bundled schemas
 * (`spec/m/*.tn`) on one {@link Tson} the way `stdlib/index.ts` does, and resolves a caller-supplied
 * user schema text against that registry -- the "a user schema importing core.tn" shape Wave 5's own
 * gate is measured against, reused here at unit-test scale.
 */
import { createTson, type Tson } from '../src/config.js';
import { standardLibrary } from '../src/stdlib/index.js';
import { linkSchema, type LinkedSchema } from '../src/link/link.js';
import { bootstrapKernel } from '../src/schema/bootstrap.js';
import { encodeUtf8 } from '../src/io/utf8.js';
import {
  CORE_TN,
  META_TN,
  NET_TN,
  NUMERIC_TN,
  POLICY_TN,
  TEMPORAL_TN,
} from '../src/stdlib/schemas.generated.js';

/** The bundled schemas by name; the kernel is `meta`. */
export type BundledName = 'meta' | 'numeric' | 'temporal' | 'net' | 'core' | 'policy';

const bundled = new Map<BundledName, LinkedSchema>();

function loadBundled(): void {
  if (bundled.size > 0) return;
  const tson = createTson({});
  const kernel = linkSchema(bootstrapKernel(encodeUtf8(META_TN)));
  tson.register(kernel);
  bundled.set('meta', kernel);
  for (const [name, text] of [
    ['numeric', NUMERIC_TN],
    ['temporal', TEMPORAL_TN],
    ['net', NET_TN],
    ['core', CORE_TN],
    ['policy', POLICY_TN],
  ] as const) {
    bundled.set(name, tson.resolveSchema(text));
  }
}

/** The real, vendored `<name>.tn`, resolved and linked once -- the kernel is `meta`. */
export function resolvedBundled(name: BundledName): LinkedSchema {
  loadBundled();
  const found = bundled.get(name);
  if (found === undefined) throw new Error(`no bundled schema '${name}'`);
  return found;
}

const shared: { tson?: Tson } = {};

/**
 * Resolves and links `source` (real TSON schema text, a `!schema` document) against the standard
 * library. `!!import` of a bundled identity finds it already registered, since nothing in this suite
 * reaches the network (`CLAUDE.md`'s zero-runtime-dependency rule extends to test-time fetches too).
 */
export function resolveUserSchema(source: string): LinkedSchema {
  shared.tson ??= standardLibrary();
  return shared.tson.resolveSchema(source);
}
