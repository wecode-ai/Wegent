import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import RFB from '@novnc/novnc'
import { Clipboard, Maximize2, Minimize2, Power, RefreshCw, ScreenShare } from 'lucide-react'

import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { useTranslation } from '@/hooks/useTranslation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'
import {
  VncClipboardWriteTooLargeError,
  type VncDeviceClipboardBridge,
} from './vnc-device-clipboard'
import type { TFunction } from 'i18next'

type VncStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
type ClipboardNotice = 'remote-copied' | 'local-synced' | null

const VNC_RENDERING_PROFILE = {
  compressionLevel: 2,
  enableH264: true,
  maxPixelRatio: 1,
  qualityLevel: 8,
}

const REMOTE_RESIZE_DEBOUNCE_MS = 250
const BACKGROUND_SUSPEND_DELAY_MS = 30_000
const CLIPBOARD_SYNC_TIMEOUT_MS = 3_000
const REMOTE_CLIPBOARD_APPLY_DELAY_MS = 250
const XK_ALT_L = 0xffe9
const XK_CONTROL_L = 0xffe3
const XK_SUPER_L = 0xffeb
const XK_C = 0x0063
const XK_V = 0x0076

export interface VncViewerProps {
  clipboardBridge?: VncDeviceClipboardBridge
  onReconnectRequired?: () => void
  websocketUrl: string
}

function emitVncMetric(
  name: 'connected' | 'encoding' | 'first-frame' | 'frame-gap',
  detail: Record<string, number | string>
): void {
  window.dispatchEvent(
    new CustomEvent('wework:vnc-metric', {
      detail: { metric: name, ...detail },
    })
  )
}

function isDocumentInteractive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function applyRenderingProfile(rfb: RFB): void {
  rfb.qualityLevel = VNC_RENDERING_PROFILE.qualityLevel
  rfb.compressionLevel = VNC_RENDERING_PROFILE.compressionLevel
  rfb.remoteResizePixelRatio = Math.min(
    window.devicePixelRatio || 1,
    VNC_RENDERING_PROFILE.maxPixelRatio
  )
  rfb.remoteResizeDebounce = REMOTE_RESIZE_DEBOUNCE_MS
  rfb.enableH264 = VNC_RENDERING_PROFILE.enableH264
}

// The remote is a full Linux desktop, not a terminal: the focused application
// has to receive the ordinary Control+C/Control+V it binds to copy and paste.
// Clipboard text itself is moved separately through the clipboard bridge.
function sendRemoteControlKey(rfb: RFB, keysym: number, code: string): void {
  rfb.focus()
  rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true)
  rfb.sendKey(keysym, code, true)
  rfb.sendKey(keysym, code, false)
  rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false)
}

