// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Config } from 'jest'
import nextJest from 'next/jest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const extensionsPath = existsSync(resolve(__dirname, 'wecode/extensions'))
  ? '<rootDir>/wecode/extensions/$1'
  : '<rootDir>/src/extensions/$1'

const createJestConfig = nextJest({
  dir: './',
})

const config: Config = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@extensions/(.*)$': extensionsPath,
    '^@wegent/chat-core$': '<rootDir>/../packages/chat-core/src/index.ts',
    '^@wegent/chat-core/(.*)$': '<rootDir>/../packages/chat-core/src/$1',
    '^@wegent/collaboration$': '<rootDir>/../packages/collaboration/src/index.ts',
    '^@wegent/collaboration/tailwind-preset$':
      '<rootDir>/../packages/collaboration/tailwind-preset.js',
    '^@wegent/collaboration/(.*)$': '<rootDir>/../packages/collaboration/src/$1',
    '^streamdown$': '<rootDir>/src/__mocks__/streamdown.tsx',
    '^@file-viewer/react$': '<rootDir>/src/__mocks__/file-viewer.tsx',
    '^@file-viewer/preset-engineering$': '<rootDir>/src/__mocks__/file-viewer-preset.ts',
    // Mock ESM-only markdown-related packages
    '^react-markdown$': '<rootDir>/src/__mocks__/react-markdown.tsx',
    '^@/lib/remark-gfm-safe$': '<rootDir>/src/__mocks__/remark-gfm-safe.ts',
    '^remark-math$': '<rootDir>/src/__mocks__/remark-stub.ts',
    '^remark-frontmatter$': '<rootDir>/src/__mocks__/remark-stub.ts',
    // Mock jsPDF to avoid ESM import issues
    '^jspdf$': '<rootDir>/src/__mocks__/jspdf-stub.ts',
    '^rehype-katex$': '<rootDir>/src/__mocks__/rehype-stub.ts',
    '^rehype-raw$': '<rootDir>/src/__mocks__/rehype-stub.ts',
    // Mock react-syntax-highlighter and its sub-paths
    '^react-syntax-highlighter$': '<rootDir>/src/__mocks__/react-syntax-highlighter.tsx',
    '^react-syntax-highlighter/dist/esm/styles/prism(/.*)?$':
      '<rootDir>/src/__mocks__/syntax-highlighter-styles.ts',
    // Mock CodeMirror Vim because its transitive core package ships ESM that Jest does not parse.
    '^@replit/codemirror-vim$': '<rootDir>/src/__mocks__/codemirror-vim.ts',
    // Mock react-diff-viewer-continued
    '^react-diff-viewer-continued$': '<rootDir>/src/__mocks__/react-diff-viewer-continued.tsx',
    // Mock OpenTelemetry instrumentation packages
    '^@opentelemetry/instrumentation-fetch$': '<rootDir>/src/__mocks__/opentelemetry-stub.ts',
    '^@opentelemetry/instrumentation-xml-http-request$':
      '<rootDir>/src/__mocks__/opentelemetry-stub.ts',
  },
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.stories.{js,jsx,ts,tsx}',
    '!src/app/**',
  ],
  // Coverage thresholds are enforced incrementally via CI tools (e.g., Codecov)
  // rather than globally to support gradual improvement of legacy code
  testMatch: ['<rootDir>/src/__tests__/**/*.test.{js,jsx,ts,tsx}'],
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
}

// Next adds node_modules exclusions before custom patterns. Replace those
// exclusions after resolution so the real shared Markdown parser runs in Jest,
// including packages installed through pnpm's virtual store.
const markdownPackages =
  '(?:@chenglou[/+]pretext|unified|remark-[^/]+|rehype-[^/]+|mdast-util-[^/]+|micromark[^/]*|unist-util-[^/]+|vfile(?:-message)?|bail|devlop|extend|is-plain-obj|trough|zwitch|decode-named-character-reference|character-entities[^/]*|ccount|escape-string-regexp|longest-streak|markdown-table|property-information|comma-separated-tokens|space-separated-tokens|hast-util-[^/]+|html-void-elements|stringify-entities|trim-lines|web-namespaces)'

const resolveJestConfig = async () => {
  const resolved = await createJestConfig(config)()
  return {
    ...resolved,
    transformIgnorePatterns: resolved.transformIgnorePatterns?.map((pattern: string) =>
      pattern.startsWith('/node_modules/')
        ? pattern.replace(
            '/node_modules/',
            `/node_modules/(?!${markdownPackages}/)(?!\\.pnpm/${markdownPackages}@)`
          )
        : pattern
    ),
  }
}

export default resolveJestConfig
