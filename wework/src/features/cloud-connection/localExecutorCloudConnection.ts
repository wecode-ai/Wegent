import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
} from '@/tauri/localExecutor'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'

export interface LocalExecutorCloudConnection {
  apiBaseUrl?: string
  backendUrl?: string
  isConnected: boolean
  token: string | null
}

export async function applyLocalExecutorCloudConnection({
  backendUrl,
  isConnected,
  token,
}: LocalExecutorCloudConnection): Promise<void> {
  if (!isCloudConnectionUiAvailable()) return

  if (isConnected && backendUrl && token) {
    await connectLocalExecutorToBackend({
      backendUrl,
      authToken: token,
    })
    return
  }

  await disconnectLocalExecutorFromBackend()
}
