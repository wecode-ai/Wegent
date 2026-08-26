// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Document utility functions for content handling and type detection
 */

import type { KnowledgeDocument } from '@/types/knowledge'

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

/** Source governance metadata stored in source_config.external by the backend. */
export interface ExternalDocumentSourceInfo {
  provider?: string
  resource_id?: string
  title?: string
  url?: string
  /** 'accessible' | 'inaccessible' — undefined means not yet determined. */
  status?: string
  /** ISO timestamp of the last successful import. */
  last_success_at?: string
  /** Last reason the source was reported inaccessible. */
  last_error?: string
}

/**
 * Read the external source metadata of an imported document.
 *
 * Returns null for regular documents and for external documents whose
 * metadata has not landed yet (e.g. a placeholder before the first import).
 */
export function getExternalSourceInfo(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): ExternalDocumentSourceInfo | null {
  if (document.source_type !== 'external') return null
  const external = document.source_config?.external
  if (!external || typeof external !== 'object') return null
  return external as ExternalDocumentSourceInfo
}
