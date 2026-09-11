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
  provider: string
  resource_id?: string
  title: string
  url?: string
  /** 'accessible' | 'inaccessible' — undefined means not yet determined. */
  status?: string
  /** ISO timestamp of the last successful import. */
  last_success_at?: string
  /** Last reason the source was reported inaccessible. */
  last_error?: string
  sync?: ExternalDocumentSyncInfo
}

export interface ExternalDocumentSyncInfo {
  enabled: boolean
  connection_id?: string
  resource_id?: string
  path?: string
  locale?: string
  observed_version?: string
  content_version?: string
  indexed_version?: string
  last_checked_at?: string
  last_synced_at?: string
  last_error_code?: string
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
  const source = external as Record<string, unknown>
  if (typeof source.provider !== 'string' || typeof source.title !== 'string') return null

  const optionalFields = ['resource_id', 'url', 'status', 'last_success_at', 'last_error'] as const
  if (
    optionalFields.some(field => source[field] !== undefined && typeof source[field] !== 'string')
  ) {
    return null
  }

  return {
    provider: source.provider,
    resource_id: source.resource_id as string | undefined,
    title: source.title,
    url: source.url as string | undefined,
    status: source.status as string | undefined,
    last_success_at: source.last_success_at as string | undefined,
    last_error: source.last_error as string | undefined,
    sync:
      source.sync && typeof source.sync === 'object'
        ? (source.sync as ExternalDocumentSyncInfo)
        : undefined,
  }
}

export function isSyncedWikiDocument(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): boolean {
  const source = getExternalSourceInfo(document)
  return (
    document.source_type === 'external' && source?.provider === 'wiki' && !!source.sync?.enabled
  )
}

/** Live-bound wiki page metadata stored in source_config.wiki. */
export interface WikiDocumentSourceInfo {
  path?: string
  resourceUrl?: string
  pageUpdatedAt?: string
}

/**
 * Read the wiki source metadata of a live-bound external wiki document.
 *
 * Returns null for non-wiki documents and for rows whose metadata payload
 * is absent or malformed. Field types are validated strictly so callers can
 * format without defensive checks.
 */
export function getWikiDocumentSourceInfo(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): WikiDocumentSourceInfo | null {
  if (document.source_type !== 'external_wiki') return null
  const wiki = document.source_config?.wiki
  if (!wiki || typeof wiki !== 'object') return null
  const source = wiki as Record<string, unknown>
  if (
    ['path', 'resource_url', 'page_updated_at'].some(
      field => source[field] !== undefined && typeof source[field] !== 'string'
    )
  ) {
    return null
  }
  return {
    path: source.path as string | undefined,
    resourceUrl: source.resource_url as string | undefined,
    pageUpdatedAt: source.page_updated_at as string | undefined,
  }
}

/** True when the value parses as a valid timestamp. */
function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

/**
 * The update timestamp a document list should display.
 *
 * External wiki rows prefer the wiki page's own update time (also written to
 * the standard updated_at column by the backend after backfill); invalid or
 * missing values fall back to updated_at. Regular documents keep the
 * existing rule: unmodified rows (updated_at === created_at) display '-'
 * via the null return.
 */
export function getDocumentDisplayUpdatedAt(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config' | 'updated_at' | 'created_at'>
): string | null {
  if (document.source_type === 'external_wiki') {
    const pageUpdatedAt = getWikiDocumentSourceInfo(document)?.pageUpdatedAt
    if (pageUpdatedAt && isValidTimestamp(pageUpdatedAt)) {
      return pageUpdatedAt
    }
    return document.updated_at || null
  }
  if (isSyncedWikiDocument(document)) {
    const observed = getExternalSourceInfo(document)?.sync?.observed_version
    if (observed && isValidTimestamp(observed)) return observed
  }
  if (document.updated_at === document.created_at) return null
  return document.updated_at || null
}
