// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { EditorLanguage } from '@/types/editor'

/**
 * Map file extension to editor language for syntax highlighting
 */
export function getEditorLanguage(extension: string | undefined): EditorLanguage {
  if (!extension) return 'markdown'

  const ext = extension.toLowerCase()

  const languageMap: Record<string, EditorLanguage> = {
    // Markdown
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    mdown: 'markdown',
    mkd: 'markdown',
    mkdn: 'markdown',
    // JSON
    json: 'json',
    jsonl: 'json',
    json5: 'json',
    // JavaScript
    js: 'javascript',
    mjs: 'javascript',
    jsx: 'jsx',
    // TypeScript
    ts: 'typescript',
    tsx: 'tsx',
    // Python
    py: 'python',
    // HTML
    html: 'html',
    htm: 'html',
    // CSS
    css: 'css',
    scss: 'css',
    sass: 'css',
    less: 'css',
    // YAML
    yaml: 'yaml',
    yml: 'yaml',
    // SQL
    sql: 'sql',
    // XML
    xml: 'xml',
    svg: 'xml',
    // C/C++
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    // Go
    go: 'go',
    // Java
    java: 'java',
    // Rust
    rs: 'rust',
    rust: 'rust',
  }

  return languageMap[ext] || 'text'
}

/**
 * Check if file extension indicates JSON content
 */
export function isJsonFileExtension(extension: string | undefined): boolean {
  if (!extension) return false
  const jsonExtensions = ['json', 'jsonl', 'json5']
  return jsonExtensions.includes(extension.toLowerCase())
}

/**
 * Check if file extension indicates markdown content
 */
export function isMarkdownFileExtension(extension: string | undefined): boolean {
  if (!extension) return false
  const mdExtensions = ['md', 'markdown', 'mdx', 'mdown', 'mkd', 'mkdn']
  return mdExtensions.includes(extension.toLowerCase())
}

/**
 * Check if content appears to be JSON (even if file extension doesn't indicate it)
 */
export function looksLikeJson(content: string): boolean {
  if (!content) return false
  const trimmed = content.trim()
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
}

/**
 * Try to parse and format JSON content
 * Returns formatted JSON string if valid, null if invalid
 */
export function formatJsonContent(content: string): string | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

/**
 * Check if content contains markdown syntax
 * Returns true if the content appears to be markdown
 */
export function containsMarkdownSyntax(content: string): boolean {
  if (!content) return false

  // Check for common markdown patterns
  // Note: Table separator regex uses string concatenation to avoid Tailwind CSS
  // scanner misinterpreting the pattern as an arbitrary value class
  const markdownPatterns = [
    /^#{1,6}\s+.+$/m, // Headers: # Header
    /\*\*[^*]+\*\*/, // Bold: **text**
    /\*[^*]+\*/, // Italic: *text*
    /__[^_]+__/, // Bold: __text__
    /_[^_]+_/, // Italic: _text_
    /\[.+\]\(.+\)/, // Links: [text](url)
    /!\[.*\]\(.+\)/, // Images: ![alt](url)
    /^[-*+]\s+.+$/m, // Unordered lists: - item or * item
    /^\d+\.\s+.+$/m, // Ordered lists: 1. item
    /^>\s+.+$/m, // Blockquotes: > quote
    /`[^`]+`/, // Inline code: `code`
    /^```[\s\S]*?```$/m, // Code blocks: ```code```
    /^\|.+\|$/m, // Tables: | col1 | col2 |
    // Table separators: |---|---| - split pattern to avoid Tailwind scanner
    new RegExp('^' + '[-' + ':]+\\|' + '[-' + ':|\\s]+$', 'm'),
    /^---+$/m, // Horizontal rules: ---
    /^\*\*\*+$/m, // Horizontal rules: ***
  ]

  return markdownPatterns.some(pattern => pattern.test(content))
}
