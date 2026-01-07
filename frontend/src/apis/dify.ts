// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import { DifyApp, DifyParametersSchema } from '@/types/api'

/**
 * Get list of Dify applications
 */
export async function getDifyApps(): Promise<DifyApp[]> {
  return apiClient.get<DifyApp[]>('/dify/apps')
}

/**
 * Get parameters schema for a specific Dify application
 */
export async function getDifyAppParameters(appId: string): Promise<DifyParametersSchema> {
  return apiClient.get<DifyParametersSchema>(`/dify/apps/${appId}/parameters`)
}
