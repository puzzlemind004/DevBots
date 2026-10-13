import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**']
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
      eqeqeq: ['error', 'always'],
      'no-console': 'warn'
    }
  }
);
