// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface DefaultKnowledgeBaseContextRef {
  type: 'knowledge_base'
  id: number
  name: string
  document_count?: number
}

export interface DefaultExternalDocumentContextRef {
  type: 'external_document'
  provider: string
  source: string
  id: string
  name: string
  metadata?: Record<string, unknown>
}

export type DefaultContextRef = DefaultKnowledgeBaseContextRef | DefaultExternalDocumentContextRef

export type DefaultContextMode = 'use_defaults' | 'disable_defaults' | 'override'
