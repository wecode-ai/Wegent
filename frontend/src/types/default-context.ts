// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface DefaultKnowledgeBaseContextRef {
  type: 'knowledge_base'
  id: number
  name: string
  document_count?: number
}

export interface DefaultDingTalkDocContextRef {
  type: 'dingtalk_doc'
  source: 'docs' | 'wikispace'
  id: string
  dingtalk_node_id: string
  name: string
  doc_url: string
  node_type: 'folder' | 'doc' | 'file'
}

export type DefaultContextRef = DefaultKnowledgeBaseContextRef | DefaultDingTalkDocContextRef

export type DefaultContextMode = 'use_defaults' | 'disable_defaults' | 'override'
