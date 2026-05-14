// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Document utility functions for content handling and type detection
 */

/**
 * List of editable file extensions
 */
export const EDITABLE_EXTENSIONS = [
  'adoc',
  'asciidoc',
  'asm',
  'bat',
  'c',
  'cc',
  'cpp',
  'css',
  'csv',
  'conf',
  'config',
  'dart',
  'env',
  'go',
  'gradle',
  'groovy',
  'h',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'kotlin',
  'less',
  'license',
  'log',
  'lua',
  'markdown',
  'md',
  'mjs',
  'php',
  'pl',
  'properties',
  'ps1',
  'py',
  'rb',
  'readme',
  'rst',
  'rust',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'srt',
  'styl',
  'svg',
  'swift',
  'textile',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'vue',
  'wiki',
  'xml',
  'yaml',
  'yml',
]

/**
 * Check if a document is editable based on source type and file extension
 */
export function isDocumentEditable(
  sourceType: string | undefined,
  fileExtension: string | undefined,
  canEdit: boolean
): boolean {
  if (!canEdit) return false

  return (
    sourceType === 'text' ||
    (sourceType === 'file' && EDITABLE_EXTENSIONS.includes(fileExtension?.toLowerCase() || ''))
  )
}
