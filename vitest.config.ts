import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'conformance',
          environment: 'node',
          include: ['test/conformance/**/*.test.ts'],
        },
      },
    ],
  },
});
