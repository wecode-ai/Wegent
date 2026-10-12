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
  /** 'accessible' | 'inaccessible' | 'sync_error' — undefined means unknown. */
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
  adapter_type?: string
  resource_kind?: 'page' | 'file'
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
      source.sync &&
      typeof source.sync === 'object' &&
      typeof (source.sync as Record<string, unknown>).enabled === 'boolean'
        ? (source.sync as ExternalDocumentSyncInfo)
        : undefined,
  }
}

/**
 * Read the provider of an imported document without requiring the full source
 * metadata, so placeholders and failed imports are still recognized.
 */
export function getExternalDocumentProvider(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): string | null {
  if (document.source_type !== 'external') return null
  const external = document.source_config?.external
  if (!external || typeof external !== 'object') return null
  const provider = (external as Record<string, unknown>).provider
  return typeof provider === 'string' ? provider : null
}

/**
 * Whether this document is a DingTalk copy, refreshed through the same
 * manual source-sync entry the knowledge base list exposes.
 */
export function isDingtalkCopyDocument(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): boolean {
  return getExternalDocumentProvider(document) === 'dingtalk'
}

/**
 * Whether the imported source itself is currently unreachable.
 *
 * Source health is independent from index health: a copy may keep serving its
 * last successful index after the remote document disappears.
 */
export function isExternalSourceUnavailable(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): boolean {
  const source = getExternalSourceInfo(document)
  return !!source && ['inaccessible', 'sync_error'].includes(source.status || '')
}

/** Whether the document's index is being rebuilt right now. */
export function isDocumentIndexInFlight(
  document: Pick<KnowledgeDocument, 'index_status'>
): boolean {
  return ['queued', 'indexing', 'converting', 'pending_conversion'].includes(document.index_status)
}

export function isSyncedWikiDocument(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): boolean {
  const source = getExternalSourceInfo(document)
  return (
    document.source_type === 'external' && source?.provider === 'wiki' && !!source.sync?.enabled
  )
}

export type SyncedWikiConnectorType = 'wikijs' | 'gitlab_repo' | 'gitlab_wiki'

export function getSyncedWikiConnectorType(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): SyncedWikiConnectorType | null {
  if (!isSyncedWikiDocument(document)) return null
  const adapterType = getExternalSourceInfo(document)?.sync?.adapter_type
  if (adapterType === 'gitlab_repo' || adapterType === 'gitlab_wiki') return adapterType
  return 'wikijs'
}

export function isWikiSourceMissing(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config'>
): boolean {
  const source = getExternalSourceInfo(document)
  return (
    isSyncedWikiDocument(document) && source?.sync?.last_error_code === 'external_source_missing'
  )
}

/** True when the value parses as a valid timestamp. */
function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

/**
 * The update timestamp a document list should display.
 *
 * Synchronized Wiki documents display the latest successful index time.
 * Regular documents keep the existing rule: unmodified rows display '-'.
 */
export function getDocumentDisplayUpdatedAt(
  document: Pick<KnowledgeDocument, 'source_type' | 'source_config' | 'updated_at' | 'created_at'>
): string | null {
  if (isSyncedWikiDocument(document)) {
    const lastSyncedAt = getExternalSourceInfo(document)?.sync?.last_synced_at
    return lastSyncedAt && isValidTimestamp(lastSyncedAt) ? lastSyncedAt : null
  }
  if (document.updated_at === document.created_at) return null
  return document.updated_at || null
}
