// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getClientRequestCache } from '@wegent/chat-core/request-cache'
import { apiClient } from './client'

const endpoint = '/models/primary-group-icons'

export type ModelPrimaryGroupIcons = Record<string, string>

export function getModelPrimaryGroupIcons(): Promise<ModelPrimaryGroupIcons> {
  return getClientRequestCache(apiClient).get(endpoint, () => apiClient.get(endpoint))
}

export async function setModelPrimaryGroupIcon(group: string, icon: string | null): Promise<void> {
  await apiClient.put(endpoint, { group, icon })
  getClientRequestCache(apiClient).invalidate(endpoint)
}
