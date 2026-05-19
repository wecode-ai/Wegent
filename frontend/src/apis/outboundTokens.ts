// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

export interface SigningKey {
  id: number
  name: string
  namespace: string
  kid: string
  algorithm: string
  description: string
  public_key_pem: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface SigningKeyCreateRequest {
  name: string
  description?: string
}

export interface SigningKeyListResponse {
  items: SigningKey[]
  total: number
}

export interface TokenIssuer {
  id: number
  name: string
  namespace: string
  issuer: string
  audience: string
  default_ttl_seconds: number
  max_ttl_seconds: number
  description: string
  signing_key_id: number
  signing_key_name: string
  signing_key_kid: string
  public_key_pem: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface TokenIssuerCreateRequest {
  name: string
  signing_key_id: number
  issuer: string
  audience: string
  default_ttl_seconds: number
  max_ttl_seconds: number
  description?: string
  enabled?: boolean
}

export interface TokenIssuerUpdateRequest {
  name?: string
  signing_key_id?: number
  issuer?: string
  audience?: string
  default_ttl_seconds?: number
  max_ttl_seconds?: number
  description?: string
  enabled?: boolean
}

export interface TokenIssuerListResponse {
  items: TokenIssuer[]
  total: number
}

export const outboundTokenAdminApis = {
  async getSigningKeys(): Promise<SigningKeyListResponse> {
    return apiClient.get('/admin/signing-keys')
  },

  async createSigningKey(data: SigningKeyCreateRequest): Promise<SigningKey> {
    return apiClient.post('/admin/signing-keys', data)
  },

  async toggleSigningKeyStatus(keyId: number): Promise<SigningKey> {
    return apiClient.post(`/admin/signing-keys/${keyId}/toggle-status`)
  },

  async deleteSigningKey(keyId: number): Promise<void> {
    return apiClient.delete(`/admin/signing-keys/${keyId}`)
  },

  async getTokenIssuers(): Promise<TokenIssuerListResponse> {
    return apiClient.get('/admin/token-issuers')
  },

  async createTokenIssuer(data: TokenIssuerCreateRequest): Promise<TokenIssuer> {
    return apiClient.post('/admin/token-issuers', data)
  },

  async updateTokenIssuer(issuerId: number, data: TokenIssuerUpdateRequest): Promise<TokenIssuer> {
    return apiClient.put(`/admin/token-issuers/${issuerId}`, data)
  },

  async toggleTokenIssuerStatus(issuerId: number): Promise<TokenIssuer> {
    return apiClient.post(`/admin/token-issuers/${issuerId}/toggle-status`)
  },

  async deleteTokenIssuer(issuerId: number): Promise<void> {
    return apiClient.delete(`/admin/token-issuers/${issuerId}`)
  },
}
