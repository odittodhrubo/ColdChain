import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'src/shared/constants.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Express error handlers must declare all four parameters; _-prefixed ones are intentionally unused.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
