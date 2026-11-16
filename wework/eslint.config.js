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
