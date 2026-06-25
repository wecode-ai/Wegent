// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral registry for external knowledge sources.
 *
 * Conversation selection consumes the browse contract (`listKnowledgeBases`,
 * `listNodes`, `toRef`) so every provider appears in the same picker.
 *
 * Mirrors the opener registry shape in SourceReferences.tsx.
 */

import { useSyncExternalStore } from 'react'
import type { ExternalKnowledgeRef } from '@/types/context'
import type {
  ExternalKbNodeListParams,
  ExternalKbNodeListResponse,
  ExternalKnowledgeBase,
  ExternalKnowledgeBaseListParams,
  ExternalKnowledgeBaseListResponse,
  ExternalKnowledgePreview,
  ExternalKnowledgeScope,
} from '@/types/external-knowledge'

export interface ExternalKnowledgeScopeDescriptor {
  key: ExternalKnowledgeScope
  label?: string
  labelKey?: string
  icon?: 'personal' | 'organization' | 'cloud'
}

export interface ExternalKnowledgeSource {
  providerId: string
  label?: string
  capabilities?: {
    supportsKnowledgeBaseSelection?: boolean
    supportsFolderSelection?: boolean
    supportsDocumentSelection?: boolean
    supportsDocumentTree?: boolean
    supportsScopedRetrieval?: boolean
    supportsPreview?: boolean
  }
  selectionLimits?: {
    maxKnowledgeBases?: number
  }
  scopes?: ExternalKnowledgeScopeDescriptor[]
  listKnowledgeBases?: (
    params?: ExternalKnowledgeBaseListParams
  ) => Promise<ExternalKnowledgeBaseListResponse>
  getKnowledgeBaseCount?: () => Promise<number>
  listNodes?: (
    knowledgeBaseId: string,
    params?: ExternalKbNodeListParams
  ) => Promise<ExternalKbNodeListResponse>
  getPreview?: (params: {
    kb_id: string
    node_id?: string
    document_id?: string
    folder_id?: string | null
  }) => Promise<ExternalKnowledgePreview>
  toRef?: (knowledgeBase: ExternalKnowledgeBase) => ExternalKnowledgeRef
}

const externalKnowledgeSources = new Map<string, ExternalKnowledgeSource>()
const listeners = new Set<() => void>()
let snapshot: ExternalKnowledgeSource[] = []

function emitChange() {
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return snapshot
}

export function registerExternalKnowledgeSource(
  providerId: string,
  source: ExternalKnowledgeSource
): void {
  if (!providerId || !source?.listKnowledgeBases) {
    return
  }
  externalKnowledgeSources.set(providerId, source)
  snapshot = Array.from(externalKnowledgeSources.values())
  emitChange()
}

export function getExternalKnowledgeSource(
  providerId: string
): ExternalKnowledgeSource | undefined {
  return externalKnowledgeSources.get(providerId)
}

export function listExternalKnowledgeSources(): ExternalKnowledgeSource[] {
  return snapshot
}

export function useExternalKnowledgeSources(): ExternalKnowledgeSource[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
