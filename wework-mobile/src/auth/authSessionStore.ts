import * as SecureStore from 'expo-secure-store'

import type { WegentUser } from './authClient'
import type { BackendConfig } from '@/services/backendConfig'

const AUTH_SESSION_KEY = 'wegent.mobile.auth-session.v1'
let pendingMutation: Promise<void> = Promise.resolve()

export interface CachedAuthSession {
  backend: BackendConfig
  accessToken: string
  accessTokenExpiresAt: number | null
  user: WegentUser
}

export async function loadAuthSession(): Promise<CachedAuthSession | null> {
  await pendingMutation
  const raw = await SecureStore.getItemAsync(AUTH_SESSION_KEY)
  if (!raw) return null
  try {
    const session = parseAuthSession(JSON.parse(raw))
    if (session) return session
    await clearAuthSession()
    return null
  } catch {
    await clearAuthSession()
    return null
  }
}

export function saveAuthSession(session: CachedAuthSession): Promise<void> {
  return queueMutation(() =>
    SecureStore.setItemAsync(AUTH_SESSION_KEY, JSON.stringify(session), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  )
}

export function clearAuthSession(): Promise<void> {
  return queueMutation(() => SecureStore.deleteItemAsync(AUTH_SESSION_KEY))
}

function queueMutation(operation: () => Promise<void>): Promise<void> {
  const next = pendingMutation.then(operation, operation)
  pendingMutation = next.catch(() => undefined)
  return next
}

function parseAuthSession(value: unknown): CachedAuthSession | null {
  if (!isRecord(value)) return null
  const backend = value.backend
  const user = value.user
  if (
    !isRecord(backend) ||
    !isRecord(user) ||
    typeof backend.backendUrl !== 'string' ||
    typeof backend.apiBaseUrl !== 'string' ||
    typeof backend.socketBaseUrl !== 'string' ||
    typeof backend.socketPath !== 'string' ||
    typeof value.accessToken !== 'string' ||
    !value.accessToken ||
    (value.accessTokenExpiresAt !== null && typeof value.accessTokenExpiresAt !== 'number') ||
    typeof user.id !== 'number' ||
    typeof user.user_name !== 'string'
  ) {
    return null
  }
  return value as unknown as CachedAuthSession
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
