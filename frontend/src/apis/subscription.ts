// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription (订阅) API client.
 * Refactored from Flow API to align with CRD architecture.
 */
import { apiClient } from './client'
import type {
  Subscription,
  SubscriptionCreateRequest,
  BackgroundExecution,
  BackgroundExecutionListResponse,
  BackgroundExecutionStatus,
  SubscriptionListResponse,
  SubscriptionTriggerType,
  SubscriptionUpdateRequest,
} from '@/types/subscription'
import type { PaginationParams } from '@/types/api'

export const subscriptionApis = {
  /**
   * List user's subscription configurations
   */
  async getSubscriptions(
    params?: PaginationParams,
    enabled?: boolean,
    triggerType?: SubscriptionTriggerType
  ): Promise<SubscriptionListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 20))

    if (enabled !== undefined) {
      queryParams.append('enabled', String(enabled))
    }

    if (triggerType) {
      queryParams.append('trigger_type', triggerType)
    }

    return apiClient.get(`/subscriptions?${queryParams.toString()}`)
  },

  /**
   * Create a new subscription
   */
  async createSubscription(data: SubscriptionCreateRequest): Promise<Subscription> {
    return apiClient.post('/subscriptions', data)
  },

  /**
   * Get a specific subscription by ID
   */
  async getSubscription(id: number): Promise<Subscription> {
    return apiClient.get(`/subscriptions/${id}`)
  },

  /**
   * Update a subscription
   */
  async updateSubscription(id: number, data: SubscriptionUpdateRequest): Promise<Subscription> {
    return apiClient.put(`/subscriptions/${id}`, data)
  },

  /**
   * Delete a subscription
   */
  async deleteSubscription(id: number): Promise<void> {
    await apiClient.delete(`/subscriptions/${id}`)
  },

  /**
   * Toggle subscription enabled/disabled
   */
  async toggleSubscription(id: number, enabled: boolean): Promise<Subscription> {
    return apiClient.post(`/subscriptions/${id}/toggle?enabled=${enabled}`)
  },

  /**
   * Manually trigger a subscription
   */
  async triggerSubscription(id: number): Promise<BackgroundExecution> {
    return apiClient.post(`/subscriptions/${id}/trigger`)
  },

  /**
   * List background executions (timeline)
   */
  async getExecutions(
    params?: PaginationParams,
    subscriptionId?: number,
    status?: BackgroundExecutionStatus[],
    startDate?: string,
    endDate?: string
  ): Promise<BackgroundExecutionListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))

    if (subscriptionId) {
      queryParams.append('subscription_id', String(subscriptionId))
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

    return apiClient.get(`/subscriptions/executions?${queryParams.toString()}`)
  },

  /**
   * Get a specific execution by ID
   */
  async getExecution(id: number): Promise<BackgroundExecution> {
    return apiClient.get(`/subscriptions/executions/${id}`)
  },

  /**
   * Cancel a running or pending execution
   */
  async cancelExecution(id: number): Promise<BackgroundExecution> {
    return apiClient.post(`/subscriptions/executions/${id}/cancel`)
  },

  /**
   * Delete an execution record
   * Only executions in terminal states (COMPLETED, FAILED, CANCELLED) can be deleted
   */
  async deleteExecution(id: number): Promise<void> {
    await apiClient.delete(`/subscriptions/executions/${id}`)
  },
}
