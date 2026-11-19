import { effectBoundaryRule } from './scripts/check-effect-boundary.mjs'
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'coverage',
    'dist',
    'storybook-static',
    '**/target',
    'dsh/app-wework/web',
    'dummy-non-existing-folder',
    'electron/dummy-non-existing-folder',
    'electron/release',
    'electron/release-installer',
    'electron/resources',
    'electron/src/vendor',
    '**/public/vendor',
    'test-results',
  ]),
  {
    files: ['e2e/desktop/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { architecture: { rules: { 'no-product-use-effect': effectBoundaryRule } } },
    rules: { 'architecture/no-product-use-effect': 'error' },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
