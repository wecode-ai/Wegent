import { defineConfig } from 'eslint/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

export default defineConfig([
  {
    ignores: ['scripts/**/*.cjs', 'scripts/**/*.js', 'next-env.d.ts'],
  },
  {
    extends: compat.extends('next/core-web-vitals', 'next/typescript'),

    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['e2e/**/*.ts', 'e2e/**/*.tsx'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
])
