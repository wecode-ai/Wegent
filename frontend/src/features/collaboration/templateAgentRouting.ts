// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { createWebSharedWorkspaceApi } from './shared-api'

export function listWebTemplateAgentEnvironments(projectId: string) {
  return createWebSharedWorkspaceApi(apiClient).projects.listExecutionEnvironments(projectId)
}
