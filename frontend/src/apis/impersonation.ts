// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client';
import {
  ImpersonationAuditLogListResponse,
  ImpersonationConfirmInfo,
  ImpersonationExitResponse,
  ImpersonationRequest,
  ImpersonationRequestCreate,
  ImpersonationRequestListResponse,
  ImpersonationStartResponse,
} from '@/types/impersonation';

// Admin Impersonation API Services
export const impersonationApis = {
  // ==================== Admin Endpoints ====================

  /**
   * Create a new impersonation request
   */
  async createRequest(data: ImpersonationRequestCreate): Promise<ImpersonationRequest> {
    return apiClient.post('/admin/impersonate/request', data);
  },

  /**
   * List impersonation requests for the current admin
   */
  async listRequests(
    page: number = 1,
    limit: number = 20,
    statusFilter?: string
  ): Promise<ImpersonationRequestListResponse> {
    const params = new URLSearchParams();
    params.append('page', String(page));
    params.append('limit', String(limit));
    if (statusFilter) {
      params.append('status_filter', statusFilter);
    }
    return apiClient.get(`/admin/impersonate/requests?${params.toString()}`);
  },

  /**
   * Get a specific impersonation request
   */
  async getRequest(requestId: number): Promise<ImpersonationRequest> {
    return apiClient.get(`/admin/impersonate/requests/${requestId}`);
  },

  /**
   * Cancel a pending impersonation request
   */
  async cancelRequest(requestId: number): Promise<ImpersonationRequest> {
    return apiClient.post(`/admin/impersonate/requests/${requestId}/cancel`);
  },

  /**
   * Start an impersonation session
   */
  async startSession(requestId: number): Promise<ImpersonationStartResponse> {
    return apiClient.post(`/admin/impersonate/start/${requestId}`);
  },

  /**
   * Exit the current impersonation session
   */
  async exitSession(): Promise<ImpersonationExitResponse> {
    return apiClient.post('/admin/impersonate/exit');
  },

  /**
   * List audit logs for impersonation sessions
   */
  async listAuditLogs(
    page: number = 1,
    limit: number = 50,
    requestId?: number,
    targetUserId?: number
  ): Promise<ImpersonationAuditLogListResponse> {
    const params = new URLSearchParams();
    params.append('page', String(page));
    params.append('limit', String(limit));
    if (requestId) {
      params.append('request_id', String(requestId));
    }
    if (targetUserId) {
      params.append('target_user_id', String(targetUserId));
    }
    return apiClient.get(`/admin/impersonate/audit-logs?${params.toString()}`);
  },

  // ==================== Public Confirmation Endpoints ====================

  /**
   * Get impersonation request info for confirmation page
   */
  async getConfirmInfo(token: string): Promise<ImpersonationConfirmInfo> {
    return apiClient.get(`/impersonate/confirm/${token}`);
  },

  /**
   * Approve an impersonation request
   */
  async approveRequest(token: string): Promise<ImpersonationConfirmInfo> {
    return apiClient.post(`/impersonate/confirm/${token}/approve`);
  },

  /**
   * Reject an impersonation request
   */
  async rejectRequest(token: string): Promise<ImpersonationConfirmInfo> {
    return apiClient.post(`/impersonate/confirm/${token}/reject`);
  },
};
