import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import RFB from '@novnc/novnc'
import {
  Clipboard,
  Keyboard,
  Maximize2,
  Minimize2,
  MousePointer2,
  Power,
  ScreenShare,
} from 'lucide-react'

import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import type { TFunction } from 'i18next'

type VncStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface VncViewerProps {
  websocketUrl: string
}

function makeLeaseId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function activateClipboardLease(leaseId: string): Promise<boolean> {
  if (!isElectronRuntime()) return false
  try {
    await invokeDesktopHost('vncClipboard.activate', { leaseId })
    return true
  } catch {
    return false
  }
}

async function deactivateClipboardLease(leaseId: string): Promise<void> {
  if (!isElectronRuntime()) return
  try {
    await invokeDesktopHost('vncClipboard.deactivate', { leaseId })
  } catch {
    // The lease is best-effort cleanup; the main process also validates focus.
  }
}

async function writeNativeClipboard(leaseId: string, text: string): Promise<void> {
  if (!isElectronRuntime()) return
  await invokeDesktopHost('vncClipboard.writeText', { leaseId, text })
}

async function readNativeClipboard(leaseId: string): Promise<string> {
  if (isElectronRuntime()) {
    return invokeDesktopHost<string>('vncClipboard.readText', { leaseId })
  }
  return navigator.clipboard?.readText?.() ?? ''
}

function viewerStatusLabel(status: VncStatus, t: TFunction) {
  switch (status) {
    case 'connected':
      return t('workbench.device_desktop_connected')
    case 'disconnected':
      return t('workbench.device_desktop_disconnected')
    case 'error':
      return t('workbench.device_desktop_session_failed')
    default:
      return t('workbench.device_desktop_connecting')
  }
}

function ToolbarButton({
  active,
  children,
  disabled,
  label,
  onClick,
  testId,
}: {
  active?: boolean
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50',
        active && 'bg-muted text-text-primary'
      )}
    >
      {children}
    </button>
  )
}

export function VncViewer({ websocketUrl }: VncViewerProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const leaseId = useMemo(() => makeLeaseId(), [])
  const [status, setStatus] = useState<VncStatus>('connecting')
  const [clipboardAvailable, setClipboardAvailable] = useState(false)
  const [clipboardError, setClipboardError] = useState<string | null>(null)
  const [viewOnly, setViewOnly] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const target = containerRef.current
    if (!target) return

    target.replaceChildren()
    setStatus('connecting')
    setClipboardError(null)

    const rfb = new RFB(target, websocketUrl, { shared: true })
    rfb.scaleViewport = true
    rfb.resizeSession = true
    rfb.clipViewport = true
    rfb.focusOnClick = true
    rfb.qualityLevel = 6
    rfb.compressionLevel = 2
    rfb.viewOnly = false
    rfbRef.current = rfb

    const handleConnect = () => {
      setStatus('connected')
      rfb.focus()
    }
    const handleDisconnect = (event: CustomEvent<{ clean?: boolean }>) => {
      setStatus(event.detail?.clean ? 'disconnected' : 'error')
    }
    const handleSecurityFailure = () => setStatus('error')
    const handleClipboard = (event: CustomEvent<{ text?: string }>) => {
      const text = event.detail?.text
      if (typeof text !== 'string') return
      void writeNativeClipboard(leaseId, text).catch(() => {
        setClipboardError(t('workbench.device_desktop_clipboard_failed'))
      })
    }

    rfb.addEventListener('connect', handleConnect)
    rfb.addEventListener('disconnect', handleDisconnect)
    rfb.addEventListener('securityfailure', handleSecurityFailure)
    rfb.addEventListener('clipboard', handleClipboard)

    void activateClipboardLease(leaseId).then(setClipboardAvailable)

    return () => {
      rfb.removeEventListener('connect', handleConnect)
      rfb.removeEventListener('disconnect', handleDisconnect)
      rfb.removeEventListener('securityfailure', handleSecurityFailure)
      rfb.removeEventListener('clipboard', handleClipboard)
      rfb.disconnect()
      if (rfbRef.current === rfb) rfbRef.current = null
      void deactivateClipboardLease(leaseId)
    }
  }, [leaseId, t, websocketUrl])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === shellRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly
  }, [viewOnly])

  const pasteText = useCallback((text: string) => {
    if (!text) return
    rfbRef.current?.clipboardPasteFrom(text)
    setClipboardError(null)
  }, [])

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData('text/plain')
      if (!text) return
      event.preventDefault()
      pasteText(text)
    },
    [pasteText]
  )

  const handleNativePaste = useCallback(async () => {
    try {
      pasteText(await readNativeClipboard(leaseId))
    } catch {
      setClipboardError(t('workbench.device_desktop_clipboard_failed'))
    }
  }, [leaseId, pasteText, t])

  const handleToggleFullscreen = useCallback(() => {
    const shell = shellRef.current
    if (!shell) return
    if (document.fullscreenElement === shell) {
      void document.exitFullscreen()
      return
    }
    void shell.requestFullscreen()
  }, [])

  const handleDisconnect = useCallback(() => {
    rfbRef.current?.disconnect()
  }, [])

  return (
    <div
      ref={shellRef}
      data-testid="vnc-viewer"
      onPasteCapture={handlePaste}
      tabIndex={0}
      className="flex h-full min-h-0 flex-col bg-background text-text-primary outline-none"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ScreenShare className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span
            data-testid="vnc-viewer-status"
            className={cn(
              'truncate text-sm',
              status === 'error' ? 'text-red-600 dark:text-red-300' : 'text-text-secondary'
            )}
          >
            {viewerStatusLabel(status, t)}
          </span>
          {clipboardError && (
            <span
              data-testid="vnc-viewer-clipboard-error"
              className="hidden text-sm text-red-600 dark:text-red-300 md:inline"
            >
              {clipboardError}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarButton
            testId="vnc-viewer-paste-button"
            label={t('workbench.device_desktop_paste')}
            onClick={() => void handleNativePaste()}
            disabled={!clipboardAvailable && isElectronRuntime()}
          >
            <Clipboard className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            testId="vnc-viewer-ctrl-alt-del-button"
            label={t('workbench.device_desktop_ctrl_alt_del')}
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
          >
            <Keyboard className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            testId="vnc-viewer-view-only-button"
            label={
              viewOnly
                ? t('workbench.device_desktop_control')
                : t('workbench.device_desktop_view_only')
            }
            onClick={() => setViewOnly(current => !current)}
            active={viewOnly}
          >
            <MousePointer2 className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            testId="vnc-viewer-fullscreen-button"
            label={
              fullscreen
                ? t('workbench.device_desktop_exit_fullscreen')
                : t('workbench.device_desktop_fullscreen')
            }
            onClick={handleToggleFullscreen}
            active={fullscreen}
          >
            {fullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </ToolbarButton>
          <ToolbarButton
            testId="vnc-viewer-disconnect-button"
            label={t('workbench.device_desktop_disconnect')}
            onClick={handleDisconnect}
          >
            <Power className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
        </div>
      </div>
      <div
        ref={containerRef}
        data-testid="vnc-viewer-canvas"
        className="min-h-0 flex-1 overflow-hidden bg-black"
      />
    </div>
  )
}
