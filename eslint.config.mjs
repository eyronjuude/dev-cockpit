import next from 'eslint-config-next';

/**
 * eslint-config-next 16 exports a flat-config array, not a factory, so it is
 * spread rather than called.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/db/migrations/**',
      'data/**',
      'next-env.d.ts',
    ],
  },
  ...next,
  {
    // Scoped to match where next/typescript registers the plugin; a global
    // block would reference a plugin that is not defined for .mjs files.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    rules: {
      // This is a local operator tool: server-side logging is the point.
      'no-console': 'off',
    },
  },
];

export default config;
