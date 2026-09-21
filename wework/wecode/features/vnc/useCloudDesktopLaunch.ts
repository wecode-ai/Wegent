import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import type { DeviceSurfaceLaunchOptions } from '@/extensions/device-surface-contract'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { openCloudDesktop } from './openCloudDesktop'
import type { CloudDesktopOpenTarget } from './types'

interface UseCloudDesktopLaunchOptions {
  contextKey: string
  deviceId: string
  disabled: boolean
  failureMessage: string
  onBusyChange?: (busy: boolean) => void
  onErrorChange?: (message: string | null) => void
  onOpened: () => void
  target: CloudDesktopOpenTarget
}

interface UseCloudDesktopLaunchResult {
  disabled: boolean
  error: string | null
  loading: boolean
  open: (options?: DeviceSurfaceLaunchOptions) => Promise<void>
}

interface CloudDesktopRequestContext {
  connectedAt: string | null
  contextKey: string
  deviceId: string
  isConnected: boolean
  serviceKey: string
  token: string | null
}

interface CloudDesktopRequestState extends CloudDesktopRequestContext {
  error: string | null
  loading: boolean
  requestGeneration: number
}

export function useCloudDesktopLaunch({
  contextKey,
  deviceId,
  disabled,
  failureMessage,
  onBusyChange,
  onErrorChange,
  onOpened,
  target,
}: UseCloudDesktopLaunchOptions): UseCloudDesktopLaunchResult {
  const cloudConnection = useOptionalCloudConnection()
  const [requestState, setRequestState] = useState<CloudDesktopRequestState | null>(null)
  const mountedRef = useRef(true)
  const requestGenerationRef = useRef(0)
  const latestRequestContextRef = useRef<CloudDesktopRequestContext>({
    connectedAt: cloudConnection.connectedAt,
    contextKey,
    deviceId,
    isConnected: cloudConnection.isConnected,
    serviceKey: cloudConnection.serviceKey,
    token: cloudConnection.token,
  })
  const requestStateIsCurrent = Boolean(
    requestState &&
    requestState.connectedAt === cloudConnection.connectedAt &&
    requestState.contextKey === contextKey &&
    requestState.deviceId === deviceId &&
    requestState.isConnected === cloudConnection.isConnected &&
    requestState.serviceKey === cloudConnection.serviceKey &&
    requestState.token === cloudConnection.token
  )
  const loading = requestStateIsCurrent ? Boolean(requestState?.loading) : false
  const error = requestStateIsCurrent ? (requestState?.error ?? null) : null

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    latestRequestContextRef.current = {
      connectedAt: cloudConnection.connectedAt,
      contextKey,
      deviceId,
      isConnected: cloudConnection.isConnected,
      serviceKey: cloudConnection.serviceKey,
      token: cloudConnection.token,
    }
    const contextGeneration = requestGenerationRef.current + 1
    requestGenerationRef.current = contextGeneration
    queueMicrotask(() => {
      if (!mountedRef.current) return
      setRequestState(current =>
        current && current.requestGeneration < contextGeneration ? null : current
      )
    })
  }, [
    cloudConnection.connectedAt,
    cloudConnection.isConnected,
    cloudConnection.serviceKey,
    cloudConnection.token,
    contextKey,
    deviceId,
  ])

  const open = useCallback(
    async (options?: DeviceSurfaceLaunchOptions) => {
      if (disabled || loading || !cloudConnection.isConnected) return

      const requestGeneration = requestGenerationRef.current + 1
      requestGenerationRef.current = requestGeneration
      const requestContext = {
        connectedAt: cloudConnection.connectedAt,
        contextKey,
        deviceId,
        isConnected: cloudConnection.isConnected,
        requestGeneration,
        serviceKey: cloudConnection.serviceKey,
        token: cloudConnection.token,
      }
      setRequestState({ ...requestContext, error: null, loading: true })
      onErrorChange?.(null)
      onBusyChange?.(true)

      const isCurrentRequest = () => {
        const latest = latestRequestContextRef.current
        return (
          mountedRef.current &&
          requestGenerationRef.current === requestGeneration &&
          latest.isConnected &&
          latest.connectedAt === requestContext.connectedAt &&
          latest.contextKey === requestContext.contextKey &&
          latest.deviceId === requestContext.deviceId &&
          latest.serviceKey === requestContext.serviceKey &&
          latest.token === requestContext.token
        )
      }

      if (!cloudConnection.token || !cloudConnection.socketBaseUrl) {
        setRequestState({ ...requestContext, error: failureMessage, loading: false })
        onErrorChange?.(failureMessage)
        onBusyChange?.(false)
        return
      }

      try {
        const opened = await openCloudDesktop({
          connection: cloudConnection,
          deviceId,
          isCurrent: isCurrentRequest,
          target,
        })
        if (opened && isCurrentRequest() && options?.notifyOpened !== false) onOpened()
      } catch (exception) {
        if (!isCurrentRequest()) return
        console.error('Failed to open device desktop:', exception)
        setRequestState({ ...requestContext, error: failureMessage, loading: true })
        onErrorChange?.(failureMessage)
      } finally {
        if (isCurrentRequest()) {
          setRequestState(current =>
            current?.requestGeneration === requestGeneration
              ? { ...current, loading: false }
              : current
          )
          onBusyChange?.(false)
        }
      }
    },
    [
      cloudConnection,
      contextKey,
      deviceId,
      disabled,
      failureMessage,
      loading,
      onBusyChange,
      onErrorChange,
      onOpened,
      target,
    ]
  )

  return {
    disabled: disabled || loading || !cloudConnection.isConnected,
    error,
    loading,
    open,
  }
}
