import { beforeEach, describe, expect, it, vi } from 'vitest'

let stored: string | null = null
let pendingWrite: Promise<void> | null = null

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  deleteItemAsync: vi.fn(async () => {
    stored = null
  }),
  getItemAsync: vi.fn(async () => stored),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    await pendingWrite
    stored = value
  }),
}))

import { clearAuthSession, loadAuthSession, saveAuthSession } from './authSessionStore'

describe('authSessionStore', () => {
  beforeEach(() => {
    stored = null
    pendingWrite = null
  })

  it('restores the authenticated shell before background token refresh', async () => {
    await saveAuthSession({
      backend: {
        backendUrl: 'https://wegent.example',
        apiBaseUrl: 'https://wegent.example/api',
        socketBaseUrl: 'wss://wegent.example',
        socketPath: '/socket.io',
      },
      accessToken: 'cached-access-token',
      accessTokenExpiresAt: 1_800_000_000_000,
      user: { id: 7, user_name: 'hongyu9' },
    })

    await expect(loadAuthSession()).resolves.toMatchObject({
      accessToken: 'cached-access-token',
      user: { id: 7 },
    })
    await clearAuthSession()
    await expect(loadAuthSession()).resolves.toBeNull()
  })

  it('drops malformed sessions instead of exposing another account cache', async () => {
    stored = JSON.stringify({ accessToken: 'broken' })

    await expect(loadAuthSession()).resolves.toBeNull()
    expect(stored).toBeNull()
  })

  it('serializes logout after an in-flight session write', async () => {
    let releaseWrite: () => void = () => undefined
    pendingWrite = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const saving = saveAuthSession({
      backend: {
        backendUrl: 'https://wegent.example',
        apiBaseUrl: 'https://wegent.example/api',
        socketBaseUrl: 'wss://wegent.example',
        socketPath: '/socket.io',
      },
      accessToken: 'stale-access-token',
      accessTokenExpiresAt: null,
      user: { id: 7, user_name: 'hongyu9' },
    })
    const clearing = clearAuthSession()

    releaseWrite()
    await Promise.all([saving, clearing])

    await expect(loadAuthSession()).resolves.toBeNull()
  })
})
