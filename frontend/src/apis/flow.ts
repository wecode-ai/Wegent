// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Flow (关注) API client.
 */
import { apiClient } from './client'
import type {
  Flow,
  FlowCreateRequest,
  FlowExecution,
  FlowExecutionListResponse,
  FlowExecutionStatus,
  FlowListResponse,
  FlowTriggerType,
  FlowUpdateRequest,
} from '@/types/flow'
import type { PaginationParams } from '@/types/api'

export const flowApis = {
  /**
   * List user's flow configurations
   */
  async getFlows(
    params?: PaginationParams,
    enabled?: boolean,
    triggerType?: FlowTriggerType
  ): Promise<FlowListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 20))

    if (enabled !== undefined) {
      queryParams.append('enabled', String(enabled))
    }

    if (triggerType) {
      queryParams.append('trigger_type', triggerType)
    }

    return apiClient.get(`/flows?${queryParams.toString()}`)
  },

  /**
   * Create a new flow
   */
  async createFlow(data: FlowCreateRequest): Promise<Flow> {
    return apiClient.post('/flows', data)
  },

  /**
   * Get a specific flow by ID
   */
  async getFlow(id: number): Promise<Flow> {
    return apiClient.get(`/flows/${id}`)
  },

  /**
   * Update a flow
   */
  async updateFlow(id: number, data: FlowUpdateRequest): Promise<Flow> {
    return apiClient.put(`/flows/${id}`, data)
  },

  /**
   * Delete a flow
   */
  async deleteFlow(id: number): Promise<void> {
    await apiClient.delete(`/flows/${id}`)
  },

  /**
   * Toggle flow enabled/disabled
   */
  async toggleFlow(id: number, enabled: boolean): Promise<Flow> {
    return apiClient.post(`/flows/${id}/toggle?enabled=${enabled}`)
  },

  /**
   * Manually trigger a flow
   */
  async triggerFlow(id: number): Promise<FlowExecution> {
    return apiClient.post(`/flows/${id}/trigger`)
  },

  /**
   * List flow executions (timeline)
   */
  async getExecutions(
    params?: PaginationParams,
    flowId?: number,
    status?: FlowExecutionStatus[],
    startDate?: string,
    endDate?: string
  ): Promise<FlowExecutionListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))

    if (flowId) {
      queryParams.append('flow_id', String(flowId))
    }

    if (status && status.length > 0) {
      status.forEach(s => queryParams.append('status', s))
    }

    if (startDate) {
      queryParams.append('start_date', startDate)
    }

    if (endDate) {
      queryParams.append('end_date', endDate)
    }

    return apiClient.get(`/flows/executions?${queryParams.toString()}`)
  },

  /**
   * Get a specific execution by ID
   */
  async getExecution(id: number): Promise<FlowExecution> {
    return apiClient.get(`/flows/executions/${id}`)
  },

  /**
   * Cancel a running or pending execution
   */
  async cancelExecution(id: number): Promise<FlowExecution> {
    return apiClient.post(`/flows/executions/${id}/cancel`)
  },
}
