import { Monitor } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { DeviceActionButton } from '@/components/settings/DeviceActionButton'
import type { CloudDesktopActionProps } from '@/extensions/cloud-desktop-contract'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { openCloudDesktop } from './openCloudDesktop'

export function VncDesktopButton({ deviceId, disabled, onOpened }: CloudDesktopActionProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const [requestState, setRequestState] = useState<{
    connectedAt: string | null
    deviceId: string
    isConnected: boolean
    serviceKey: string
    token: string | null
    requestGeneration: number
    loading: boolean
    error: string | null
  } | null>(null)
  const requestStateIsCurrent = Boolean(
    requestState &&
    requestState.connectedAt === cloudConnection.connectedAt &&
    requestState.deviceId === deviceId &&
    requestState.isConnected === cloudConnection.isConnected &&
    requestState.serviceKey === cloudConnection.serviceKey &&
    requestState.token === cloudConnection.token
  )
  const loading = requestStateIsCurrent ? Boolean(requestState?.loading) : false
  const error = requestStateIsCurrent ? (requestState?.error ?? null) : null
  const mountedRef = useRef(true)
  const requestGenerationRef = useRef(0)
  const latestRequestContextRef = useRef({
    connectedAt: cloudConnection.connectedAt,
    deviceId,
    isConnected: cloudConnection.isConnected,
    serviceKey: cloudConnection.serviceKey,
    token: cloudConnection.token,
  })
  const openFailedMessage = t(
    'workbench.connection_device_desktop_open_failed',
    '无法在 Wework 中打开云桌面，请重试'
  )

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    latestRequestContextRef.current = {
      connectedAt: cloudConnection.connectedAt,
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
    deviceId,
  ])

  const handleClick = useCallback(async () => {
    if (disabled || loading || !cloudConnection.isConnected) return
    const requestGeneration = requestGenerationRef.current + 1
    requestGenerationRef.current = requestGeneration
    const requestStateContext = {
      connectedAt: cloudConnection.connectedAt,
      deviceId,
      isConnected: cloudConnection.isConnected,
      requestGeneration,
      serviceKey: cloudConnection.serviceKey,
      token: cloudConnection.token,
    }
    setRequestState({ ...requestStateContext, loading: true, error: null })

    if (!cloudConnection.socketBaseUrl || !cloudConnection.token) {
      setRequestState({ ...requestStateContext, loading: false, error: openFailedMessage })
      return
    }

    const requestContext = {
      connectedAt: cloudConnection.connectedAt,
      deviceId,
      serviceKey: cloudConnection.serviceKey,
      token: cloudConnection.token,
    }
    const isCurrentRequest = () => {
      const latest = latestRequestContextRef.current
      return (
        mountedRef.current &&
        requestGenerationRef.current === requestGeneration &&
        latest.isConnected &&
        latest.connectedAt === requestContext.connectedAt &&
        latest.deviceId === requestContext.deviceId &&
        latest.serviceKey === requestContext.serviceKey &&
        latest.token === requestContext.token
      )
    }

    try {
      const opened = await openCloudDesktop({
        connection: cloudConnection,
        deviceId,
        isCurrent: isCurrentRequest,
      })
      if (opened) onOpened()
    } catch (exception) {
      if (!isCurrentRequest()) return
      console.error('Failed to open device desktop:', exception)
      setRequestState({ ...requestStateContext, loading: true, error: openFailedMessage })
    } finally {
      if (mountedRef.current && requestGenerationRef.current === requestGeneration) {
        setRequestState(current =>
          current &&
          current.connectedAt === requestStateContext.connectedAt &&
          current.deviceId === requestStateContext.deviceId &&
          current.requestGeneration === requestGeneration &&
          current.serviceKey === requestStateContext.serviceKey &&
          current.token === requestStateContext.token
            ? { ...current, loading: false }
            : current
        )
      }
    }
  }, [cloudConnection, deviceId, disabled, loading, onOpened, openFailedMessage])

  return (
    <div className="flex flex-col items-end gap-1">
      <DeviceActionButton
        testId={`connection-vnc-button-${deviceId}`}
        icon={Monitor}
        label={t('workbench.connection_device_desktop', '桌面')}
        onClick={handleClick}
        disabled={disabled || loading || !cloudConnection.isConnected}
      />
      {error && (
        <p
          role="alert"
          data-testid={`connection-vnc-error-${deviceId}`}
          className="max-w-48 text-right text-xs text-red-500"
        >
          {error}
        </p>
      )}
    </div>
  )
}
