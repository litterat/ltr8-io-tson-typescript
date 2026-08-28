import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bind: 'src/bind/index.ts',
    tree: 'src/tree/index.ts',
    regex: 'src/regex/index.ts',
    schema: 'src/schema/index.ts',
    write: 'src/write/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // The declaration build runs in its own worker against a synthetic project, which a
  // composite project rejects. tsconfig.build.json is the same config with composite off.
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  target: 'node24',
  splitting: false,
  treeshake: true,
});
