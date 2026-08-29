import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      bind: 'src/bind/index.ts',
      tree: 'src/tree/index.ts',
      regex: 'src/regex/index.ts',
      schema: 'src/schema/index.ts',
      write: 'src/write/index.ts',
      identity: 'src/identity/index.ts',
      stdlib: 'src/stdlib/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    // The declaration build runs in its own worker against a synthetic project, which a
    // composite project rejects. tsconfig.build.json is the same config with composite off.
    tsconfig: 'tsconfig.build.json',
    sourcemap: true,
    clean: true,
    target: 'node24',
    // **Load-bearing, not cosmetic.** Without it every entry is a self-contained bundle, so a
    // module reachable from two of them is emitted twice and its module-level state exists
    // twice with it -- and `instanceof` across the copies answers `false`, since each copy
    // declares its own classes. The read stack crosses entries routinely: a caller registering
    // the standard library (`@ltr8/tson/stdlib`) reads through `@ltr8/tson`. Splitting gives
    // the shared modules one chunk and one identity. It applies to the ESM output only, which
    // is esbuild's own limit; a CJS consumer that mixes subpath entries still gets one copy per
    // entry, so nothing may depend on module identity across them.
    splitting: true,
    treeshake: true,
  },
  {
    // `src/source/` is its own TS project (`src/source/tsconfig.json` sets `types: ["node"]`,
    // which the rest of this package deliberately carries none of -- see that file's own top
    // note and `CLAUDE.md`'s "no Node built-ins in code that must run in a browser"). A second
    // tsup config is what lets this one entry build against a different tsconfig than the six
    // above; `clean: false` is load-bearing here; `dist/` was just populated by the config above
    // and this run must add to it, not wipe it first.
    entry: { source: 'src/source/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    tsconfig: 'src/source/tsconfig.build.json',
    sourcemap: true,
    clean: false,
    platform: 'node',
    target: 'node24',
    // tsup rewrites `node:fs` to `fs` by default. This subpath is Node-only by construction, and
    // the prefix is what says so: it is the one specifier form a browser bundler cannot mistake
    // for a resolvable package, so stripping it turns a loud "no such module node:fs" into a
    // silent attempt to resolve an `fs` shim. The export conditions above already keep a browser
    // bundler out of this entry; keeping the prefix is the second lock on the same door.
    removeNodeProtocol: false,
    splitting: false,
    treeshake: true,
  },
]);
