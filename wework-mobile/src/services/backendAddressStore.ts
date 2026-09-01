import * as SecureStore from 'expo-secure-store'

const STORAGE_KEY = 'wegent.mobile.backend-address.v1'

export async function loadBackendAddress(): Promise<string | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEY)
  return stored?.trim() || null
}

export function saveBackendAddress(backendUrl: string): Promise<void> {
  return SecureStore.setItemAsync(STORAGE_KEY, backendUrl, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}
