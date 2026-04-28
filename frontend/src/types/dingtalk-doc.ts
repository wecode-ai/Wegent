// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk synced document node types.
 */

export interface DingtalkDocNode {
  id: number
  dingtalk_node_id: string
  name: string
  doc_url: string
  parent_node_id: string | null
  node_type: 'folder' | 'doc' | 'file'
  workspace_id: string | null
  content_type: string | null
  extension: string | null
  is_active: boolean
  last_synced_at: string
  created_at: string
  updated_at: string
  children?: DingtalkDocNode[]
}

export interface DingtalkDocTreeResponse {
  nodes: DingtalkDocNode[]
  total_count: number
}

export interface DingtalkSyncStatus {
  last_synced_at: string | null
  total_nodes: number
  is_configured: boolean
}

export interface DingtalkSyncResult {
  added: number
  updated: number
  deleted: number
  total: number
  sync_time: string
}
