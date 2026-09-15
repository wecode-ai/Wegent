import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Loader2, Monitor } from 'lucide-react'

import { VncViewer } from '@/components/vnc/VncViewer'
import { useTranslation } from '@/hooks/useTranslation'
import { supportsVncDesktop } from '@/lib/device-capabilities'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import type { DeviceSessionResponse } from '@/types/devices'

type DeviceDesktopPageState =
  | { status: 'loading' }
  | { status: 'ready'; websocketUrl: string }
  | { status: 'error'; reason: 'unavailable' | 'failed' }

function parseDeviceId(search?: string): string {
  const params = new URLSearchParams((search ?? window.location.search).replace(/^\?/, ''))
  return params.get('deviceId')?.trim() ?? ''
}

function assertVncWebsocketSession(session: DeviceSessionResponse): string {
  if (session.type !== 'vnc' || session.transport !== 'websocket') {
    throw new Error('Unexpected VNC session response')
  }
  const url = session.url.trim()
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    throw new Error('VNC session did not return a websocket URL')
  }
  return url
}

export default function DeviceDesktopPage({ search }: { search?: string }) {
  const { t } = useTranslation('common')
  const { services, state } = useWorkbench()
  const startDeviceVnc = services.workspaceSessionApi?.startDeviceVnc
  const deviceId = useMemo(() => parseDeviceId(search), [search])
  const device = state.devices.find(item => item.device_id === deviceId) ?? null
  const [pageState, setPageState] = useState<DeviceDesktopPageState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  const startSession = useCallback(async () => {
    if (!deviceId) {
      setPageState({
        status: 'error',
        reason: 'unavailable',
      })
      return
    }
    if (!device || !supportsVncDesktop(device, deviceId)) {
      setPageState({
        status: 'error',
        reason: 'unavailable',
      })
      return
    }
    if (!startDeviceVnc) {
      setPageState({
        status: 'error',
        reason: 'failed',
      })
      return
    }
    setPageState({ status: 'loading' })
    try {
      const session = await startDeviceVnc(deviceId)
      setPageState({ status: 'ready', websocketUrl: assertVncWebsocketSession(session) })
    } catch {
      setPageState({
        status: 'error',
        reason: 'failed',
      })
    }
  }, [device, deviceId, startDeviceVnc])

  useEffect(() => {
    queueMicrotask(() => {
      void startSession()
    })
  }, [attempt, startSession])

  if (pageState.status === 'ready') {
    return <VncViewer websocketUrl={pageState.websocketUrl} />
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
            onClick={() => setAttempt(current => current + 1)}
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
