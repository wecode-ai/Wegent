// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export type RemoteWorkspaceDisposition = 'inline' | 'attachment'

export interface RemoteWorkspaceStatusResponse {
  connected: boolean
  available: boolean
  root_path: string
  reason: string | null
}

export interface RemoteWorkspaceTreeEntry {
  name: string
  path: string
  is_directory: boolean
  size: number
  modified_at?: string | null
}

export interface RemoteWorkspaceTreeResponse {
  path: string
  entries: RemoteWorkspaceTreeEntry[]
}

export const remoteWorkspaceApis = {
  getStatus(taskId: number) {
    return apiClient.get<RemoteWorkspaceStatusResponse>(`/tasks/${taskId}/remote-workspace/status`)
  },

  getTree(taskId: number, path: string) {
    return apiClient.get<RemoteWorkspaceTreeResponse>(
      `/tasks/${taskId}/remote-workspace/tree?path=${encodeURIComponent(path)}`
    )
  },

  getFileUrl(taskId: number, path: string, disposition: RemoteWorkspaceDisposition) {
    return `/api/tasks/${taskId}/remote-workspace/file?path=${encodeURIComponent(path)}&disposition=${disposition}`
  },
}
