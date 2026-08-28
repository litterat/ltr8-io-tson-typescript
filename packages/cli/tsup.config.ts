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
  // Keep `node:fs` written as `node:fs` -- see packages/tson/tsup.config.ts's own note. This is a
  // `#!/usr/bin/env node` binary, so the prefix is simply the correct specifier for what it is.
  removeNodeProtocol: false,
  splitting: false,
  treeshake: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
