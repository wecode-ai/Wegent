import { useEffect, useRef } from 'react'
import {
  applyLocalExecutorCloudConnection,
  type LocalExecutorCloudConnection,
} from './localExecutorCloudConnection'

type LocalExecutorCloudBridgeProps = LocalExecutorCloudConnection

export function LocalExecutorCloudBridge({
  backendUrl: configuredBackendUrl,
  isConnected,
  token,
}: LocalExecutorCloudBridgeProps) {
  const lastTargetRef = useRef<string | null>(null)

  useEffect(() => {
    const backendUrl = isConnected ? configuredBackendUrl : null
    const authToken = isConnected ? token : null
    const connected = Boolean(backendUrl && authToken)
    const target = connected ? `${backendUrl}\n${authToken}` : 'disconnected'
    if (lastTargetRef.current === target) return

    lastTargetRef.current = target
    void applyLocalExecutorCloudConnection({
      backendUrl: configuredBackendUrl,
      isConnected,
      token,
    }).catch(error => {
      if (connected) {
        console.error('[CloudConnection] Failed to connect runtime task service to cloud', error)
        return
      }
      console.error('[CloudConnection] Failed to disconnect runtime task service from cloud', error)
    })
  }, [configuredBackendUrl, isConnected, token])

  return null
}
