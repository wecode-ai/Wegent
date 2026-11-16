import * as SecureStore from 'expo-secure-store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPhoneLocalProfile,
  selectPhoneLocalProfile,
  LocalProfileSelectionRequired,
  legacyPhoneScope,
} from './phoneLocalProfile'
import type { NativeLocalRuntime } from './localRuntime'

const storage = vi.hoisted(() => new Map<string, string>())
const auth = vi.hoisted(() => vi.fn().mockResolvedValue(null))
vi.mock('expo-crypto', () => ({ randomUUID: () => 'new-independent-phone' }))
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storage.set(key, value)
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
vi.mock('@/auth/authSessionStore', () => ({ loadAuthSession: auth }))
const key = 'wework.mobile.local-profile.v1'
const a = 'a'.repeat(64)
const b = 'b'.repeat(64)
const profile = (accountScope: string) => ({ accountScope, modifiedAt: 1000 })
function native(profiles = [profile(a)], scope?: string) {
  return {
    getStatusAsync: vi.fn().mockResolvedValue({ accountScope: scope }),
    listProfilesAsync: vi.fn().mockResolvedValue(profiles),
  } as unknown as NativeLocalRuntime
}
describe('persistent phone identity', () => {
  beforeEach(() => {
    storage.clear()
    auth.mockReset().mockResolvedValue(null)
    vi.clearAllMocks()
  })
  it('adopts the sole guest root after old Backend logout without creating another root', async () => {
    expect(await loadPhoneLocalProfile(native())).toBe(a)
    expect(storage.get(key)).toBe(a)
    expect(auth).not.toHaveBeenCalled()
  })
  it('requires an explicit choice between multiple preserved environments', async () => {
    const bridge = native([profile(a), profile(b)])
    await expect(loadPhoneLocalProfile(bridge)).rejects.toBeInstanceOf(
      LocalProfileSelectionRequired
    )
    expect(storage.has(key)).toBe(false)
    await selectPhoneLocalProfile(bridge, b)
    expect(await loadPhoneLocalProfile(bridge)).toBe(b)
  })
  it('never changes a chosen environment on Backend login or account switch', async () => {
    storage.set(key, a)
    auth.mockResolvedValue({ backend: { apiBaseUrl: 'https://other/api' }, user: { id: 9 } })
    expect(await loadPhoneLocalProfile(native([profile(b)], b))).toBe(a)
    expect(auth).not.toHaveBeenCalled()
  })
  it('adopts an already mounted environment without enumerating or remounting roots', async () => {
    const bridge = native([profile(a), profile(b)], b)
    expect(await loadPhoneLocalProfile(bridge)).toBe(b)
    expect(bridge.listProfilesAsync).not.toHaveBeenCalled()
  })
  it('creates one stable identity for concurrent first launches', async () => {
    const bridge = native([])
    const values = await Promise.all([loadPhoneLocalProfile(bridge), loadPhoneLocalProfile(bridge)])
    expect(values[0]).toMatch(/^[a-f0-9]{64}$/)
    expect(values[0]).toBe(values[1])
    expect(bridge.listProfilesAsync).toHaveBeenCalledOnce()
  })
  it('inherits the previous scope when no initialized root exists yet', async () => {
    auth.mockResolvedValue({ backend: { apiBaseUrl: 'https://old/api/' }, user: { id: 2 } })
    expect(await loadPhoneLocalProfile(native([]))).toBe(legacyPhoneScope('https://old/api', 2))
  })
  it('preserves damaged identity and surfaces storage errors for recovery', async () => {
    storage.set(key, 'damaged')
    await expect(loadPhoneLocalProfile(native())).rejects.toThrow('损坏')
    expect(storage.get(key)).toBe('damaged')
    storage.clear()
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain locked'))
    await expect(loadPhoneLocalProfile(native())).rejects.toThrow('keychain locked')
    expect(storage.size).toBe(0)
    expect(await loadPhoneLocalProfile(native())).toBe(a)
  })
  it('surfaces discovery failures and rejects a vanished selection without changing identity', async () => {
    const bridge = native()
    vi.mocked(bridge.listProfilesAsync).mockRejectedValueOnce(new Error('permission denied'))
    await expect(loadPhoneLocalProfile(bridge)).rejects.toThrow('permission denied')
    storage.set(key, a)
    await expect(selectPhoneLocalProfile(bridge, b)).rejects.toThrow('不可用')
    expect(storage.get(key)).toBe(a)
  })
})
