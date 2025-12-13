// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';
import {
  Subscription,
  SubscriptionCreate,
  SubscriptionUpdate,
  SubscriptionItem,
  UnreadCountResponse,
  SubscriptionListResponse,
  SubscriptionItemListResponse,
  SubscriptionRunListResponse,
} from '@/types/subscription';

// Subscription CRUD
export const getSubscriptions = async (params?: {
  page?: number;
  limit?: number;
  namespace?: string;
  scope?: 'personal' | 'group' | 'all';
}): Promise<SubscriptionListResponse> => {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.append('page', String(params.page));
  if (params?.limit) queryParams.append('limit', String(params.limit));
  if (params?.namespace) queryParams.append('namespace', params.namespace);
  if (params?.scope) queryParams.append('scope', params.scope);

  const query = queryParams.toString();
  return apiClient.get(`/subscriptions${query ? `?${query}` : ''}`);
};

export const getSubscription = async (id: number): Promise<Subscription> => {
  return apiClient.get(`/subscriptions/${id}`);
};

export const createSubscription = async (data: SubscriptionCreate): Promise<Subscription> => {
  return apiClient.post('/subscriptions', data);
};

export const updateSubscription = async (
  id: number,
  data: SubscriptionUpdate
): Promise<Subscription> => {
  return apiClient.put(`/subscriptions/${id}`, data);
};

export const deleteSubscription = async (id: number): Promise<void> => {
  return apiClient.delete(`/subscriptions/${id}`);
};

export const enableSubscription = async (id: number): Promise<Subscription> => {
  return apiClient.post(`/subscriptions/${id}/enable`);
};

export const disableSubscription = async (id: number): Promise<Subscription> => {
  return apiClient.post(`/subscriptions/${id}/disable`);
};

export const triggerSubscriptionRun = async (
  id: number
): Promise<{ message: string; run_id: number; subscription_id: number; task_id?: number }> => {
  return apiClient.post(`/subscriptions/${id}/run`);
};

// Items
export const getSubscriptionItems = async (
  subscriptionId: number,
  params?: {
    page?: number;
    limit?: number;
    is_read?: boolean;
    should_alert?: boolean;
    search?: string;
  }
): Promise<SubscriptionItemListResponse> => {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.append('page', String(params.page));
  if (params?.limit) queryParams.append('limit', String(params.limit));
  if (params?.is_read !== undefined) queryParams.append('is_read', String(params.is_read));
  if (params?.should_alert !== undefined)
    queryParams.append('should_alert', String(params.should_alert));
  if (params?.search) queryParams.append('search', params.search);

  const query = queryParams.toString();
  return apiClient.get(`/subscriptions/${subscriptionId}/items${query ? `?${query}` : ''}`);
};

export const getSubscriptionItem = async (
  subscriptionId: number,
  itemId: number
): Promise<SubscriptionItem> => {
  return apiClient.get(`/subscriptions/${subscriptionId}/items/${itemId}`);
};

export const markItemRead = async (
  subscriptionId: number,
  itemId: number
): Promise<SubscriptionItem> => {
  return apiClient.post(`/subscriptions/${subscriptionId}/items/${itemId}/read`);
};

export const markAllItemsRead = async (subscriptionId: number): Promise<{ message: string }> => {
  return apiClient.post(`/subscriptions/${subscriptionId}/items/read-all`);
};

// Runs
export const getSubscriptionRuns = async (
  subscriptionId: number,
  params?: {
    page?: number;
    limit?: number;
  }
): Promise<SubscriptionRunListResponse> => {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.append('page', String(params.page));
  if (params?.limit) queryParams.append('limit', String(params.limit));

  const query = queryParams.toString();
  return apiClient.get(`/subscriptions/${subscriptionId}/runs${query ? `?${query}` : ''}`);
};

// Unread count
export const getUnreadCount = async (): Promise<UnreadCountResponse> => {
  return apiClient.get('/subscriptions/unread-count');
};

// Export all subscription APIs
export const subscriptionsApi = {
  getSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  enableSubscription,
  disableSubscription,
  triggerSubscriptionRun,
  getSubscriptionItems,
  getSubscriptionItem,
  markItemRead,
  markAllItemsRead,
  getSubscriptionRuns,
  getUnreadCount,
};
