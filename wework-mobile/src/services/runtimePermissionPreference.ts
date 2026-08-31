import * as SecureStore from 'expo-secure-store'

export type RuntimePermissionMode = 'read-only' | 'workspace-write' | 'full-access'

export const DEFAULT_RUNTIME_PERMISSION_MODE: RuntimePermissionMode = 'full-access'

const STORAGE_KEY = 'wegent.mobile.runtime-permission-mode.v1'

export async function loadRuntimePermissionMode(): Promise<RuntimePermissionMode> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEY)
  return isRuntimePermissionMode(stored) ? stored : DEFAULT_RUNTIME_PERMISSION_MODE
}

export function saveRuntimePermissionMode(mode: RuntimePermissionMode): Promise<void> {
  return SecureStore.setItemAsync(STORAGE_KEY, mode, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

function isRuntimePermissionMode(value: string | null): value is RuntimePermissionMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access'
}