function releaseRemoteMacCommand(rfb: RFB): void {
  // noVNC maps the macOS Command keys to remote Alt/Super. Release both
  // possible mappings before translating Command+C/V to remote Control+C/V.
  rfb.sendKey(XK_ALT_L, 'MetaLeft', false)
  rfb.sendKey(XK_SUPER_L, 'MetaRight', false)
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
  if (isElectronRuntime()) {
    await invokeDesktopHost('vncClipboard.writeText', { leaseId, text })
    return
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
  await navigator.clipboard.writeText(text)
}

async function readNativeClipboard(leaseId: string): Promise<string> {
  if (isElectronRuntime()) {
    return invokeDesktopHost<string>('vncClipboard.readText', { leaseId })
  }
  if (!navigator.clipboard?.readText) throw new Error('Clipboard API is unavailable')
  return navigator.clipboard.readText()
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
  children,
  disabled,
  label,
  onClick,
  testId,
}: {
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
      disabled={disabled}
      title={label}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function VncViewer({ clipboardBridge, onReconnectRequired, websocketUrl }: VncViewerProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const isSurfaceVisibleRef = useRef(true)
  const suspendedRef = useRef(false)
  const clipboardBridgeRef = useRef(clipboardBridge)
  const clipboardOperationRef = useRef(0)
  const pastePendingRef = useRef(false)
  const pasteSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pasteShortcutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remoteCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tRef = useRef(t)
  const leaseId = useMemo(() => makeLeaseId(), [])
  const [status, setStatus] = useState<VncStatus>('connecting')
  const [clipboardError, setClipboardError] = useState<string | null>(null)
  const [clipboardNotice, setClipboardNotice] = useState<ClipboardNotice>(null)
  const [firstFrameRendered, setFirstFrameRendered] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    clipboardBridgeRef.current = clipboardBridge
  }, [clipboardBridge])

  // The connection effect must not depend on the translation function: a
  // language change would tear down a live RFB connection and reconnect with an
  // already-consumed one-time ticket. Handlers read the latest text through the ref.
  useEffect(() => {
    tRef.current = t
  }, [t])

  const activateSurface = useCallback(() => {
    if (!isSurfaceVisibleRef.current || !isDocumentInteractive()) return
    void activateClipboardLease(leaseId)
  }, [leaseId])

  const deactivateSurface = useCallback(() => {
    void deactivateClipboardLease(leaseId)
  }, [leaseId])

  const clearPendingPaste = useCallback(() => {
    pastePendingRef.current = false
    if (pasteSyncTimeoutRef.current) clearTimeout(pasteSyncTimeoutRef.current)
    if (pasteShortcutTimeoutRef.current) clearTimeout(pasteShortcutTimeoutRef.current)
    pasteSyncTimeoutRef.current = null
    pasteShortcutTimeoutRef.current = null
  }, [])

  const clearPendingCopy = useCallback(() => {
    if (remoteCopyTimeoutRef.current) clearTimeout(remoteCopyTimeoutRef.current)
    remoteCopyTimeoutRef.current = null
  }, [])

  useEffect(() => {
    activateSurface()
  }, [activateSurface])

  useEffect(() => {
    const target = containerRef.current
    if (!target) return

    target.replaceChildren()
    setStatus('connecting')
    setClipboardError(null)
    setClipboardNotice(null)
    setFirstFrameRendered(false)
    const connectionStartedAt = performance.now()
    let lastFrameAt: number | null = null
    let frameGapWindowStartedAt = connectionStartedAt
    let frameGaps: number[] = []

    const rfb = new RFB(target, websocketUrl, { shared: true })
    rfb.scaleViewport = true
    rfb.resizeSession = true
    rfb.clipViewport = true
    rfb.focusOnClick = true
    applyRenderingProfile(rfb)
    rfb.viewOnly = false
    rfbRef.current = rfb

    const handleConnect = () => {
      setStatus('connected')
      rfb.focus()
      emitVncMetric('connected', {
        durationMs: Math.round(performance.now() - connectionStartedAt),
        profile: 'smooth',
      })
      activateSurface()
    }
    const handleDisconnect = (event: CustomEvent<{ clean?: boolean }>) => {
      clipboardOperationRef.current += 1
      clearPendingCopy()
      clearPendingPaste()
      setStatus(event.detail?.clean ? 'disconnected' : 'error')
    }
    const handleSecurityFailure = () => setStatus('error')
    const handleClipboard = (event: CustomEvent<{ text?: string }>) => {
      if (clipboardBridgeRef.current) return
      const text = event.detail?.text
      if (typeof text !== 'string') return
      void (async () => {
        if (isElectronRuntime() && !(await activateClipboardLease(leaseId))) {
          throw new Error('The VNC clipboard lease is inactive')
        }
        await writeNativeClipboard(leaseId, text)
        setClipboardError(null)
        setClipboardNotice('remote-copied')
      })().catch(() => {
        setClipboardNotice(null)
        setClipboardError(tRef.current('workbench.device_desktop_clipboard_failed'))
      })
    }
    const handleClipboardPasteComplete = () => {
      if (!pastePendingRef.current) return
      pastePendingRef.current = false
      if (pasteSyncTimeoutRef.current) clearTimeout(pasteSyncTimeoutRef.current)
      pasteSyncTimeoutRef.current = null
      setClipboardError(null)
      setClipboardNotice('local-synced')
    }
    const handleEncodingChange = (event: CustomEvent<{ encoding: number; name: string }>) => {
      emitVncMetric('encoding', {
        encoding: event.detail.encoding,
        name: event.detail.name,
        profile: 'smooth',
      })
    }
    const handleFramebufferUpdate = () => {
      const now = performance.now()
      if (lastFrameAt === null) {
        setFirstFrameRendered(true)
        emitVncMetric('first-frame', {
          durationMs: Math.round(now - connectionStartedAt),
          profile: 'smooth',
        })
      } else {
        frameGaps.push(now - lastFrameAt)
        if (now - frameGapWindowStartedAt >= 5_000) {
          const sortedGaps = [...frameGaps].sort((left, right) => left - right)
          const percentileIndex = Math.max(0, Math.ceil(sortedGaps.length * 0.95) - 1)
          emitVncMetric('frame-gap', {
            maxMs: Math.round(sortedGaps[sortedGaps.length - 1]),
            p95Ms: Math.round(sortedGaps[percentileIndex]),
            profile: 'smooth',
            samples: sortedGaps.length,
          })
          frameGaps = []
          frameGapWindowStartedAt = now
        }
      }
      lastFrameAt = now
    }
    const handleWindowFocus = () => {
      activateSurface()
    }
    const handleWindowBlur = () => deactivateSurface()

    rfb.addEventListener('connect', handleConnect)
    rfb.addEventListener('disconnect', handleDisconnect)
    rfb.addEventListener('securityfailure', handleSecurityFailure)
    rfb.addEventListener('clipboard', handleClipboard)
    rfb.addEventListener('clipboardpastecomplete', handleClipboardPasteComplete)
    rfb.addEventListener('encodingchange', handleEncodingChange)
    rfb.addEventListener('framebufferupdate', handleFramebufferUpdate)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      rfb.removeEventListener('connect', handleConnect)
      rfb.removeEventListener('disconnect', handleDisconnect)
      rfb.removeEventListener('securityfailure', handleSecurityFailure)
      rfb.removeEventListener('clipboard', handleClipboard)
      rfb.removeEventListener('clipboardpastecomplete', handleClipboardPasteComplete)
      rfb.removeEventListener('encodingchange', handleEncodingChange)
      rfb.removeEventListener('framebufferupdate', handleFramebufferUpdate)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
      clipboardOperationRef.current += 1
      clearPendingCopy()
      clearPendingPaste()
      rfb.disconnect()
      if (rfbRef.current === rfb) rfbRef.current = null
      void deactivateClipboardLease(leaseId)
    }
  }, [
    activateSurface,
    clearPendingCopy,
    clearPendingPaste,
    deactivateSurface,
    leaseId,
    websocketUrl,
  ])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell || typeof IntersectionObserver === 'undefined') return
    let suspendTimer: ReturnType<typeof setTimeout> | null = null

    const cancelSuspend = () => {
      if (suspendTimer) clearTimeout(suspendTimer)
      suspendTimer = null
    }
    const updateVisibility = (visible: boolean) => {
      isSurfaceVisibleRef.current = visible
      if (visible) {
        cancelSuspend()
        activateSurface()
        if (suspendedRef.current) {
          suspendedRef.current = false
          onReconnectRequired?.()
        }
        return
      }
      deactivateSurface()
      cancelSuspend()
      suspendTimer = setTimeout(() => {
        suspendedRef.current = true
        rfbRef.current?.disconnect()
      }, BACKGROUND_SUSPEND_DELAY_MS)
    }
    const observer = new IntersectionObserver(
      entries => updateVisibility(entries.some(entry => entry.isIntersecting)),
      { threshold: 0.01 }
    )
    observer.observe(shell)
    return () => {
      cancelSuspend()
      observer.disconnect()
    }
  }, [activateSurface, deactivateSurface, onReconnectRequired])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') deactivateSurface()
      else activateSurface()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [activateSurface, deactivateSurface])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === shellRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const requestRemoteCopy = useCallback(() => {
    const rfb = rfbRef.current
    if (!rfb || status !== 'connected') return
    sendRemoteControlKey(rfb, XK_C, 'KeyC')
    const bridge = clipboardBridgeRef.current
    if (!bridge) return

    clipboardOperationRef.current += 1
    const operation = clipboardOperationRef.current
    clearPendingCopy()
    setClipboardError(null)
    setClipboardNotice(null)
    remoteCopyTimeoutRef.current = setTimeout(() => {
      remoteCopyTimeoutRef.current = null
      void (async () => {
        if (isElectronRuntime() && !(await activateClipboardLease(leaseId))) {
          throw new Error('The VNC clipboard lease is inactive')
        }
        const text = await bridge.readText()
        if (clipboardOperationRef.current !== operation || rfbRef.current !== rfb) return
        await writeNativeClipboard(leaseId, text)
        if (clipboardOperationRef.current !== operation || rfbRef.current !== rfb) return
        setClipboardError(null)
        setClipboardNotice('remote-copied')
      })().catch(() => {
        if (clipboardOperationRef.current !== operation) return
        setClipboardNotice(null)
        setClipboardError(t('workbench.device_desktop_clipboard_failed'))
      })
    }, REMOTE_CLIPBOARD_APPLY_DELAY_MS)
  }, [clearPendingCopy, leaseId, status, t])

  const pasteText = useCallback(
    async (text: string) => {
      const rfb = rfbRef.current
      if (!text || !rfb || status !== 'connected') return
      const bridge = clipboardBridgeRef.current
      if (bridge) {
        clipboardOperationRef.current += 1
        const operation = clipboardOperationRef.current
        clearPendingCopy()
        clearPendingPaste()
        setClipboardError(null)
        setClipboardNotice(null)
        try {
          await bridge.writeText(text)
          if (clipboardOperationRef.current !== operation || rfbRef.current !== rfb) return
          pasteShortcutTimeoutRef.current = setTimeout(() => {
            pasteShortcutTimeoutRef.current = null
            if (clipboardOperationRef.current !== operation || rfbRef.current !== rfb) return
            sendRemoteControlKey(rfb, XK_V, 'KeyV')
            setClipboardNotice('local-synced')
          }, REMOTE_CLIPBOARD_APPLY_DELAY_MS)
        } catch (error) {
          if (clipboardOperationRef.current !== operation) return
          setClipboardNotice(null)
          setClipboardError(
            error instanceof VncClipboardWriteTooLargeError
              ? t('workbench.device_desktop_clipboard_too_large')
              : t('workbench.device_desktop_clipboard_failed')
          )
        }
        return
      }
      clearPendingPaste()
      pastePendingRef.current = true
      setClipboardError(null)
      setClipboardNotice(null)
      pasteSyncTimeoutRef.current = setTimeout(() => {
        pastePendingRef.current = false
        pasteSyncTimeoutRef.current = null
        setClipboardNotice(null)
        setClipboardError(t('workbench.device_desktop_clipboard_failed'))
      }, CLIPBOARD_SYNC_TIMEOUT_MS)
      rfb.clipboardPasteFrom(text)
      pasteShortcutTimeoutRef.current = setTimeout(() => {
        pasteShortcutTimeoutRef.current = null
        if (rfbRef.current !== rfb) return
        sendRemoteControlKey(rfb, XK_V, 'KeyV')
      }, REMOTE_CLIPBOARD_APPLY_DELAY_MS)
    },
    [clearPendingCopy, clearPendingPaste, status, t]
  )

  const handleCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (status !== 'connected') return
      event.preventDefault()
      event.stopPropagation()
      requestRemoteCopy()
    },
    [requestRemoteCopy, status]
  )

  const handleKeyboardShortcut = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!event.metaKey || status !== 'connected') return
      const key = event.key.toLowerCase()
      if (key !== 'c' && key !== 'v') return

      const rfb = rfbRef.current
      if (!rfb) return
      event.stopPropagation()
      releaseRemoteMacCommand(rfb)
      if (key === 'c') {
        event.preventDefault()
        requestRemoteCopy()
      }
    },
    [requestRemoteCopy, status]
  )

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData('text/plain')
      if (!text) return
      event.preventDefault()
      void pasteText(text)
    },
    [pasteText]
  )

  const handleNativePaste = useCallback(async () => {
    try {
      if (isElectronRuntime() && !(await activateClipboardLease(leaseId))) {
        throw new Error('The VNC clipboard lease is inactive')
      }
      await pasteText(await readNativeClipboard(leaseId))
    } catch {
      setClipboardNotice(null)
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

  const handleConnectionAction = useCallback(() => {
    if (status === 'connecting' || status === 'connected') {
      rfbRef.current?.disconnect()
      return
    }
    onReconnectRequired?.()
  }, [onReconnectRequired, status])

  return (
    <div
      ref={shellRef}
      data-testid="vnc-viewer"
      data-vnc-first-frame={firstFrameRendered ? 'true' : 'false'}
      onCopyCapture={handleCopy}
      onKeyDownCapture={handleKeyboardShortcut}
      onPasteCapture={handlePaste}
      onFocusCapture={activateSurface}
      onPointerDownCapture={activateSurface}
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
          {(clipboardError || clipboardNotice) && (
            <span
              data-testid={
                clipboardError ? 'vnc-viewer-clipboard-error' : 'vnc-viewer-clipboard-notice'
              }
              className={cn(
                'hidden text-sm md:inline',
                clipboardError ? 'text-red-600 dark:text-red-300' : 'text-text-secondary'
              )}
            >
              {clipboardError ||
                t(
                  clipboardNotice === 'remote-copied'
                    ? 'workbench.device_desktop_clipboard_copied'
                    : 'workbench.device_desktop_clipboard_synced'
                )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarButton
            testId="vnc-viewer-paste-button"
            label={t('workbench.device_desktop_paste')}
            onClick={() => void handleNativePaste()}
            disabled={status !== 'connected'}
          >
            <Clipboard className="h-4 w-4" aria-hidden="true" />
          </ToolbarButton>
          <ToolbarButton
            testId="vnc-viewer-fullscreen-button"
            label={
              fullscreen
                ? t('workbench.device_desktop_exit_fullscreen')
                : t('workbench.device_desktop_fullscreen')
            }
            onClick={handleToggleFullscreen}
          >
            {fullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </ToolbarButton>
          <ToolbarButton
            testId="vnc-viewer-disconnect-button"
            label={
              status === 'connecting' || status === 'connected'
                ? t('workbench.device_desktop_disconnect')
                : t('workbench.device_desktop_reconnect')
            }
            onClick={handleConnectionAction}
            disabled={status !== 'connecting' && status !== 'connected' && !onReconnectRequired}
          >
            {status === 'connecting' || status === 'connected' ? (
              <Power className="h-4 w-4" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
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
