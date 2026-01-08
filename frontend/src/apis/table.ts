// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import client from './client'

/**
 * Table document interface (supports DingTalk, etc.)
 * 多维表格文档接口
 */
export interface TableDocument {
  id: number
  kind_id: number
  name: string
  file_extension: string
  file_size: number
  status: string
  user_id: number
  is_active: boolean
  source_type: 'table'
  source_config?: {
    url?: string
  }
  created_at: string
  updated_at: string
}

/**
 * Table documents list response
 */
export interface TableDocumentsResponse {
  total: number
  items: TableDocument[]
}

/**
 * Table API
 */
export const tableApi = {
  /**
   * List all table documents accessible to the user
   */
  list: async (): Promise<TableDocumentsResponse> => {
    const response = await client.get<TableDocumentsResponse>('/tables')
    return response
  },

  /**
   * Get a table document by ID
   */
  get: async (documentId: number): Promise<TableDocument> => {
    const response = await client.get<TableDocument>(`/tables/${documentId}`)
    return response
  },
}
