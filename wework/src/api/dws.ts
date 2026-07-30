// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface DwsAuthStatus {
  authenticated: boolean
  corp_id?: string
  corp_name?: string
  token_valid?: boolean
  expires_at?: string
}

type LocalRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface DwsApi {
  authStatus(): Promise<DwsAuthStatus>
  login(): Promise<DwsAuthStatus>
  logout(): Promise<void>
}

export function createDwsApi(request: LocalRequest): DwsApi {
  return {
    authStatus: () => request('dws.auth_status'),
    login: () => request('dws.auth_login'),
    async logout() {
      await request('dws.auth_logout')
    },
  }
}
