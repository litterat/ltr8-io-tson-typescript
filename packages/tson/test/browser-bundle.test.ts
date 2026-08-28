/**
 * The browser-bundle smoke test: every subpath a browser is meant to use really does bundle for
 * one, the one that is not really does not, and the result runs with no Node globals in scope.
 *
 * `CLAUDE.md` states two hard constraints this is the only place that actually checks:
 * "Node 24+ and modern browsers. No `DOM` lib in the type configuration, no Node built-ins in code
 * that must run in a browser." Until now both were verified indirectly — by grepping for `node:`
 * imports and by reading `tsconfig`s — which catches a direct import and misses everything else:
 * a transitive one through a module nobody thought to grep, an `exports` map that quietly resolves
 * a browser build to a Node-only entry, a `process.env` read.
 *
 * **Bundled from source, not from `dist/`.** The `@ltr8/source` condition points esbuild at
 * `src/`, so this runs on a clean checkout with nothing built — which matters, because CI runs the
 * tests before the build. It is also the honest target: a Node built-in reaching a browser is a
 * property of the source's import graph, and `dist/` is checked separately by `publint` and
 * `arethetypeswrong`.
 *
 * **`platform: 'browser'` is doing real work here.** esbuild resolves `exports` under
 * `['browser', 'import']` and, on that platform, refuses to bundle a Node built-in rather than
 * shimming it — so `@ltr8/tson/source` failing to resolve is not incidental, it is the security
 * property `source/index.ts` claims: a browser bundle that never imports that subpath never
 * carries a filesystem-reading or network-fetching primitive at all.
 */
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

/** Every subpath a browser build is allowed to reach. `./source` is deliberately absent. */
const BROWSER_SUBPATHS = [
  '@ltr8/tson',
  '@ltr8/tson/bind',
  '@ltr8/tson/tree',
  '@ltr8/tson/regex',
  '@ltr8/tson/schema',
  '@ltr8/tson/write',
  '@ltr8/tson/identity',
  '@ltr8/tson/stdlib',
] as const;

