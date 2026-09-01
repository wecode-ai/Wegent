import { beforeEach, describe, expect, it, vi } from 'vitest'

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}))

vi.mock('expo-secure-store', () => ({
  ...secureStore,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
}))

import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  loadRuntimePermissionMode,
  saveRuntimePermissionMode,
} from './runtimePermissionPreference'

describe('runtime permission preference', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the Wework full-access default when no valid choice is stored', async () => {
    secureStore.getItemAsync.mockResolvedValue('legacy-value')

    await expect(loadRuntimePermissionMode()).resolves.toBe(DEFAULT_RUNTIME_PERMISSION_MODE)
  })

  it('restores the last valid local choice', async () => {
    secureStore.getItemAsync.mockResolvedValue('workspace-write')

    await expect(loadRuntimePermissionMode()).resolves.toBe('workspace-write')
  })

  it('stores a changed choice on this device', async () => {
    secureStore.setItemAsync.mockResolvedValue(undefined)

    await saveRuntimePermissionMode('read-only')

    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'wegent.mobile.runtime-permission-mode.v1',
      'read-only',
      { keychainAccessible: 'when-unlocked-this-device-only' }
    )
  })
})
