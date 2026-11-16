import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { loadAuthSession } from '@/auth/authSessionStore'
import type { LocalRuntimeProfile, NativeLocalRuntime } from './localRuntime'

const PROFILE_KEY = 'wework.mobile.local-profile.v1'
const SCOPE = /^[a-f0-9]{64}$/
let pending: Promise<string> | undefined

export const PHONE_LOCAL_USER = { id: 0, user_name: 'local', email: 'local@wework.local' }

export function legacyPhoneScope(apiBaseUrl: string, userId: number): string {
  return bytesToHex(sha256(utf8ToBytes(`${apiBaseUrl.replace(/\/+$/, '')}\0${userId}`)))
}

export class LocalProfileSelectionRequired extends Error {
  constructor(readonly profiles: LocalRuntimeProfile[]) {
    super('发现多个旧版本机环境，请选择要继续使用的环境。所有文件和会话均会保留。')
  }
}

async function persistProfile(scope: string): Promise<string> {
  if (!SCOPE.test(scope)) throw new Error('本机身份记录已损坏，请修复后重试')
  await SecureStore.setItemAsync(PROFILE_KEY, scope, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
  return scope
}

export async function selectPhoneLocalProfile(
  native: NativeLocalRuntime,
  scope: string
): Promise<void> {
  const profiles = await native.listProfilesAsync()
  if (!profiles.some(profile => profile.accountScope === scope))
    throw new Error('本机环境已不可用，请刷新后重试')
  await persistProfile(scope)
}

/** Adopt the existing root once; Backend login never selects the phone's filesystem. */
export function loadPhoneLocalProfile(native: NativeLocalRuntime | null): Promise<string> {
  if (pending) return pending
  const operation = (async () => {
    const stored = await SecureStore.getItemAsync(PROFILE_KEY)
    if (stored !== null) {
      if (!SCOPE.test(stored)) throw new Error('本机身份记录已损坏，请修复后重试')
      return stored
    }
    const status = await native?.getStatusAsync()
    if (status?.accountScope && SCOPE.test(status.accountScope))
      return persistProfile(status.accountScope)
    const profiles = (await native?.listProfilesAsync()) ?? []
    if (profiles.length > 1) throw new LocalProfileSelectionRequired(profiles)
    if (profiles.length === 1) return persistProfile(profiles[0].accountScope)
    const legacy = await loadAuthSession()
    return persistProfile(
      legacy
        ? legacyPhoneScope(legacy.backend.apiBaseUrl, legacy.user.id)
        : bytesToHex(sha256(utf8ToBytes(Crypto.randomUUID())))
    )
  })()
  pending = operation
  void operation
    .finally(() => {
      if (pending === operation) pending = undefined
    })
    .catch(() => {})
  return operation
}
