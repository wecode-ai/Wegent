import type { DevicePublicKey } from './deviceCredentials'
import { errorMessage, responseJson, type BackendConfig } from '@/services/backendConfig'

export interface WegentUser {
  id: number
  user_name: string
  full_name?: string | null
  email?: string | null
}

export interface AuthorizationSession {
  session_id: string
  poll_token: string
  authorize_url: string
  web_url: string
  expires_at: number
  poll_interval_seconds: number
}

export async function createAuthorizationSession(
  config: BackendConfig,
  publicKey: DevicePublicKey
): Promise<AuthorizationSession> {
  const response = await fetch(`${config.apiBaseUrl}/auth/wework/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_public_key: publicKey }),
  })
  const body = await responseJson<AuthorizationSession>(response)
  if (!response.ok) throw new Error(errorMessage(body, response.status))
  if (!body.session_id || !body.poll_token || !body.authorize_url) {
    throw new Error('Backend 返回了无效授权会话')
  }
  return body
}

export async function fetchCurrentUser(
  config: BackendConfig,
  accessToken: string
): Promise<WegentUser> {
  const response = await fetch(`${config.apiBaseUrl}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const body = await responseJson<WegentUser>(response)
  if (!response.ok) throw new Error(errorMessage(body, response.status))
  return body
}

export function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    const decoded = globalThis.atob(padded)
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown }
    return typeof value.exp === 'number' ? value.exp * 1000 : null
  } catch {
    return null
  }
}
