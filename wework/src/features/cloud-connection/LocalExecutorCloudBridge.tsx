import { useEffect, useRef } from 'react'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
} from '@/tauri/localExecutor'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'

interface LocalExecutorCloudBridgeProps {
  backendUrl?: string
  isConnected: boolean
  token: string | null
}

export function LocalExecutorCloudBridge({
  backendUrl: configuredBackendUrl,
  isConnected,
  token,
}: LocalExecutorCloudBridgeProps) {
  const lastTargetRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isCloudConnectionUiAvailable()) return

    const backendUrl = isConnected ? configuredBackendUrl : null
    const authToken = isConnected ? token : null
    const connected = Boolean(backendUrl && authToken)
    const target = connected ? `${backendUrl}\n${authToken}` : 'disconnected'
    if (lastTargetRef.current === target) return

    lastTargetRef.current = target
    if (connected && backendUrl && authToken) {
      void connectLocalExecutorToBackend({
        backendUrl,
        authToken,
      }).catch(error => {
        console.error('[CloudConnection] Failed to connect runtime task service to cloud', error)
      })
      return
    }

    void disconnectLocalExecutorFromBackend().catch(error => {
      console.error('[CloudConnection] Failed to disconnect runtime task service from cloud', error)
    })
  }, [configuredBackendUrl, isConnected, token])

  return null
}
