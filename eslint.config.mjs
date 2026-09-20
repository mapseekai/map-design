import { plugin as shadcn } from '@shadcn/lint';
import tsParser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.next*/**'],
  },
  {
    files: ['apps/*/{src,app}/**/*.{js,jsx,ts,tsx}', 'packages/*/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { shadcn },
    settings: {
      shadcn: { ui: ['@mapseekai/components', '@/components/ui', '@/src/components/ui'] },
    },
    rules: {
      'shadcn/no-restyle': ['error', { allow: ['layout'] }],
    },
  },
  {
    // Design-system primitives own their styles; lint their consumers instead.
    files: ['packages/components/src/ui/**'],
    rules: { 'shadcn/no-restyle': 'off' },
  },
]);
