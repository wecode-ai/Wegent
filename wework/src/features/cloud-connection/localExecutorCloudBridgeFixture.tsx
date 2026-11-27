import type { ComponentProps } from 'react'
import { LocalExecutorCloudBridge } from './LocalExecutorCloudFixture'

export function connectedCloudBridge(
  overrides: Partial<ComponentProps<typeof LocalExecutorCloudBridge>> = {}
) {
  return (
    <LocalExecutorCloudBridge
      preferencesLoaded
      apiBaseUrl="https://backend.example.com/api"
      backendUrl="https://backend.example.com"
      socketBaseUrl="wss://socket.example.com"
      isConnected
      token="token-a"
      {...overrides}
    />
  )
}
