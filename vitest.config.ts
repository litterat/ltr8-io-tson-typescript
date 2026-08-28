import { defineConfig } from 'vitest/config';

/**
 * Run every test against `src/`, never against `dist/`.
 *
 * Both packages publish `dist/` under their `import`/`require` conditions and their own sources
 * under `@ltr8/source` — the same condition `tsconfig.base.json`'s `customConditions` selects for
 * `tsc`. Without this the CLI's tests would import whatever `dist/` happened to hold from the last
 * build: passing against stale output, or failing for a subpath that is declared in `package.json`
 * but not yet built.
 *
 * Three lists, not one. `node_modules/@ltr8/*` are workspace symlinks, so Vite externalizes them
 * and hands the specifier to Node's own resolver — which consults neither `resolve.conditions` nor
 * the SSR list. `ssr.resolve.externalConditions` is the one that reaches that resolver; the other
 * two cover anything Vite processes itself.
 *
 * Both are per-project: a `projects` entry does not inherit the root config's `resolve` or `test`.
 */
const sourceResolution = {
  resolve: { conditions: ['@ltr8/source'] },
  ssr: { resolve: { conditions: ['@ltr8/source'], externalConditions: ['@ltr8/source'] } },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...sourceResolution,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts'],
        },
      },
      {
        ...sourceResolution,
        test: {
          name: 'conformance',
          environment: 'node',
          include: ['test/conformance/**/*.test.ts'],
        },
      },
    ],
  },
});
