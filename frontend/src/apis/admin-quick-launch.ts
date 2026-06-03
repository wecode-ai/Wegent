// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export interface QuickLaunchFunctionConfig {
  id: string
  title: string
  description?: string | null
  icon?: string | null
  team_id: number
  enabled: boolean
  order: number
  quick_phrases: string[]
}

export interface QuickLaunchFunctionsResponse {
  version: number
  functions: QuickLaunchFunctionConfig[]
}

export interface QuickLaunchFunctionsUpdate {
  functions: QuickLaunchFunctionConfig[]
}

export async function getQuickLaunchFunctionsConfig(): Promise<QuickLaunchFunctionsResponse> {
  return apiClient.get('/admin/system-config/quick-launch-functions')
}

export async function updateQuickLaunchFunctionsConfig(
  data: QuickLaunchFunctionsUpdate
): Promise<QuickLaunchFunctionsResponse> {
  return apiClient.put('/admin/system-config/quick-launch-functions', data)
}
