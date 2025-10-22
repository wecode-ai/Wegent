// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Model Types
export interface Model {
  name: string
}

export interface ModelNamesResponse {
  data: Model[]
}

// Model Services
export const modelApis = {
  async getModelNames(agentName: string): Promise<ModelNamesResponse> {
    return apiClient.get(`/models/names?agent_name=${encodeURIComponent(agentName)}`)
  }
}