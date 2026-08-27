import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: true,
  // The declaration build runs in its own worker against a synthetic project, which a
  // composite project rejects. tsconfig.build.json is the same config with composite off.
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  target: 'node24',
  splitting: false,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
