import { useEffect, useRef } from 'react'
import {
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
} from '@/tauri/localExecutor'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'
import { useCloudConnection } from './useCloudConnection'

export function LocalExecutorCloudBridge() {
  const cloud = useCloudConnection()
  const lastTargetRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isCloudConnectionUiAvailable()) return

    const backendUrl = cloud.isConnected ? cloud.backendUrl : null
    const authToken = cloud.isConnected ? cloud.token : null
    const connected = Boolean(backendUrl && authToken)
    const target = connected ? `${backendUrl}\n${authToken}` : 'disconnected'
    if (lastTargetRef.current === target) return

    if (!connected && lastTargetRef.current === null && cloud.status === 'disconnected') {
      lastTargetRef.current = target
      return
    }

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
  }, [cloud.backendUrl, cloud.isConnected, cloud.status, cloud.token])

  return null
}
