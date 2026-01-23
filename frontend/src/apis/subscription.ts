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
  DiscoverSubscriptionsListResponse,
  FollowingSubscriptionsListResponse,
  InviteUserRequest,
  InviteNamespaceRequest,
  SubscriptionFollowersListResponse,
  SubscriptionInvitationsListResponse,
  MarketSubscriptionsListResponse,
  MarketSubscriptionDetail,
  RentSubscriptionRequest,
  RentalSubscriptionResponse,
  RentalSubscriptionsListResponse,
  RentalCountResponse,
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
    endDate?: string,
    includeSilent?: boolean
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

    if (includeSilent !== undefined) {
      queryParams.append('include_silent', String(includeSilent))
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

  // ========== Follow/Visibility APIs ==========

  /**
   * Follow a public subscription
   */
  async followSubscription(subscriptionId: number): Promise<{ message: string }> {
    return apiClient.post(`/subscriptions/${subscriptionId}/follow`)
  },

  /**
   * Unfollow a subscription
   */
  async unfollowSubscription(subscriptionId: number): Promise<{ message: string }> {
    return apiClient.delete(`/subscriptions/${subscriptionId}/follow`)
  },

  /**
   * Get followers of a subscription (owner only)
   */
  async getFollowers(
    subscriptionId: number,
    params?: PaginationParams
  ): Promise<SubscriptionFollowersListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))
    return apiClient.get(`/subscriptions/${subscriptionId}/followers?${queryParams.toString()}`)
  },

  /**
   * Get followers count for a subscription
   */
  async getFollowersCount(subscriptionId: number): Promise<{ count: number }> {
    return apiClient.get(`/subscriptions/${subscriptionId}/followers/count`)
  },

  /**
   * Invite a user to follow a subscription
   */
  async inviteUser(subscriptionId: number, data: InviteUserRequest): Promise<{ message: string }> {
    return apiClient.post(`/subscriptions/${subscriptionId}/invite`, data)
  },

  /**
   * Invite a namespace (group) to follow a subscription
   */
  async inviteNamespace(
    subscriptionId: number,
    data: InviteNamespaceRequest
  ): Promise<{ message: string }> {
    return apiClient.post(`/subscriptions/${subscriptionId}/invite-namespace`, data)
  },

  /**
   * Revoke a user's invitation
   */
  async revokeUserInvitation(subscriptionId: number, userId: number): Promise<{ message: string }> {
    return apiClient.delete(`/subscriptions/${subscriptionId}/invite/${userId}`)
  },

  /**
   * Revoke a namespace's invitation
   */
  async revokeNamespaceInvitation(
    subscriptionId: number,
    namespaceId: number
  ): Promise<{ message: string }> {
    return apiClient.delete(`/subscriptions/${subscriptionId}/invite-namespace/${namespaceId}`)
  },

  /**
   * Get invitations sent for a subscription (owner only)
   */
  async getInvitationsSent(
    subscriptionId: number,
    params?: PaginationParams
  ): Promise<SubscriptionInvitationsListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))
    return apiClient.get(`/subscriptions/${subscriptionId}/invitations?${queryParams.toString()}`)
  },

  /**
   * Get subscriptions the current user follows
   */
  async getFollowingSubscriptions(
    params?: PaginationParams
  ): Promise<FollowingSubscriptionsListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))
    return apiClient.get(`/users/me/following-subscriptions?${queryParams.toString()}`)
  },

  /**
   * Get pending invitations for the current user
   */
  async getPendingInvitations(
    params?: PaginationParams
  ): Promise<SubscriptionInvitationsListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))
    return apiClient.get(`/users/me/subscription-invitations?${queryParams.toString()}`)
  },

  /**
   * Accept a subscription invitation
   */
  async acceptInvitation(invitationId: number): Promise<{ message: string }> {
    return apiClient.post(`/subscription-invitations/${invitationId}/accept`)
  },

  /**
   * Reject a subscription invitation
   */
  async rejectInvitation(invitationId: number): Promise<{ message: string }> {
    return apiClient.post(`/subscription-invitations/${invitationId}/reject`)
  },

  /**
   * Discover public subscriptions
   */
  async discoverSubscriptions(
    params?: PaginationParams & { sortBy?: 'popularity' | 'recent'; search?: string }
  ): Promise<DiscoverSubscriptionsListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 50))
    if (params?.sortBy) {
      queryParams.append('sort_by', params.sortBy)
    }
    if (params?.search) {
      queryParams.append('search', params.search)
    }
    return apiClient.get(`/subscriptions/discover?${queryParams.toString()}`)
  },

  /**
   * Delete an execution record
   * Only executions in terminal states (COMPLETED, FAILED, CANCELLED) can be deleted
   */
  async deleteExecution(id: number): Promise<void> {
    await apiClient.delete(`/subscriptions/executions/${id}`)
  },

  // ========== Market/Rental APIs ==========

  /**
   * Discover market subscriptions
   */
  async discoverMarketSubscriptions(
    params?: PaginationParams & { sortBy?: 'rental_count' | 'recent'; search?: string }
  ): Promise<MarketSubscriptionsListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('skip', String(((params?.page || 1) - 1) * (params?.limit || 20)))
    queryParams.append('limit', String(params?.limit || 20))
    if (params?.sortBy) {
      queryParams.append('sort_by', params.sortBy)
    }
    if (params?.search) {
      queryParams.append('search', params.search)
    }
    return apiClient.get(`/market/subscriptions?${queryParams.toString()}`)
  },

  /**
   * Get market subscription detail
   */
  async getMarketSubscriptionDetail(id: number): Promise<MarketSubscriptionDetail> {
    return apiClient.get(`/market/subscriptions/${id}`)
  },

  /**
   * Rent a market subscription
   */
  async rentSubscription(
    subscriptionId: number,
    data: RentSubscriptionRequest
  ): Promise<RentalSubscriptionResponse> {
    return apiClient.post(`/market/subscriptions/${subscriptionId}/rent`, data)
  },

  /**
   * Get current user's rental subscriptions
   */
  async getMyRentals(params?: PaginationParams): Promise<RentalSubscriptionsListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('skip', String(((params?.page || 1) - 1) * (params?.limit || 20)))
    queryParams.append('limit', String(params?.limit || 20))
    return apiClient.get(`/market/users/me/rentals?${queryParams.toString()}`)
  },

  /**
   * Get rental count for a subscription
   */
  async getRentalCount(subscriptionId: number): Promise<RentalCountResponse> {
    return apiClient.get(`/subscriptions/${subscriptionId}/rental-count`)
  },
}
