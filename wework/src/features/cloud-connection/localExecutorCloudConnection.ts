import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
} from '@/tauri/localExecutor'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'

export interface LocalExecutorCloudConnection {
  apiBaseUrl?: string
  backendUrl?: string
  socketBaseUrl?: string
  isConnected: boolean
  token: string | null
}

export async function applyLocalExecutorCloudConnection({
  backendUrl,
  socketBaseUrl,
  isConnected,
  token,
}: LocalExecutorCloudConnection): Promise<void> {
  if (!isCloudConnectionUiAvailable()) return

  if (isConnected && backendUrl && socketBaseUrl && token) {
    await connectLocalExecutorToBackend({
      backendUrl,
      socketBaseUrl,
      authToken: token,
    })
    return
  }

  await disconnectLocalExecutorFromBackend()
}
