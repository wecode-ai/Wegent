// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export interface QuickLaunchInputOptions {
  enable_deep_thinking?: boolean | null
  enable_clarification?: boolean | null
  force_override?: boolean | null
  selected_skill_names?: string[]
}

export interface QuickLaunchInputPreset {
  id: string
  title: string
  prompt?: string | null
  options?: QuickLaunchInputOptions | null
  source_attachment_ids?: number[]
}

export interface QuickLaunchFunctionConfig {
  id: string
  title: string
  description?: string | null
  icon?: string | null
  team_id: number
  enabled: boolean
  order: number
  input_presets: QuickLaunchInputPreset[]
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
