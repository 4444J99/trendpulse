import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // The worker leans on `any` for untyped upstream JSON and the AI binding.
      '@typescript-eslint/no-explicit-any': 'off',
      // Intentional best-effort `catch {}` blocks around optional parsing.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Allow deliberately-unused args/catches when prefixed with `_`
      // (e.g. handler signatures like `(_req, env)`).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // TypeScript already resolves identifiers, so the core rule double-reports
      // ambient globals (crypto, fetch, Response, KVNamespace, …).
      'no-undef': 'off',
    },
  },
);
