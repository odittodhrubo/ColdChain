import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'src/shared/constants.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
