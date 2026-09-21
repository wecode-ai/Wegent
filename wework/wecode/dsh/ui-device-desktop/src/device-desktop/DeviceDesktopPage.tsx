import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Loader2, Monitor } from 'lucide-react'

import { VncViewer } from './VncViewer'
import { useTranslation } from '@/hooks/useTranslation'
import { supportsVncDesktop } from '@wecode/features/vnc/device-capabilities'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { createVncDeviceClipboardBridge } from './vnc-device-clipboard'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import type { DeviceSessionResponse } from '@/types/devices'
import {
  isIsolatedDeviceDesktopSurface,
  isolatedDeviceDesktopUrl,
} from '@wecode/features/vnc/deviceDesktopRoute'

type DeviceDesktopPageState =
  | { status: 'loading' }
  | { status: 'ready'; sessionId: string; websocketUrl: string }
  | { status: 'error'; reason: 'unavailable' | 'failed' }

function parseDeviceId(search?: string): string {
  const params = new URLSearchParams((search ?? window.location.search).replace(/^\?/, ''))
  return params.get('deviceId')?.trim() ?? ''
}

function assertVncWebsocketSession(session: DeviceSessionResponse): string {
  if (session.type !== 'vnc' || session.transport !== 'websocket') {
    throw new Error('Unexpected VNC session response')
  }
  let url: URL
  try {
    url = new URL(session.url.trim())
  } catch {
    throw new Error('VNC session did not return a websocket URL')
  }
  const queryKeys = Array.from(url.searchParams.keys())
  const safeSessionId = /^[A-Za-z0-9_-]+$/.test(session.session_id)
  if (
    !safeSessionId ||
    !['ws:', 'wss:'].includes(url.protocol) ||
    Boolean(url.username || url.password || url.hash) ||
    url.pathname !== `/vnc-proxy/sessions/${session.session_id}` ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'ticket' ||
    !url.searchParams.get('ticket')
  ) {
    throw new Error('VNC session returned an unsafe websocket URL')
  }
  return url.toString()
}

function IsolatedVncSurface({ deviceId }: { deviceId: string }) {
  const partition = useMemo(() => `wework-vnc-surface-route:${makeVncSurfaceId()}`, [])

  return (
    <div data-testid="device-desktop-isolated-surface" className="h-full min-h-0 bg-background">
      {createElement('webview', {
        'data-wework-vnc-surface': 'true',
        key: deviceId,
        partition,
        src: isolatedDeviceDesktopUrl(deviceId),
        style: { display: 'flex', height: '100%', width: '100%' },
        tabIndex: 0,
      })}
    </div>
  )
}

function makeVncSurfaceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function InlineDeviceDesktopPage({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('vnc')
  const { services, state } = useWorkbench()
  const startDeviceVnc = services.workspaceSessionApi?.startDeviceExtensionSession
  const revokeDeviceVnc = services.workspaceSessionApi?.revokeDeviceExtensionSession
  const device = findWorkbenchDevice(state.devices, deviceId)
  const cloudDesktopAvailable = Boolean(device && supportsVncDesktop(device, deviceId))
  const clipboardBridge = useMemo(
    () =>
      cloudDesktopAvailable
        ? createVncDeviceClipboardBridge(services.deviceApi, deviceId)
        : undefined,
    [cloudDesktopAvailable, deviceId, services.deviceApi]
  )
  const desktopAvailable = !device || cloudDesktopAvailable
  const [pageState, setPageState] = useState<DeviceDesktopPageState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const reconnect = useCallback(() => setAttempt(current => current + 1), [])

  useEffect(() => {
    let active = true
    let createdSessionId: string | null = null

    queueMicrotask(() => {
      if (!active) return
      if (!deviceId || !desktopAvailable) {
        setPageState({ status: 'error', reason: 'unavailable' })
        return
      }
      if (!startDeviceVnc) {
        console.warn('[VNC] Desktop session API is unavailable in the current workbench')
        setPageState({ status: 'error', reason: 'failed' })
        return
      }
      setPageState({ status: 'loading' })

      void (async () => {
        let stage: 'request' | 'validation' = 'request'
        try {
          const session = await startDeviceVnc(deviceId, 'vnc')
          createdSessionId = session.session_id
          stage = 'validation'
          const websocketUrl = assertVncWebsocketSession(session)
          if (!active) {
            await revokeDeviceVnc?.('vnc', session.session_id).catch(() => undefined)
            createdSessionId = null
            return
          }
          setPageState({
            status: 'ready',
            sessionId: session.session_id,
            websocketUrl,
          })
        } catch (error) {
          console.warn('[VNC] Desktop session startup failed', {
            stage,
            errorName: error instanceof Error ? error.name : typeof error,
            status:
              error && typeof error === 'object' && 'status' in error ? error.status : undefined,
          })
          if (createdSessionId && revokeDeviceVnc) {
            await revokeDeviceVnc('vnc', createdSessionId).catch(() => undefined)
            createdSessionId = null
          }
          if (active) setPageState({ status: 'error', reason: 'failed' })
        }
      })()
    })

    return () => {
      active = false
      if (createdSessionId && revokeDeviceVnc) {
        void revokeDeviceVnc('vnc', createdSessionId).catch(() => undefined)
        createdSessionId = null
      }
    }
  }, [attempt, desktopAvailable, deviceId, revokeDeviceVnc, startDeviceVnc])

  if (pageState.status === 'ready') {
    return (
      <VncViewer
        clipboardBridge={clipboardBridge}
        websocketUrl={pageState.websocketUrl}
        onReconnectRequired={reconnect}
      />
    )
  }

  const loading = pageState.status === 'loading'
  const message =
    loading || pageState.status !== 'error'
      ? t('workbench.device_desktop_connecting')
      : t(
          pageState.reason === 'unavailable'
            ? 'workbench.device_desktop_unavailable'
            : 'workbench.device_desktop_session_failed'
        )
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-6 text-text-primary">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-text-secondary">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
          )}
        </div>
        <div className="space-y-1">
          <h1 className="text-base font-medium text-text-primary">
            {t('workbench.device_desktop')}
          </h1>
          <p data-testid="device-desktop-status" className="text-sm text-text-secondary">
            {message}
          </p>
        </div>
        {!loading && (
          <button
            type="button"
            data-testid="device-desktop-reconnect-button"
            onClick={reconnect}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm font-medium text-text-primary hover:bg-muted"
          >
            <Monitor className="h-4 w-4" aria-hidden="true" />
            <span>{t('workbench.device_desktop_reconnect')}</span>
          </button>
        )}
      </div>
    </div>
  )
}

export default function DeviceDesktopPage({ search }: { search?: string }) {
  const { state } = useWorkbench()
  const routeSearch = search ?? window.location.search
  const deviceId = useMemo(() => parseDeviceId(routeSearch), [routeSearch])
  const device = findWorkbenchDevice(state.devices, deviceId)
  const shouldIsolate =
    isElectronRuntime() &&
    !isIsolatedDeviceDesktopSurface(routeSearch) &&
    (!device || supportsVncDesktop(device, deviceId))

  if (shouldIsolate && deviceId) return <IsolatedVncSurface deviceId={deviceId} />
  return <InlineDeviceDesktopPage deviceId={deviceId} />
}