async function bundleForBrowser(
  entry: string,
  globalName = 'tson',
  conditions: readonly string[] = ['@ltr8/source'],
): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import * as m from ${JSON.stringify(entry)};\nglobalThis.${globalName} = m;\n`,
      resolveDir: REPO_ROOT,
      loader: 'js',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2023',
    // `@ltr8/source` points at `src/`, so this needs nothing built. `browser` and `import` come
    // from `platform: 'browser'` itself.
    conditions: [...conditions],
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}

describe('every browser-facing subpath bundles for a browser', () => {
  it.each(BROWSER_SUBPATHS)(
    '%s',
    async (entry) => {
      await expect(bundleForBrowser(entry)).resolves.toBeTypeOf('string');
    },
    30_000,
  );
});

/**
 * Everything esbuild said about a failed build, notes included. Its thrown `message` is only a
 * count -- "Build failed with 1 error" -- and the reason a build failed is exactly what these two
 * assertions are about, so matching on the message alone would pass for any failure at all.
 */
async function bundleFailure(
  entry: string,
  conditions: readonly string[] = ['@ltr8/source'],
): Promise<string> {
  try {
    await bundleForBrowser(entry, 'unused', conditions);
  } catch (error) {
    const errors = (
      error as { errors?: readonly { text: string; notes?: readonly { text: string }[] }[] }
    ).errors;
    if (errors === undefined) return String(error);
    return errors.map((e) => [e.text, ...(e.notes ?? []).map((n) => n.text)].join('\n')).join('\n');
  }
  throw new Error(`expected bundling ${entry} for a browser to fail, and it did not`);
}

describe('the Node-only subpath is unreachable from a browser build', () => {
  // Two independent locks, asserted separately because either alone could be removed by accident
  // and the other would keep the test green while the property it names was gone.

  it('is not exported at all under the conditions a real browser bundler uses', async () => {
    // The lock that matters in practice. `./source`'s `exports` entry offers only `node` (plus the
    // source condition this repository's own tooling passes), so resolution fails at the exports
    // map -- before any file is read, which is why this holds on a clean checkout with no build.
    expect(await bundleFailure('@ltr8/tson/source', [])).toMatch(/not currently exported/u);
  }, 30_000);

  it('would still not bundle even if something did reach its source', async () => {
    // The second lock: with the source condition forced on, resolution succeeds and the build
    // fails anyway, because `platform: 'browser'` refuses a Node built-in rather than shimming it.
    // That is the property `source/index.ts` claims -- a browser bundle that never imports this
    // subpath never carries a filesystem-reading or network-fetching primitive at all.
    expect(await bundleFailure('@ltr8/tson/source')).toMatch(/built into node/u);
  }, 30_000);
});

describe('the bundle carries no Node built-in', () => {
  it.each(BROWSER_SUBPATHS)(
    '%s imports nothing from node:',
    async (entry) => {
      const code = await bundleForBrowser(entry);
      // Both spellings: `node:fs` and the bare `fs` a `removeNodeProtocol`-style rewrite leaves.
      // esbuild would have failed the build for a real one under `platform: 'browser'`; this also
      // catches a string that made it into the output some other way.
      expect(code).not.toMatch(
        /require\(["'](?:node:)?(?:fs|path|os|crypto|http|https|stream|url)["']\)/u,
      );
      expect(code).not.toMatch(/from\s*["']node:/u);
    },
    30_000,
  );
});

describe('the bundle runs with no Node globals in scope', () => {
  /**
   * A context carrying only globals a browser actually has. No `process`, no `Buffer`, no
   * `require`, no `module`, no `__dirname` — so anything reaching for one throws here rather than
   * silently working because the test happened to run under Node.
   */
  function browserLikeContext(): Record<string, unknown> {
    const context: Record<string, unknown> = {
      // Web platform globals, present in every browser and in Node 24 alike.
      TextEncoder,
      TextDecoder,
      crypto,
      console,
      URL,
      Math,
      JSON,
      BigInt,
      Uint8Array,
      Error,
      Promise,
    };
    createContext(context);
    return context;
  }

  it('parses a document with only browser globals available', async () => {
    const code = await bundleForBrowser('@ltr8/tson');
    const context = browserLikeContext();
    runInContext(code, context);
    runInContext(
      `globalThis.result = tson.parse(new TextEncoder().encode('{ a: 1  b: "two" }'));`,
      context,
    );
    expect(context.result).toMatchObject({ document: { root: { coreValue: { kind: 'record' } } } });
  }, 30_000);

  it('reads a tree, which is the compiler-backed path, with the same globals', async () => {
    const code = await bundleForBrowser('@ltr8/tson');
    const context = browserLikeContext();
    runInContext(code, context);
    runInContext(`globalThis.value = tson.readTree(new TextEncoder().encode('[1 2 3]'));`, context);
    expect(context.value).toMatchObject({ kind: 'array' });
  }, 30_000);

  it('registers the standard library and compiles a schema, with the same globals', async () => {
    // The heaviest path there is: bootstrap, resolve, link, compile -- all of it in a context
    // with no `process` and no filesystem. This is what `@ltr8/tson/stdlib` embedding the three
    // documents as strings rather than reading them from disk actually buys.
    const code = await bundleForBrowser('@ltr8/tson/stdlib', 'stdlib');
    const context = browserLikeContext();
    runInContext(code, context);
    runInContext(
      `
      const tson = stdlib.standardLibrary();
      const id = (text) => /^!!id:"([^"]+)"/.exec(text)[1];
      const schema = '!!id:"https://example.com/reading.tn"\\n'
        + '!!meta:"' + id(stdlib.META_TN) + '"\\n'
        + '!!import:"' + id(stdlib.CORE_TN) + '"\\n'
        + '{ reading => { label: text } }\\n';
      const compiled = tson.compile(tson.resolveSchema(schema));
      globalThis.value = tson.readTree(
        new TextEncoder().encode('{ label: "north ridge" }'),
        { schema: compiled, root: 'reading' },
      );
      `,
      context,
    );
    expect(context.value).toMatchObject({ kind: 'record', typeRef: 'reading' });
  }, 30_000);

  it('hashes a document with only the platform crypto global', async () => {
    const code = await bundleForBrowser('@ltr8/tson/identity', 'identity');
    const context = browserLikeContext();
    runInContext(code, context);
    runInContext(
      `globalThis.hex = identity.sha256Hex(new TextEncoder().encode('!!id:"x"\\nbody'));`,
      context,
    );
    await expect(context.hex).resolves.toMatch(/^[0-9a-f]{64}$/u);
  }, 30_000);
});
