// @ts-check
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '.references/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Workflow scripts run in the Workflow runtime against globals this project
      // neither declares nor should (agent, pipeline, parallel, log, args, budget).
      '.claude/workflows/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts', '*.mjs', 'scripts/*.mjs', 'packages/*/*.ts'],
        },
        // This file is linted under the default project, which carries no Node types, so
        // import.meta.dirname types as `any` here even though it is a real Node 20.11+ API.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importPlugin,
    },
    settings: {
      // Load-bearing. `no-restricted-paths` only fires when a specifier RESOLVES, and this
      // project's imports carry `.js` specifiers that point at `.ts` files. Without a
      // TypeScript-aware resolver every zone below silently passes, which is worse than
      // having no zones at all.
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          project: ['packages/*/tsconfig.json', 'test/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Layering. These replace the reference implementation's module system.
      //
      // They are stated OUTBOUND — what a directory may import — because that is the property
      // the design needs: a leaf is a leaf because of what it depends on, not because of who
      // depends on it. `target` names the restricted importers, `from` names what those
      // importers may not reach.
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/tson/src/regex/**',
              from: './packages/tson/src/!(regex)/**',
              message:
                'regex/ is a standalone RFC 9485 engine that names no TSON type; it must import nothing outside itself.',
            },
            {
              target: './packages/tson/src/tree/**',
              from: './packages/tson/src/!(tree|core|annotations|value)/**',
              message:
                'tree/ may import only itself, core/, annotations/ and value/. Its nodes carry wire annotations and host atom values; it must not reach the lexer, the event stream or the schema layer.',
            },
            {
              target: './packages/tson/src/schema/meta/**',
              from: [
                './packages/tson/src/!(core|annotations|schema)/**',
                './packages/tson/src/schema/!(meta)/**',
              ],
              message:
                'schema/meta/ may import only itself, core/ and annotations/. It names no compiler type, which is what lets the schema model ship to a browser that never compiles a schema.',
            },
            {
              target: './packages/tson/src/ast/**',
              from: './packages/tson/src/!(ast|core|lexer)/**',
              message:
                "ast/ may import only itself, core/ and the lexer's token types. It must not reach the event stream, the readers or the schema layer.",
            },
            {
              target: './packages/tson/src/compiler/**',
              from: './packages/tson/src/bind/**',
              message:
                'compiler/ must not import bind/. bind/encode.ts exposes toCoreValue so the resolver can merge on the wire record without reaching for a writer; keep that direction.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.config.ts', 'scripts/**'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Build scripts run under Node and may use its globals. The library itself may not, which
      // is why these are granted here rather than globally.
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
