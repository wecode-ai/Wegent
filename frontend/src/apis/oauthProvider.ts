// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export type OAuthClientType = 'public' | 'confidential'

export interface OAuthClient {
  id: number
  owner_user_id: number
  owner_user_name?: string | null
  name: string
  namespace: string
  client_id: string
  client_type: OAuthClientType
  redirect_uris: string[]
  description: string
  is_active: boolean
  created_at: string
  updated_at: string
  client_secret?: string | null
}

export interface OAuthClientCreateRequest {
  name: string
  client_type: OAuthClientType
  redirect_uris: string[]
  description?: string
}

export interface OAuthClientUpdateRequest extends Partial<OAuthClientCreateRequest> {
  enabled?: boolean
}
export interface OAuthClientAdminUpdateRequest {
  enabled: boolean
}

export interface OAuthClientListResponse {
  items: OAuthClient[]
  total: number
}

export interface OAuthAuthorizationRequest {
  request_id: string
  client_name: string
  client_id: string
  scope: string
  redirect_uri: string
}

export interface OAuthAuthorizationDecision {
  redirect_url: string
}

export const oauthClientApis = {
  async getOAuthClients(): Promise<OAuthClientListResponse> {
    return apiClient.get('/oauth-clients')
  },

  async createOAuthClient(data: OAuthClientCreateRequest): Promise<OAuthClient> {
    return apiClient.post('/oauth-clients', data)
  },

  async updateOAuthClient(id: number, data: OAuthClientUpdateRequest): Promise<OAuthClient> {
    return apiClient.put(`/oauth-clients/${id}`, data)
  },

  async rotateOAuthClientSecret(id: number): Promise<OAuthClient> {
    return apiClient.post(`/oauth-clients/${id}/rotate-secret`)
  },

  async deleteOAuthClient(id: number): Promise<void> {
    return apiClient.delete(`/oauth-clients/${id}`)
  },
}

export const oauthClientAdminApis = {
  async getOAuthClients(): Promise<OAuthClientListResponse> {
    return apiClient.get('/admin/oauth-clients')
  },

  async updateOAuthClient(id: number, data: OAuthClientAdminUpdateRequest): Promise<OAuthClient> {
    return apiClient.put(`/admin/oauth-clients/${id}`, data)
  },

  async deleteOAuthClient(id: number): Promise<void> {
    return apiClient.delete(`/admin/oauth-clients/${id}`)
  },
}

export const oauthAuthorizationApis = {
  async getRequest(requestId: string): Promise<OAuthAuthorizationRequest> {
    return apiClient.get(`/external/oauth/authorization-requests/${encodeURIComponent(requestId)}`)
  },

  async approve(requestId: string): Promise<OAuthAuthorizationDecision> {
    return apiClient.post(
      `/external/oauth/authorization-requests/${encodeURIComponent(requestId)}/approve`
    )
  },

  async deny(requestId: string): Promise<OAuthAuthorizationDecision> {
    return apiClient.post(
      `/external/oauth/authorization-requests/${encodeURIComponent(requestId)}/deny`
    )
  },
}
