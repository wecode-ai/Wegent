// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Config } from 'jest'
import nextJest from 'next/jest'

const createJestConfig = nextJest({
  dir: './',
})

const config: Config = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Mock ESM-only markdown-related packages
    '^react-markdown$': '<rootDir>/src/__mocks__/react-markdown.tsx',
    '^@/lib/remark-gfm-safe$': '<rootDir>/src/__mocks__/remark-gfm-safe.ts',
    '^remark-math$': '<rootDir>/src/__mocks__/remark-stub.ts',
    '^remark-gfm$': '<rootDir>/src/__mocks__/remark-stub.ts',
    '^rehype-katex$': '<rootDir>/src/__mocks__/rehype-stub.ts',
    '^rehype-raw$': '<rootDir>/src/__mocks__/rehype-stub.ts',
    '^micromark-util-combine-extensions$': '<rootDir>/src/__mocks__/micromark-stub.ts',
    '^micromark-extension-.*$': '<rootDir>/src/__mocks__/micromark-stub.ts',
    '^mdast-util-.*$': '<rootDir>/src/__mocks__/micromark-stub.ts',
    // Mock react-syntax-highlighter and its sub-paths
    '^react-syntax-highlighter$': '<rootDir>/src/__mocks__/react-syntax-highlighter.tsx',
    '^react-syntax-highlighter/dist/esm/styles/prism(/.*)?$':
      '<rootDir>/src/__mocks__/syntax-highlighter-styles.ts',
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
  // Transform ESM packages that Jest can't handle by default
  // This list includes react-markdown and all its ESM dependencies
  transformIgnorePatterns: [
    '/node_modules/(?!(react-markdown|remark-|rehype-|mdast-util-|micromark|micromark-|unist-|unist-util-|vfile|vfile-message|hast-|hast-util-|bail|ccount|comma-separated-tokens|property-information|space-separated-tokens|trim-lines|html-void-elements|decode-named-character-reference|character-entities|is-plain-obj|longest-streak|markdown-table|escape-string-regexp|stringify-entities|entities|web-namespaces|zwitch|direction)/)',
  ],
}

export default createJestConfig(config)
