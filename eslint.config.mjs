import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'apps/web/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          // Values must be parameters ($1, $2). Only UPPER_CASE module constants (fixed column lists) may be interpolated.
          selector:
            "CallExpression[callee.property.name='query'] > TemplateLiteral > :matches(Identifier[name!=/^[A-Z][A-Z0-9_]*$/], MemberExpression, CallExpression, BinaryExpression, ConditionalExpression)",
          message: 'Use parameterised queries ($1, $2) — never interpolate values into SQL.',
        },
      ],
    },
  },
  {
    // Isolation tests iterate over table names read from the PostgreSQL catalogue, not user input.
    files: ['apps/api/test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
