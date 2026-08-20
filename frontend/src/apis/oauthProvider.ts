// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export type OAuthClientType = 'public' | 'confidential'

export interface OAuthClient {
  id: number
  name: string
  namespace: string
  client_id: string
  client_type: OAuthClientType
  redirect_uris: string[]
  token_issuer_id: number
  token_issuer_name: string
  access_ttl_seconds: number
  refresh_ttl_seconds: number
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
  token_issuer_id: number
  access_ttl_seconds: number
  refresh_ttl_seconds: number
  description?: string
  enabled: boolean
}

export type OAuthClientUpdateRequest = Partial<OAuthClientCreateRequest>

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

export const oauthClientAdminApis = {
  async getOAuthClients(): Promise<OAuthClientListResponse> {
    return apiClient.get('/admin/oauth-clients')
  },

  async createOAuthClient(data: OAuthClientCreateRequest): Promise<OAuthClient> {
    return apiClient.post('/admin/oauth-clients', data)
  },

  async updateOAuthClient(id: number, data: OAuthClientUpdateRequest): Promise<OAuthClient> {
    return apiClient.put(`/admin/oauth-clients/${id}`, data)
  },

  async rotateOAuthClientSecret(id: number): Promise<OAuthClient> {
    return apiClient.post(`/admin/oauth-clients/${id}/rotate-secret`)
  },

  async deleteOAuthClient(id: number): Promise<void> {
    return apiClient.delete(`/admin/oauth-clients/${id}`)
  },
}

export const oauthAuthorizationApis = {
  async getRequest(requestId: string): Promise<OAuthAuthorizationRequest> {
    return apiClient.get(`/oauth/authorization-requests/${encodeURIComponent(requestId)}`)
  },

  async approve(requestId: string): Promise<OAuthAuthorizationDecision> {
    return apiClient.post(`/oauth/authorization-requests/${encodeURIComponent(requestId)}/approve`)
  },

  async deny(requestId: string): Promise<OAuthAuthorizationDecision> {
    return apiClient.post(`/oauth/authorization-requests/${encodeURIComponent(requestId)}/deny`)
  },
}
