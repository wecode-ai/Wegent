// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk document API functions.
 */

import client from './client'
import type {
  DingtalkDocTreeResponse,
  DingtalkSyncStatus,
  DingtalkSyncResult,
} from '@/types/dingtalk-doc'

export const dingtalkDocApi = {
  /**
   * Get all synced DingTalk document nodes as a tree structure.
   */
  getDocs: async (): Promise<DingtalkDocTreeResponse> => {
    return client.get<DingtalkDocTreeResponse>('/dingtalk-docs')
  },

  /**
   * Trigger sync of DingTalk documents from the user's MCP server.
   */
  syncDocs: async (): Promise<DingtalkSyncResult> => {
    return client.post<DingtalkSyncResult>('/dingtalk-docs/sync')
  },

  /**
   * Get the sync status for the current user.
   */
  getSyncStatus: async (): Promise<DingtalkSyncStatus> => {
    return client.get<DingtalkSyncStatus>('/dingtalk-docs/sync-status')
  },

  /**
   * Delete a synced document node from local cache.
   */
  deleteDoc: async (nodeId: number): Promise<void> => {
    await client.delete(`/dingtalk-docs/${nodeId}`)
  },
}
