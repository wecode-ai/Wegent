import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  EllipsisVertical,
  ExternalLink,
  Globe2,
  CircleAlert,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { cloudDesktopExtension } from '@extensions/cloud-desktop'
import { TransientNotice } from '@/components/common/TransientNotice'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ActionMenu } from '@/components/common/ActionMenu'
import {
  canUseEmbeddedBrowser,
  captureEmbeddedBrowserSnapshot,
  clearEmbeddedBrowserData,
  closeEmbeddedBrowser,
  consumeEmbeddedBrowserLabelTransfer,
  deleteEmbeddedBrowserDownload,
  clearEmbeddedBrowserAnnotations,
  listenEmbeddedBrowserAnnotationState,
  listenEmbeddedBrowserAgentState,
  listenEmbeddedBrowserAnnotationRequests,
  listenEmbeddedBrowserCloseRequests,
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
  EMBEDDED_BROWSER_OCCLUSION_EVENT,
  evalEmbeddedBrowserJson,
  goBackEmbeddedBrowser,
  goForwardEmbeddedBrowser,
  listenEmbeddedBrowserInvalidTlsCertificates,
  listenEmbeddedBrowserLocalFilePreview,
  listenEmbeddedBrowserPageStateChanges,
  isEmbeddedBrowserLabelTransferred,
  listenEmbeddedBrowserAgentCursor,
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  pauseEmbeddedBrowserDownload,
  readEmbeddedBrowserPageState,
  readEmbeddedBrowserAnnotationState,
  reloadEmbeddedBrowser,
  resumeEmbeddedBrowserDownload,
  resolveEmbeddedBrowserAgentApproval,
  setEmbeddedBrowserAgentControlPaused,
  setEmbeddedBrowserBounds,
  setEmbeddedBrowserDeviceMetrics,
  setEmbeddedBrowserZoom,
  setEmbeddedBrowserAnnotationOriginalView,
  startEmbeddedBrowserAnnotation,
  stopEmbeddedBrowserAnnotation,
  type EmbeddedBrowserAgentStateEvent,
  type EmbeddedBrowserAnnotationRequest,
  type EmbeddedBrowserAgentCursorEvent,
  type EmbeddedBrowserDataKind,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserDownloadEvent,
  type EmbeddedBrowserInvalidTlsCertificateEvent,
  type EmbeddedBrowserNavigationError,
  type EmbeddedBrowserOcclusionChange,
  type EmbeddedBrowserOpenRequest,
  type EmbeddedBrowserPageState,
} from '@/lib/embedded-browser'
import {
  readEmbeddedBrowserDownloadSnapshot,
  subscribeEmbeddedBrowserDownloadEvents,
} from '@/lib/embedded-browser-download-store'
import { openExternalUrl } from '@/lib/external-links'
import { fileManagerRevealLabel } from '@/lib/file-manager'
import { openLocalFile, revealLocalFile } from '@/lib/local-terminal'
import { normalizeBrowserUrl } from '@/lib/browser-url'
import { navigateTo } from '@/lib/navigation'
import { BROWSER_ZOOM_DEFAULT_PERCENT, zoomPercentToScaleFactor } from '@/lib/browser-zoom'
import {
  clampDeviceDimension,
  computeDeviceViewportPlacement,
  defaultBrowserDeviceToolbarState,
  matchDevicePresetId,
  resizeDeviceDimensions,
  resolveDevicePreset,
  BROWSER_DEVICE_MIN_HEIGHT,
  BROWSER_DEVICE_MIN_WIDTH,
  type BrowserDeviceResizeEdge,
  type BrowserDeviceToolbarState,
} from '@/lib/browser-device-toolbar'
import {
  clearEmbeddedBrowserFind,
  searchEmbeddedBrowserPage,
  stepEmbeddedBrowserFind,
  type BrowserFindState,
} from './browser-find/browser-find-store'
import { BrowserFindBar } from './browser-find/BrowserFindBar'
import { BrowserDeviceToolbar } from './BrowserDeviceToolbar'
import {
  embeddedBrowserOverlayMutationAffectsVisibility,
  hasEmbeddedBrowserOverlayConflict,
} from '@/lib/embedded-browser-overlay'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeCommentContext } from '@/types/workspace-files'
import type {
  BrowserAnnotationComment,
  BrowserAnnotationScope,
  BrowserAnnotationState,
} from '@/types/browser-annotation'
import { track } from '@/telemetry/client'
import type { BrowserAnnotationCommand } from '@/types/browser-annotation'
import { browserAnnotationStateToContexts } from '@/lib/browser-annotation-context'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { ElectronEmbeddedBrowserView } from './ElectronEmbeddedBrowserView'

const EMBEDDED_BROWSER_STATE_INTERVAL_MS = 1000
const EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS = 80
const EMBEDDED_BROWSER_VISIBLE_HOST_TIMEOUT_MS = 12_000
const EMBEDDED_BROWSER_VISIBLE_HOST_INTERVAL_MS = 50
const EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS = [0, 120, 300, 600]
const BROWSER_CLEAR_STARTED_NOTICE_MIN_MS = 600
const DOWNLOAD_PEEK_DURATION_MS = 8000
const BROWSER_ANNOTATION_LOG_PREFIX = '[Wework][BrowserAnnotation]'

interface BrowserOcclusionState {
  documentOverlayOccluded: boolean
  generation: number
  overlayIds: Set<string>
}

interface AnnotationEntry {
  mode?: EmbeddedBrowserAnnotationRequest['mode']
  point?: { x: number; y: number }
}

type BrowserOcclusionAction =
  | { id: string; occluded: boolean; type: 'overlay' }
  | { occluded: boolean; type: 'document' }

function isBrowserOccluded(state: BrowserOcclusionState): boolean {
  return state.overlayIds.size > 0 || state.documentOverlayOccluded
}

function browserOcclusionReducer(
  state: BrowserOcclusionState,
  action: BrowserOcclusionAction
): BrowserOcclusionState {
  const next =
    action.type === 'overlay'
      ? (() => {
          const overlayIds = new Set(state.overlayIds)
          if (action.occluded) {
            overlayIds.add(action.id)
          } else {
            overlayIds.delete(action.id)
          }
          return { ...state, overlayIds }
        })()
      : { ...state, documentOverlayOccluded: action.occluded }

  if (
    next.documentOverlayOccluded === state.documentOverlayOccluded &&
    next.overlayIds.size === state.overlayIds.size &&
    [...next.overlayIds].every(id => state.overlayIds.has(id))
  ) {
    return state
  }
  return {
    ...next,
    generation:
      !isBrowserOccluded(state) && isBrowserOccluded(next)
        ? state.generation + 1
        : state.generation,
  }
}

export interface WorkspaceBrowserPanelProps {
  active: boolean
  hideToolbar?: boolean
  label?: string
  transferFromLabel?: string
  transferredNativeLabel?: string | null
  transferredUrl?: string | null
  browserTabId?: string
  openRequest?: EmbeddedBrowserOpenRequest | null
  codeCommentCount?: number
  codeCommentContexts?: CodeCommentContext[]
  browserAnnotationCommand?: BrowserAnnotationCommand | null
  onAddCodeComment?: (context: CodeCommentContext) => void
  onReplaceBrowserCodeComments?: (
    scope: BrowserAnnotationScope,
    contexts: CodeCommentContext[]
  ) => void
  onRemoveBrowserCodeComments?: (scope: BrowserAnnotationScope) => void
  onNativeLabelChange?: (nativeLabel: string | null) => void
  onDownloadActivityChange?: (hasActiveDownload: boolean) => void
  onFaviconChange?: (faviconUrl: string | null) => void
  onLoadingChange?: (isLoading: boolean) => void
  onTitleChange?: (title: string | null) => void
  onAgentActiveChange?: (agentActive: boolean) => void
  onUrlChange?: (url: string | null) => void
}

export const WorkspaceBrowserPanel = WorkspaceBrowserTabPanel

type BrowserStatus = 'idle' | 'loading' | 'ready' | 'error'
type BrowserDownload = EmbeddedBrowserDownloadEvent
type BrowserAgentState = EmbeddedBrowserAgentStateEvent
type BrowserAgentCursor = EmbeddedBrowserAgentCursorEvent
type BrowserOpenDiagnosticStage =
  | 'request_consumed'
  | 'host_ready'
  | 'host_waiting'
  | 'host_visible'
  | 'native_open_started'
  | 'native_open_succeeded'
  | 'native_open_failed'
  | 'lifecycle_cancelled'
function logBrowserAnnotation(message: string, data?: Record<string, unknown>) {
  console.info(BROWSER_ANNOTATION_LOG_PREFIX, message, data ?? {})
}

function getFallbackBrowserTitle(url: string) {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol === 'file:') {
      const pathname = decodeURIComponent(parsedUrl.pathname)
      const normalizedPath = pathname.replace(/\/+$/, '')
      if (parsedUrl.pathname.endsWith('/')) {
        return `Index of ${normalizedPath || '/'}`
      }
      return normalizedPath.split('/').filter(Boolean).pop() || normalizedPath || url
    }
    return parsedUrl.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

function getFallbackFaviconUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol === 'file:') return null
    return new URL('/favicon.ico', parsedUrl).toString()
  } catch {
    return null
  }
}

function haveSameOrigin(leftUrl: string, rightUrl: string) {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin
  } catch {
    return false
  }
}

function formatDownloadBytes(bytes: number | null) {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function shouldShowAgentState(state: BrowserAgentState | null) {
  return Boolean(state && ['paused', 'needs_user', 'error'].includes(state.status))
}

function getElementBounds(element: HTMLElement): EmbeddedBrowserBounds | null {
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

async function waitForVisibleBrowserHost(
  getElement: () => HTMLElement | null,
  isAbandoned: () => boolean,
  isActive: () => boolean,
  onPending: (detail: Record<string, unknown>) => void
): Promise<EmbeddedBrowserBounds | null> {
  const startedAt = Date.now()
  let lastDiagnosticAt = 0
  while (!isAbandoned()) {
    if (!isActive()) return null
    const element = getElement()
    const bounds = element ? getElementBounds(element) : null
    if (bounds) return bounds
    const now = Date.now()
    if (now - lastDiagnosticAt >= 1_000) {
      const pane = element?.closest<HTMLElement>('[data-active-workbench-pane]')
      const rect = element?.getBoundingClientRect()
      onPending({
        elapsedMs: now - startedAt,
        hostConnected: element?.isConnected ?? false,
        hostExists: Boolean(element),
        hostRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        paneActive: pane?.dataset.activeWorkbenchPane ?? null,
        paneHidden: pane?.hidden ?? null,
      })
      lastDiagnosticAt = now
    }
    if (now - startedAt >= EMBEDDED_BROWSER_VISIBLE_HOST_TIMEOUT_MS) {
      throw new Error('Timed out waiting to show the embedded browser')
    }
    await new Promise<void>(resolve =>
      window.setTimeout(resolve, EMBEDDED_BROWSER_VISIBLE_HOST_INTERVAL_MS)
    )
  }
  throw new Error('Embedded browser open was cancelled')
}

function browserOpenErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function logBrowserOpenDiagnostic(
  stage: BrowserOpenDiagnosticStage,
  detail: Record<string, unknown>
) {
  console.info('[Wework] Embedded browser open diagnostic', JSON.stringify({ stage, ...detail }))
}

function observeElementIfPresent(observer: ResizeObserver, element: Element | null) {
  if (element) observer.observe(element)
}

export function WorkspaceBrowserTabPanel({
  active,
  hideToolbar = false,
  label = 'workspace-browser',
  transferFromLabel,
  transferredNativeLabel,
  transferredUrl,
  browserTabId = label,
  openRequest,
  codeCommentCount = 0,
  codeCommentContexts = [],
  browserAnnotationCommand,
  onAddCodeComment,
  onReplaceBrowserCodeComments,
  onRemoveBrowserCodeComments,
  onNativeLabelChange,
  onDownloadActivityChange,
  onFaviconChange,
  onLoadingChange,
  onTitleChange,
  onAgentActiveChange,
  onUrlChange,
}: WorkspaceBrowserPanelProps) {
  const { t } = useTranslation('common')
  const electronRuntime = isElectronRuntime()
  const browserPanelRef = useRef<HTMLDivElement | null>(null)
  const browserHostRef = useRef<HTMLDivElement | null>(null)
  const initialTransferredUrl = transferFromLabel ? (transferredUrl ?? null) : null
  const nativeBrowserOpenRef = useRef(Boolean(initialTransferredUrl))
  const nativeBrowserOpeningRef = useRef(false)
  const currentUrlRef = useRef<string | null>(initialTransferredUrl)
  const pendingNavigationUrlRef = useRef<string | null>(null)
  const activePageUrlRef = useRef<string | null>(initialTransferredUrl)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const addressEditingRef = useRef(false)
  const annotationModeRef = useRef(false)
  const currentLabelRef = useRef(label)
  const activeRef = useRef(active)
  const nativeLabelRef = useRef<string | null>(
    initialTransferredUrl ? (transferredNativeLabel ?? null) : null
  )
  const adoptedDownloadOwnerLabelRef = useRef<string | null>(
    initialTransferredUrl && transferredNativeLabel ? label : null
  )
  const trackedTerminalDownloadIdsRef = useRef(new Set<string>())
  const activeDownloadIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  const pageStateRequestGenerationRef = useRef(0)
  const lastAnnotationCommandSequenceRef = useRef(0)
  const handledOpenRequestIdRef = useRef<string | null>(null)
  const activeOpenRequestIdRef = useRef<string | null>(null)
  const syncBoundsTimerRef = useRef<number | null>(null)
  const syncBoundsAnimationFrameRef = useRef<number | null>(null)
  const postOpenSyncTimerRefs = useRef<number[]>([])
  const [browserOcclusion, dispatchBrowserOcclusion] = useReducer(browserOcclusionReducer, {
    documentOverlayOccluded: false,
    generation: 0,
    overlayIds: new Set<string>(),
  })
  const [occlusionSnapshot, setOcclusionSnapshot] = useState<{
    generation: number
    url: string
  } | null>(null)
  const [occlusionCaptureRetry, setOcclusionCaptureRetry] = useState(0)
  const occlusionSnapshotInFlightRef = useRef(false)
  const occlusionSnapshotGenerationRef = useRef(0)
  const occlusionSnapshotReadyRef = useRef(true)
  const occlusionSnapshotFallbackTimerRef = useRef<number | null>(null)
  const embeddedBrowserOccludedRef = useRef(false)
  const [address, setAddress] = useState(initialTransferredUrl ?? '')
  const [currentUrl, setCurrentUrl] = useState<string | null>(initialTransferredUrl)
  const [browserOpenAttempt, setBrowserOpenAttempt] = useState(0)
  const [pageUrl, setPageUrl] = useState<string | null>(initialTransferredUrl)
  const [status, setStatus] = useState<BrowserStatus>(initialTransferredUrl ? 'ready' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [navigationError, setNavigationError] = useState<EmbeddedBrowserNavigationError | null>(
    null
  )
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<BrowserAnnotationComment[]>([])
  const [annotationRevision, setAnnotationRevision] = useState(0)
  const [annotationRuntimeRevision, setAnnotationRuntimeRevision] = useState(0)
  const [annotationOriginalView, setAnnotationOriginalView] = useState(false)
  const annotationStateVersionRef = useRef<{
    pageSessionId: string | null
    revision: number
    runtimeRevision: number
  }>({ pageSessionId: null, revision: -1, runtimeRevision: -1 })
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false)
  const [discardingAnnotations, setDiscardingAnnotations] = useState(false)
  const [originalViewHeld, setOriginalViewHeld] = useState(false)
  const [downloads, setDownloads] = useState<BrowserDownload[]>([])
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [downloadPeek, setDownloadPeek] = useState<{
    id: string
    fileName: string
    path: string | null
    status: 'finished' | 'failed'
  } | null>(null)

  useEffect(() => {
    if (!downloadPeek) return
    const timer = window.setTimeout(() => setDownloadPeek(null), DOWNLOAD_PEEK_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [downloadPeek])
  const [localFilePreviewToast, setLocalFilePreviewToast] = useState<{
    id: number
    message: string
  } | null>(null)
  const [clearDataNotice, setClearDataNotice] = useState<{
    id: number
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const [clearingDataKind, setClearingDataKind] = useState<EmbeddedBrowserDataKind | null>(null)
  const [agentState, setAgentState] = useState<BrowserAgentState | null>(null)
  const [agentCursor, setAgentCursor] = useState<BrowserAgentCursor | null>(null)
  const [invalidTlsCertificate, setInvalidTlsCertificate] =
    useState<EmbeddedBrowserInvalidTlsCertificateEvent | null>(null)
  const deviceFitScaleRef = useRef(1)
  const browserBoundsSyncGenerationRef = useRef(0)
  const [zoomPercent, setZoomPercent] = useState(BROWSER_ZOOM_DEFAULT_PERCENT)
  const zoomPercentRef = useRef(BROWSER_ZOOM_DEFAULT_PERCENT)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<BrowserFindState | null>(null)
  const [findUnavailable, setFindUnavailable] = useState(false)
  const findRequestSequenceRef = useRef(0)
  const findPageUrlRef = useRef<string | null>(null)
  const [deviceToolbar, setDeviceToolbar] = useState<BrowserDeviceToolbarState>(
    defaultBrowserDeviceToolbarState
  )
  const deviceToolbarRef = useRef(deviceToolbar)
  const [deviceVisualRect, setDeviceVisualRect] = useState<{
    x: number
    y: number
    width: number
    height: number
    hostWidth: number
    hostHeight: number
  } | null>(null)
  const embeddedBrowserAvailable = canUseEmbeddedBrowser()
  const activePageUrl = pageUrl ?? currentUrl
  const internalDesktopPage = Boolean(
    activePageUrl && cloudDesktopExtension.isInternalPageUrl(activePageUrl)
  )
  const embeddedBrowserOccluded =
    browserOcclusion.overlayIds.size > 0 ||
    (active && Boolean(currentUrl) && browserOcclusion.documentOverlayOccluded)
  const pendingCommentContextCount = Math.max(codeCommentCount, codeCommentContexts.length)
  const hasQueuedTweaks = annotations.some(annotation => annotation.designChanges.length > 0)
  const originalViewEnabled = annotationMode && hasQueuedTweaks && originalViewHeld

  useEffect(() => {
    onLoadingChange?.(status === 'loading')
  }, [onLoadingChange, status])

  const applyNativePageStatus = useCallback(
    (pageState: {
      isLoading: boolean
      navigationError?: EmbeddedBrowserNavigationError | null
    }) => {
      const nextNavigationError = pageState.navigationError ?? null
      setNavigationError(nextNavigationError)
      setStatus(nextNavigationError ? 'error' : pageState.isLoading ? 'loading' : 'ready')
    },
    []
  )

  const applyDownloadEvent = useCallback((download: EmbeddedBrowserDownloadEvent) => {
    setDownloads(current => {
      const remaining = current.filter(item => item.id !== download.id)
      if (download.status === 'deleted') return remaining
      return [download, ...remaining].slice(0, 10)
    })
    // Codex-style interaction: the downloads list never opens itself. A
    // transient peek card surfaces completion or failure and dismisses itself.
    if (download.status === 'finished' || download.status === 'failed') {
      setDownloadPeek({
        id: `${download.id}-${Date.now()}`,
        fileName: download.path?.split(/[\\/]/).pop() || download.url,
        path: download.path,
        status: download.status,
      })
    }
  }, [])

  const reconcileDownloadSnapshot = useCallback(
    (nativeLabel: string) => {
      const snapshot = readEmbeddedBrowserDownloadSnapshot(nativeLabel).slice(0, 10)
      setDownloads(snapshot)
      activeDownloadIdsRef.current = new Set(
        snapshot
          .filter(download => download.status === 'started' || download.status === 'progress')
          .map(download => download.id)
      )
      onDownloadActivityChange?.(activeDownloadIdsRef.current.size > 0)
    },
    [onDownloadActivityChange]
  )

  const adoptNativeLabel = useCallback(
    (nativeLabel: string, logicalLabel: string) => {
      if (
        nativeLabelRef.current === nativeLabel &&
        adoptedDownloadOwnerLabelRef.current === logicalLabel
      ) {
        return
      }

      nativeLabelRef.current = nativeLabel
      adoptedDownloadOwnerLabelRef.current = logicalLabel
      onNativeLabelChange?.(nativeLabel)
      reconcileDownloadSnapshot(nativeLabel)
    },
    [onNativeLabelChange, reconcileDownloadSnapshot]
  )

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pageStateRequestGenerationRef.current += 1
      if (occlusionSnapshotFallbackTimerRef.current !== null) {
        window.clearTimeout(occlusionSnapshotFallbackTimerRef.current)
        occlusionSnapshotFallbackTimerRef.current = null
      }
    }
  }, [])

  useLayoutEffect(() => {
    currentLabelRef.current = label
    activeRef.current = active
    pageStateRequestGenerationRef.current += 1
  }, [active, label])

  useEffect(() => {
    return subscribeEmbeddedBrowserDownloadEvents(download => {
      if (download.nativeLabel !== nativeLabelRef.current) return
      if (download.status === 'started' || download.status === 'progress') {
        activeDownloadIdsRef.current.add(download.id)
      } else {
        activeDownloadIdsRef.current.delete(download.id)
      }
      onDownloadActivityChange?.(activeDownloadIdsRef.current.size > 0)
      if (activeRef.current) {
        applyDownloadEvent(download)
      }
      if (
        (download.status === 'finished' ||
          download.status === 'failed' ||
          download.status === 'deleted') &&
        !trackedTerminalDownloadIdsRef.current.has(download.id)
      ) {
        trackedTerminalDownloadIdsRef.current.add(download.id)
        track('browser_download_completed', {
          result:
            download.status === 'finished'
              ? 'success'
              : download.status === 'failed'
                ? 'failure'
                : 'cancelled',
        })
      }
    })
  }, [applyDownloadEvent, onDownloadActivityChange])

  useEffect(() => {
    const listener = listenEmbeddedBrowserAgentState(event => {
      if (event.label !== currentLabelRef.current) return
      setAgentState(event)
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener
      .then(nextUnlisten => {
        if (disposed) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to listen for embedded browser agent state:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const listener = listenEmbeddedBrowserAgentCursor(event => {
      if (event.label !== currentLabelRef.current) return
      setAgentCursor(event)
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener
      .then(nextUnlisten => {
        if (disposed) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to listen for embedded browser agent cursor:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    onAgentActiveChange?.(agentState?.status === 'running' || Boolean(agentCursor?.visible))
  }, [agentCursor?.visible, agentState?.status, onAgentActiveChange])

  useEffect(
    () => () => {
      onAgentActiveChange?.(false)
    },
    [onAgentActiveChange]
  )

  useEffect(() => {
    const listener = listenEmbeddedBrowserInvalidTlsCertificates(certificate => {
      if (!activeRef.current || certificate.nativeLabel !== nativeLabelRef.current) return
      setInvalidTlsCertificate(certificate)
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener.then(nextUnlisten => {
      if (disposed) {
        nextUnlisten()
        return
      }
      unlisten = nextUnlisten
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const listener = listenEmbeddedBrowserLocalFilePreview(event => {
      if (!activeRef.current || event.nativeLabel !== nativeLabelRef.current) return
      setLocalFilePreviewToast({
        id: Date.now(),
        message: t('workbench.browser_local_file_notice'),
      })
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener.then(nextUnlisten => {
      if (disposed) {
        nextUnlisten()
        return
      }
      unlisten = nextUnlisten
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [t])

  useEffect(() => {
    const listener = listenEmbeddedBrowserCloseRequests(event => {
      if (!activeRef.current || event.label !== currentLabelRef.current) return
      if (event.nativeLabel !== nativeLabelRef.current) {
        console.info(
          '[Wework] Embedded browser close ignored',
          JSON.stringify({
            currentNativeLabel: nativeLabelRef.current,
            eventNativeLabel: event.nativeLabel,
            label: event.label,
          })
        )
        return
      }
      console.info(
        '[Wework] Embedded browser close consumed',
        JSON.stringify({ label: event.label, nativeLabel: event.nativeLabel })
      )
      nativeBrowserOpenRef.current = false
      nativeLabelRef.current = null
      adoptedDownloadOwnerLabelRef.current = null
      activeDownloadIdsRef.current = new Set()
      onNativeLabelChange?.(null)
      onDownloadActivityChange?.(false)
      currentUrlRef.current = null
      pendingNavigationUrlRef.current = null
      activePageUrlRef.current = null
      annotationModeRef.current = false
      pageStateRequestGenerationRef.current += 1
      setCurrentUrl(null)
      setPageUrl(null)
      setAddress('')
      onUrlChange?.(null)
      setStatus('ready')
      setError(null)
      setInvalidTlsCertificate(null)
      setAnnotationMode(false)
      setOriginalViewHeld(false)
      setAnnotations([])
      setDownloads([])
      setDownloadsOpen(false)
      setLocalFilePreviewToast(null)
      setClearDataNotice(null)
      setClearingDataKind(null)
      setAgentState(null)
      setAgentCursor(null)
      onTitleChange?.(null)
      onFaviconChange?.(null)
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener
      .then(nextUnlisten => {
        if (disposed) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to listen for embedded browser close requests:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [onDownloadActivityChange, onFaviconChange, onNativeLabelChange, onTitleChange, onUrlChange])

  useEffect(() => {
    if (!active || !nativeLabelRef.current) return
    reconcileDownloadSnapshot(nativeLabelRef.current)
  }, [active, reconcileDownloadSnapshot])

  const updatePageUrl = useCallback(
    (url: string | null) => {
      const pendingNavigationUrl = pendingNavigationUrlRef.current
      if (pendingNavigationUrl && url && url !== pendingNavigationUrl) return
      activePageUrlRef.current = url
      setPageUrl(url)
      onUrlChange?.(url)
      if (url) {
        if (!addressEditingRef.current && document.activeElement !== addressInputRef.current) {
          setAddress(url)
        }
        onTitleChange?.(getFallbackBrowserTitle(url))
        onFaviconChange?.(getFallbackFaviconUrl(url))
        return
      }

      onTitleChange?.(null)
      onFaviconChange?.(null)
    },
    [onFaviconChange, onTitleChange, onUrlChange]
  )

  useEffect(() => {
    function applyPageState(pageState: EmbeddedBrowserPageState): void {
      if (pageState.label && pageState.label !== currentLabelRef.current) return
      if (nativeLabelRef.current && pageState.nativeLabel !== nativeLabelRef.current) return
      applyNativePageStatus(pageState)
      if (pageState.isLoading) return
      setInvalidTlsCertificate(pageState.invalidTlsCertificate ?? null)
      const nextUrl = pageState.url || currentUrlRef.current
      if (nextUrl && pendingNavigationUrlRef.current === nextUrl) {
        pendingNavigationUrlRef.current = null
      }
      updatePageUrl(nextUrl)
      if (nextUrl) {
        onTitleChange?.(pageState.title || getFallbackBrowserTitle(nextUrl))
        onFaviconChange?.(getFallbackFaviconUrl(nextUrl))
      }
    }

    const listener = listenEmbeddedBrowserPageStateChanges(pageState => {
      applyPageState(pageState)
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener
      .then(nextUnlisten => {
        if (disposed) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to listen for embedded browser page state changes:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [applyNativePageStatus, onFaviconChange, onTitleChange, updatePageUrl])

  const syncEmbeddedBrowserBounds = useCallback(
    async (visible = active) => {
      const generation = browserBoundsSyncGenerationRef.current + 1
      browserBoundsSyncGenerationRef.current = generation
      const isCurrent = () => browserBoundsSyncGenerationRef.current === generation
      if (
        !embeddedBrowserAvailable ||
        !nativeBrowserOpenRef.current ||
        isEmbeddedBrowserLabelTransferred(label)
      ) {
        return
      }
      const host = browserHostRef.current
      if (!host) {
        if (!visible && isCurrent()) {
          await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
        }
        return
      }
      const bounds = getElementBounds(host)
      if (!bounds) {
        if (!visible && isCurrent()) {
          await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
        }
        return
      }
      const nativeVisible =
        visible &&
        !navigationError &&
        (electronRuntime ||
          !embeddedBrowserOccludedRef.current ||
          !occlusionSnapshotReadyRef.current)
      const deviceState = deviceToolbarRef.current
      const placement = deviceState.isEnabled
        ? computeDeviceViewportPlacement(bounds, deviceState, zoomPercentRef.current)
        : null
      const nativeZoomScale = placement ? 1 : zoomPercentToScaleFactor(zoomPercentRef.current)
      if (placement) {
        deviceFitScaleRef.current = placement.fitScale
        const hostRect = host.getBoundingClientRect()
        const nextVisualRect = {
          x: placement.visualRect.x - hostRect.left,
          y: placement.visualRect.y - hostRect.top,
          width: placement.visualRect.width,
          height: placement.visualRect.height,
          hostWidth: hostRect.width,
          hostHeight: hostRect.height,
        }
        setDeviceVisualRect(current =>
          current &&
          current.x === nextVisualRect.x &&
          current.y === nextVisualRect.y &&
          current.width === nextVisualRect.width &&
          current.height === nextVisualRect.height &&
          current.hostWidth === nextVisualRect.hostWidth &&
          current.hostHeight === nextVisualRect.hostHeight
            ? current
            : nextVisualRect
        )
        if (!isCurrent()) return
        await setEmbeddedBrowserBounds(placement.webviewBounds, nativeVisible, label)
        if (!isCurrent()) return
      } else {
        deviceFitScaleRef.current = 1
        setDeviceVisualRect(current => (current === null ? current : null))
        if (!isCurrent()) return
        await setEmbeddedBrowserDeviceMetrics(null, label)
        if (!isCurrent()) return
        await setEmbeddedBrowserBounds(bounds, nativeVisible, label)
        if (!isCurrent()) return
      }
      // Regular pages use Electron zoom. Device mode keeps Electron zoom at 1
      // because setZoomFactor changes the emulated CSS viewport; CDP metrics
      // applies the combined fit and page zoom through its image scale instead.
      await setEmbeddedBrowserZoom(nativeZoomScale, label).catch(error => {
        console.error('Failed to apply embedded browser zoom:', error)
      })
      if (!isCurrent()) return
      // Electron applies zoom to the CSS viewport. Reassert device metrics
      // after zoom so window.innerWidth/innerHeight remain the selected preset.
      if (placement) {
        await setEmbeddedBrowserDeviceMetrics(
          {
            width: deviceState.width,
            height: deviceState.height,
            scale: placement.scale,
          },
          label
        )
      }
    },
    [active, electronRuntime, embeddedBrowserAvailable, label, navigationError]
  )

  const hideEmbeddedBrowser = useCallback(async () => {
    if (
      !embeddedBrowserAvailable ||
      !nativeBrowserOpenRef.current ||
      isEmbeddedBrowserLabelTransferred(label)
    ) {
      return
    }
    await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
  }, [embeddedBrowserAvailable, label])

  const exitAnnotationMode = useCallback(() => {
    logBrowserAnnotation('exit annotation mode', {
      label,
      currentUrl,
      pendingCommentContextCount,
      nativeBrowserOpen: nativeBrowserOpenRef.current,
    })
    annotationModeRef.current = false
    setAnnotationMode(false)
    setOriginalViewHeld(false)
    void stopEmbeddedBrowserAnnotation(label).catch(error => {
      console.error('Failed to stop embedded browser annotation:', error)
    })
  }, [currentUrl, label, pendingCommentContextCount])

  useEffect(() => {
    annotationStateVersionRef.current = {
      pageSessionId: null,
      revision: -1,
      runtimeRevision: -1,
    }
  }, [label])

  const applyAnnotationState = useCallback(
    (state: BrowserAnnotationState) => {
      if (state.label !== label) return false
      const incomingRuntimeRevision = state.runtimeRevision ?? 0
      const incomingPageSessionId = state.scope?.pageSessionId ?? null
      const currentVersion = annotationStateVersionRef.current
      const staleRuntime = incomingRuntimeRevision < currentVersion.runtimeRevision
      const staleRevision =
        incomingRuntimeRevision === currentVersion.runtimeRevision &&
        state.revision < currentVersion.revision
      const stalePageSession =
        incomingRuntimeRevision === currentVersion.runtimeRevision &&
        currentVersion.pageSessionId !== null &&
        incomingPageSessionId !== currentVersion.pageSessionId
      if (staleRuntime || staleRevision || stalePageSession) return false
      annotationStateVersionRef.current = {
        pageSessionId: incomingPageSessionId,
        revision: state.revision,
        runtimeRevision: incomingRuntimeRevision,
      }
      const activeMode = state.mode !== 'off'
      annotationModeRef.current = activeMode
      setAnnotationMode(activeMode)
      setAnnotations(state.comments)
      setAnnotationRevision(state.revision)
      setAnnotationRuntimeRevision(incomingRuntimeRevision)
      setAnnotationOriginalView(state.originalView)
      if (!state.scope) return true
      const scope = { ...state.scope, browserTabId }
      const normalizedState = { ...state, scope }
      const contexts = browserAnnotationStateToContexts(
        normalizedState,
        activePageUrlRef.current ? getFallbackBrowserTitle(activePageUrlRef.current) : null
      )
      if (onReplaceBrowserCodeComments) {
        onReplaceBrowserCodeComments(scope, contexts)
      } else {
        contexts.forEach(context => onAddCodeComment?.(context))
      }
      return true
    },
    [browserTabId, label, onAddCodeComment, onReplaceBrowserCodeComments]
  )

  const enterAnnotationMode = useCallback(
    async (request: AnnotationEntry = {}) => {
      const mode = request.mode ?? 'batch'
      logBrowserAnnotation('enter annotation mode requested', {
        label,
        active,
        currentUrl,
        mode,
        embeddedBrowserAvailable,
        nativeBrowserOpen: nativeBrowserOpenRef.current,
      })
      if (
        internalDesktopPage ||
        !embeddedBrowserAvailable ||
        !nativeBrowserOpenRef.current ||
        !currentUrl
      ) {
        logBrowserAnnotation('enter annotation mode skipped', {
          label,
          active,
          currentUrl,
          embeddedBrowserAvailable,
          nativeBrowserOpen: nativeBrowserOpenRef.current,
        })
        return
      }
      try {
        await startEmbeddedBrowserAnnotation(mode, label, request.point)
        const state = await readEmbeddedBrowserAnnotationState(label)
        if (!mountedRef.current || currentLabelRef.current !== label) return
        if (!applyAnnotationState(state)) return
        annotationModeRef.current = true
        setAnnotationMode(true)
        logBrowserAnnotation('enter annotation mode succeeded', { label, currentUrl })
      } catch (error) {
        console.error('Failed to enter embedded browser annotation mode:', error)
        logBrowserAnnotation('enter annotation mode failed', {
          label,
          currentUrl,
          error: error instanceof Error ? error.message : String(error),
        })
        setStatus('error')
        setError(t('workbench.browser_annotation_failed'))
      }
    },
    [
      active,
      applyAnnotationState,
      currentUrl,
      embeddedBrowserAvailable,
      internalDesktopPage,
      label,
      t,
    ]
  )

  useEffect(() => {
    const listener = listenEmbeddedBrowserAnnotationState(applyAnnotationState)
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener.then(nextUnlisten => {
      if (disposed) nextUnlisten()
      else unlisten = nextUnlisten
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [applyAnnotationState])

  useEffect(() => {
    const listener = listenEmbeddedBrowserAnnotationRequests(request => {
      if (
        !activeRef.current ||
        request.label !== currentLabelRef.current ||
        request.nativeLabel !== nativeLabelRef.current
      ) {
        return
      }
      void enterAnnotationMode({
        mode: request.mode,
        point: { x: request.x, y: request.y },
      })
    })
    if (!listener) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void listener
      .then(nextUnlisten => {
        if (disposed) {
          nextUnlisten()
          return
        }
        unlisten = nextUnlisten
      })
      .catch(error => {
        console.error('Failed to listen for embedded browser annotation requests:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enterAnnotationMode])

  useEffect(() => {
    if (
      !browserAnnotationCommand ||
      browserAnnotationCommand.sequence <= lastAnnotationCommandSequenceRef.current
    ) {
      return
    }
    lastAnnotationCommandSequenceRef.current = browserAnnotationCommand.sequence
    void clearEmbeddedBrowserAnnotations(label)
      .then(() => readEmbeddedBrowserAnnotationState(label))
      .then(state => {
        if (!applyAnnotationState(state)) return
        if (state.scope) {
          onRemoveBrowserCodeComments?.({ ...state.scope, browserTabId })
        }
      })
      .catch(error => {
        console.error('Failed to execute browser annotation cleanup command:', error)
      })
      .finally(exitAnnotationMode)
  }, [
    applyAnnotationState,
    browserAnnotationCommand,
    browserTabId,
    exitAnnotationMode,
    label,
    onRemoveBrowserCodeComments,
  ])

  const clearScheduledBoundsSync = useCallback(() => {
    if (syncBoundsAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(syncBoundsAnimationFrameRef.current)
      syncBoundsAnimationFrameRef.current = null
    }
    if (syncBoundsTimerRef.current !== null) {
      window.clearTimeout(syncBoundsTimerRef.current)
      syncBoundsTimerRef.current = null
    }
    postOpenSyncTimerRefs.current.forEach(timer => window.clearTimeout(timer))
    postOpenSyncTimerRefs.current = []
  }, [])

  const scheduleEmbeddedBrowserBoundsSync = useCallback(
    (visible = active) => {
      if (syncBoundsAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(syncBoundsAnimationFrameRef.current)
        syncBoundsAnimationFrameRef.current = null
      }
      if (syncBoundsTimerRef.current !== null) {
        window.clearTimeout(syncBoundsTimerRef.current)
        syncBoundsTimerRef.current = null
      }

      syncBoundsAnimationFrameRef.current = window.requestAnimationFrame(() => {
        syncBoundsAnimationFrameRef.current = null
        void syncEmbeddedBrowserBounds(visible).catch(error => {
          console.error('Failed to sync embedded browser bounds:', error)
        })
      })
      syncBoundsTimerRef.current = window.setTimeout(() => {
        syncBoundsTimerRef.current = null
        void syncEmbeddedBrowserBounds(visible).catch(error => {
          console.error('Failed to sync embedded browser bounds:', error)
        })
      }, EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS)
    },
    [active, syncEmbeddedBrowserBounds]
  )

  const schedulePostOpenBoundsSync = useCallback(
    (visible = active) => {
      EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS.forEach(delay => {
        const timer = window.setTimeout(() => {
          postOpenSyncTimerRefs.current = postOpenSyncTimerRefs.current.filter(
            pendingTimer => pendingTimer !== timer
          )
          scheduleEmbeddedBrowserBoundsSync(visible)
        }, delay)
        postOpenSyncTimerRefs.current.push(timer)
      })
    },
    [active, scheduleEmbeddedBrowserBoundsSync]
  )

  useEffect(() => clearScheduledBoundsSync, [clearScheduledBoundsSync])

  const refreshPageState = useCallback(async (): Promise<boolean> => {
    if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return false
    const requestGeneration = pageStateRequestGenerationRef.current + 1
    pageStateRequestGenerationRef.current = requestGeneration
    try {
      const pageState = await readEmbeddedBrowserPageState(label)
      if (!mountedRef.current || pageStateRequestGenerationRef.current !== requestGeneration) {
        return false
      }
      adoptNativeLabel(pageState.nativeLabel, label)
      applyNativePageStatus(pageState)
      setInvalidTlsCertificate(pageState.invalidTlsCertificate ?? null)
      const nextUrl = pageState.url || currentUrlRef.current
      if (
        nextUrl &&
        cloudDesktopExtension.isInternalPageUrl(nextUrl) &&
        annotationModeRef.current
      ) {
        logBrowserAnnotation('exit annotation mode for internal desktop page', { label })
        exitAnnotationMode()
      }
      if (!pageState.isLoading && nextUrl && pendingNavigationUrlRef.current === nextUrl) {
        pendingNavigationUrlRef.current = null
      }
      updatePageUrl(nextUrl)
      if (nextUrl) {
        onTitleChange?.(pageState.title || getFallbackBrowserTitle(nextUrl))
        onFaviconChange?.(getFallbackFaviconUrl(nextUrl))
      }
      return true
    } catch (error) {
      if (!mountedRef.current || pageStateRequestGenerationRef.current !== requestGeneration) {
        return false
      }
      console.error('Failed to read embedded browser page state:', error)
      return false
    }
  }, [
    embeddedBrowserAvailable,
    adoptNativeLabel,
    applyNativePageStatus,
    exitAnnotationMode,
    label,
    onFaviconChange,
    onTitleChange,
    updatePageUrl,
  ])

  useEffect(() => {
    currentUrlRef.current = currentUrl
  }, [currentUrl])

  useEffect(() => {
    if (!embeddedBrowserAvailable || !currentUrl) return
    if (nativeBrowserOpenRef.current) {
      schedulePostOpenBoundsSync(active)
      return
    }
    if (nativeBrowserOpeningRef.current) return

    const requestId = activeOpenRequestIdRef.current
    const openingLabel = label
    const openingUrl = currentUrl
    const nativeOpeningUrl = requestId ? 'about:blank' : openingUrl
    const isAbandoned = () => !mountedRef.current || currentLabelRef.current !== openingLabel
    nativeBrowserOpeningRef.current = true

    setStatus('loading')
    const revealHiddenBrowser = async (visible: boolean) => {
      if (visible || !active) return
      const visibleBounds = await waitForVisibleBrowserHost(
        () => browserHostRef.current,
        isAbandoned,
        () => activeRef.current,
        detail =>
          logBrowserOpenDiagnostic('host_waiting', {
            ...detail,
            label: openingLabel,
            requestId,
            url: openingUrl,
          })
      )
      if (visibleBounds) {
        await setEmbeddedBrowserBounds(visibleBounds, true, openingLabel)
        logBrowserOpenDiagnostic('host_visible', {
          bounds: visibleBounds,
          label: openingLabel,
          requestId,
          url: openingUrl,
        })
        return
      }
      await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, openingLabel, true)
    }
    const recoverBrowserFromPageState = async () => {
      const recoveryDelays = [0, 120, 300, 600]
      for (const delay of recoveryDelays) {
        if (delay > 0) {
          await new Promise<void>(resolve => window.setTimeout(resolve, delay))
        }
        try {
          const pageState = await readEmbeddedBrowserPageState(openingLabel)
          if (isAbandoned()) return true
          adoptNativeLabel(pageState.nativeLabel, openingLabel)
          setInvalidTlsCertificate(pageState.invalidTlsCertificate ?? null)
          nativeBrowserOpenRef.current = true
          updatePageUrl(pageState.url || openingUrl)
          pendingNavigationUrlRef.current = null
          schedulePostOpenBoundsSync(activeRef.current)
          applyNativePageStatus(pageState)
          return true
        } catch {
          // No existing browser state to recover yet.
        }
      }
      return false
    }
    const openWhenHostIsReady = async () => {
      console.info('[Wework][browser-open] nativeOpenStart', {
        label,
        currentUrl,
        active,
      })
      try {
        const host = browserHostRef.current
        const measuredBounds = active && host ? getElementBounds(host) : null
        const visible = measuredBounds !== null
        const bounds = measuredBounds ?? { x: 0, y: 0, width: 1, height: 1 }
        if (isAbandoned()) return

        logBrowserOpenDiagnostic('host_ready', {
          active,
          bounds,
          label: openingLabel,
          requestId,
          url: openingUrl,
          visible,
        })
        logBrowserOpenDiagnostic('native_open_started', {
          active,
          label: openingLabel,
          requestId,
          url: openingUrl,
          visible,
        })
        const pageState = visible
          ? requestId
            ? await openEmbeddedBrowser(nativeOpeningUrl, bounds, openingLabel, true, true, false)
            : await openEmbeddedBrowser(nativeOpeningUrl, bounds, openingLabel)
          : requestId
            ? await openEmbeddedBrowser(
                nativeOpeningUrl,
                bounds,
                openingLabel,
                false,
                !active,
                false
              )
            : await openEmbeddedBrowser(nativeOpeningUrl, bounds, openingLabel, false, !active)
        if (isAbandoned()) {
          await closeEmbeddedBrowser(openingLabel).catch(() => undefined)
          logBrowserOpenDiagnostic('lifecycle_cancelled', {
            active,
            label: openingLabel,
            requestId,
            url: openingUrl,
          })
          return
        }
        adoptNativeLabel(pageState.nativeLabel, openingLabel)
        setInvalidTlsCertificate(pageState.invalidTlsCertificate ?? null)
        nativeBrowserOpenRef.current = true
        if (activeOpenRequestIdRef.current === requestId) {
          activeOpenRequestIdRef.current = null
        }
        updatePageUrl(requestId ? openingUrl : pageState.url || openingUrl)
        if (!requestId) pendingNavigationUrlRef.current = null
        await revealHiddenBrowser(visible)
        schedulePostOpenBoundsSync(activeRef.current)
        applyNativePageStatus(pageState)
        logBrowserOpenDiagnostic('native_open_succeeded', {
          active,
          label: openingLabel,
          nativeLabel: pageState.nativeLabel,
          requestId,
          url: pageState.url || openingUrl,
        })
      } catch (error) {
        const message = browserOpenErrorMessage(error)
        const abandoned = isAbandoned()
        console.error(
          '[Wework] Embedded browser open failed',
          JSON.stringify({
            active,
            disposed: abandoned,
            error: message,
            label: openingLabel,
            requestId,
            url: openingUrl,
          })
        )
        logBrowserOpenDiagnostic('native_open_failed', {
          active,
          disposed: abandoned,
          error: message,
          label: openingLabel,
          requestId,
          url: openingUrl,
        })
        if (!abandoned) {
          if (await recoverBrowserFromPageState()) return
          setStatus('error')
          setError(t('workbench.browser_open_failed'))
        }
      } finally {
        nativeBrowserOpeningRef.current = false
      }
    }

    void openWhenHostIsReady()
  }, [
    active,
    adoptNativeLabel,
    applyNativePageStatus,
    browserOpenAttempt,
    currentUrl,
    embeddedBrowserAvailable,
    label,
    schedulePostOpenBoundsSync,
    t,
    updatePageUrl,
  ])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable || nativeBrowserOpenRef.current || currentUrl) return

    let disposed = false

    const attachExistingBrowser = async () => {
      try {
        const pageState = await readEmbeddedBrowserPageState(label)
        if (disposed) return
        adoptNativeLabel(pageState.nativeLabel, label)
        setInvalidTlsCertificate(pageState.invalidTlsCertificate ?? null)
        if (!pageState.url) return
        nativeBrowserOpenRef.current = true
        setCurrentUrl(pageState.url)
        updatePageUrl(pageState.url)
        pendingNavigationUrlRef.current = null
        if (pageState.title) {
          onTitleChange?.(pageState.title)
        }
        applyNativePageStatus(pageState)
        schedulePostOpenBoundsSync(active)
      } catch {
        // No existing native browser for this label.
      }
    }

    void attachExistingBrowser()

    return () => {
      disposed = true
    }
  }, [
    active,
    adoptNativeLabel,
    applyNativePageStatus,
    currentUrl,
    embeddedBrowserAvailable,
    label,
    onTitleChange,
    schedulePostOpenBoundsSync,
    updatePageUrl,
  ])

  useEffect(() => {
    if (!embeddedBrowserAvailable) return

    if (!active) {
      void hideEmbeddedBrowser().catch(error => {
        console.error('Failed to hide embedded browser:', error)
      })
      return
    }

    scheduleEmbeddedBrowserBoundsSync(active)
  }, [active, embeddedBrowserAvailable, hideEmbeddedBrowser, scheduleEmbeddedBrowserBoundsSync])

  useEffect(() => {
    if (!embeddedBrowserAvailable) return

    const handlePageHide = () => {
      setOriginalViewHeld(false)
      void hideEmbeddedBrowser().catch(error => {
        console.error('Failed to hide embedded browser before page unload:', error)
      })
    }
    const handlePageShow = () => {
      if (activeRef.current) scheduleEmbeddedBrowserBoundsSync(true)
    }

    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('pageshow', handlePageShow)
    return () => {
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('pageshow', handlePageShow)
    }
  }, [embeddedBrowserAvailable, hideEmbeddedBrowser, scheduleEmbeddedBrowserBoundsSync])

  useEffect(() => {
    const resetOriginalView = () => setOriginalViewHeld(false)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') resetOriginalView()
    }
    const animationFrame = !active ? window.requestAnimationFrame(resetOriginalView) : null
    window.addEventListener('blur', resetOriginalView)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('blur', resetOriginalView)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [active])

  useEffect(() => {
    if (hasQueuedTweaks || !originalViewHeld) return
    const animationFrame = window.requestAnimationFrame(() => setOriginalViewHeld(false))
    return () => window.cancelAnimationFrame(animationFrame)
  }, [hasQueuedTweaks, originalViewHeld])

  useEffect(() => {
    if (!embeddedBrowserAvailable || !currentUrl) return
    const host = browserHostRef.current
    if (!host) return

    const handleBoundsChange = () => scheduleEmbeddedBrowserBoundsSync(active)
    const observer = new ResizeObserver(handleBoundsChange)
    observeElementIfPresent(observer, host)
    observeElementIfPresent(observer, host.parentElement)
    observeElementIfPresent(observer, document.documentElement)
    window.addEventListener('resize', handleBoundsChange)
    window.visualViewport?.addEventListener('resize', handleBoundsChange)
    schedulePostOpenBoundsSync(active)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleBoundsChange)
      window.visualViewport?.removeEventListener('resize', handleBoundsChange)
      clearScheduledBoundsSync()
    }
  }, [
    active,
    clearScheduledBoundsSync,
    currentUrl,
    embeddedBrowserAvailable,
    scheduleEmbeddedBrowserBoundsSync,
    schedulePostOpenBoundsSync,
  ])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return

    const intervalId = window.setInterval(() => {
      void refreshPageState()
    }, EMBEDDED_BROWSER_STATE_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [active, embeddedBrowserAvailable, refreshPageState, status])

  const holdOriginalView = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isTrusted) {
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        // The native pointer may already have been released.
      }
    }
    setOriginalViewHeld(true)
  }, [])
  const releaseOriginalView = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The pointer may already have been released by the native host.
    }
    setOriginalViewHeld(false)
  }, [])
  const cancelOriginalView = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The pointer may already have been released by the native host.
    }
    setOriginalViewHeld(false)
  }, [])
  const blurOriginalView = useCallback(() => {
    setOriginalViewHeld(false)
  }, [])
  const handleOriginalViewKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return
    event.preventDefault()
    setOriginalViewHeld(true)
  }, [])
  const handleOriginalViewKeyUp = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    setOriginalViewHeld(false)
  }, [])

  useEffect(() => {
    if (!annotationMode) return
    void setEmbeddedBrowserAnnotationOriginalView(originalViewEnabled, label).catch(error => {
      console.error('Failed to update embedded browser original view state:', error)
    })
  }, [annotationMode, label, originalViewEnabled])

  useEffect(() => {
    return () => {
      // Do NOT close the native embedded browser here. React StrictMode double-invokes
      // effects in development (mount -> unmount -> remount), so this cleanup runs once
      // for a "fake" unmount immediately before the real mount. Closing the native
      // webview here tears down the very browser the remounted panel is about to open,
      // which resets the panel back to the empty start page (blank address bar).
      // The native browser lifecycle is owned by the explicit close-tab action
      // (closeRightPanelTab -> closeEmbeddedBrowsers), not by component unmount.
      // Here we only clear local references so a remount re-adopts the existing browser.
      nativeBrowserOpenRef.current = false
      if (consumeEmbeddedBrowserLabelTransfer(label)) return
      nativeLabelRef.current = null
      adoptedDownloadOwnerLabelRef.current = null
    }
  }, [label])

  useEffect(() => {
    const handleDebugPanelVisibility = (event: Event) => {
      const expanded = Boolean((event as CustomEvent<{ expanded?: boolean }>).detail?.expanded)
      if (!activeRef.current && expanded) return
      dispatchBrowserOcclusion({
        id: 'debug-panel',
        occluded: expanded,
        type: 'overlay',
      })
    }

    const handleBrowserOcclusion = (event: Event) => {
      const detail = (event as CustomEvent<EmbeddedBrowserOcclusionChange>).detail
      if (!detail?.id) return
      if (!activeRef.current && detail.occluded) return

      dispatchBrowserOcclusion({
        id: detail.id,
        occluded: detail.occluded,
        type: 'overlay',
      })
    }

    window.addEventListener(
      EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
      handleDebugPanelVisibility
    )
    window.addEventListener(EMBEDDED_BROWSER_OCCLUSION_EVENT, handleBrowserOcclusion)
    return () => {
      window.removeEventListener(
        EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
        handleDebugPanelVisibility
      )
      window.removeEventListener(EMBEDDED_BROWSER_OCCLUSION_EVENT, handleBrowserOcclusion)
    }
  }, [label])

  useEffect(() => {
    if (active) return

    const animationFrame = window.requestAnimationFrame(() => {
      setOcclusionSnapshot(null)
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [active])

  useEffect(() => {
    if (embeddedBrowserOccluded) return undefined

    const animationFrame = window.requestAnimationFrame(() => {
      setOcclusionSnapshot(null)
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [embeddedBrowserOccluded])

  useEffect(() => {
    if (!active || !embeddedBrowserAvailable || !currentUrl) return

    let animationFrame: number | null = null
    const updateOverlayOcclusion = () => {
      animationFrame = null
      const host = browserHostRef.current
      const occluded = Boolean(host && hasEmbeddedBrowserOverlayConflict(host))
      dispatchBrowserOcclusion({ occluded, type: 'document' })
    }
    const scheduleOverlayOcclusionUpdate = () => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(updateOverlayOcclusion)
    }

    const observer = new MutationObserver(mutations => {
      if (embeddedBrowserOverlayMutationAffectsVisibility(mutations)) {
        scheduleOverlayOcclusionUpdate()
      }
    })
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        'aria-hidden',
        'aria-modal',
        'class',
        'data-embedded-browser-occlusion',
        'hidden',
        'role',
        'style',
      ],
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', scheduleOverlayOcclusionUpdate)
    window.addEventListener('scroll', scheduleOverlayOcclusionUpdate, true)
    document.addEventListener('pointerover', scheduleOverlayOcclusionUpdate, true)
    document.addEventListener('pointerout', scheduleOverlayOcclusionUpdate, true)
    document.addEventListener('focusin', scheduleOverlayOcclusionUpdate, true)
    document.addEventListener('focusout', scheduleOverlayOcclusionUpdate, true)
    scheduleOverlayOcclusionUpdate()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleOverlayOcclusionUpdate)
      window.removeEventListener('scroll', scheduleOverlayOcclusionUpdate, true)
      document.removeEventListener('pointerover', scheduleOverlayOcclusionUpdate, true)
      document.removeEventListener('pointerout', scheduleOverlayOcclusionUpdate, true)
      document.removeEventListener('focusin', scheduleOverlayOcclusionUpdate, true)
      document.removeEventListener('focusout', scheduleOverlayOcclusionUpdate, true)
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [active, currentUrl, embeddedBrowserAvailable])

  useLayoutEffect(() => {
    embeddedBrowserOccludedRef.current = embeddedBrowserOccluded
    occlusionSnapshotGenerationRef.current = browserOcclusion.generation
    occlusionSnapshotReadyRef.current = electronRuntime || !embeddedBrowserOccluded
  }, [browserOcclusion.generation, electronRuntime, embeddedBrowserOccluded])

  const syncOcclusionState = useCallback(
    async (generation: number) => {
      if (!mountedRef.current) return
      if (electronRuntime) {
        await syncEmbeddedBrowserBounds(active)
        return
      }
      if (!activeRef.current || !embeddedBrowserOccludedRef.current) {
        await syncEmbeddedBrowserBounds(active)
        return
      }
      if (occlusionSnapshotInFlightRef.current || !nativeBrowserOpenRef.current) return

      occlusionSnapshotInFlightRef.current = true
      try {
        const fallbackTimeoutId = window.setTimeout(() => {
          if (
            mountedRef.current &&
            activeRef.current &&
            embeddedBrowserOccludedRef.current &&
            generation === occlusionSnapshotGenerationRef.current
          ) {
            // A stuck native capture must not prevent the menu from becoming usable.
            occlusionSnapshotReadyRef.current = true
            void syncEmbeddedBrowserBounds(active)
          }
        }, 2000)
        occlusionSnapshotFallbackTimerRef.current = fallbackTimeoutId
        const snapshotUrl = await captureEmbeddedBrowserSnapshot(label)
        if (
          mountedRef.current &&
          activeRef.current &&
          embeddedBrowserOccludedRef.current &&
          generation === occlusionSnapshotGenerationRef.current
        ) {
          setOcclusionSnapshot({ generation, url: snapshotUrl })
        }
      } catch (error) {
        console.error('Failed to capture embedded browser occlusion snapshot:', error)
        if (
          mountedRef.current &&
          embeddedBrowserOccludedRef.current &&
          generation === occlusionSnapshotGenerationRef.current
        ) {
          // Keep menus usable if snapshot capture fails, even though the native
          // browser cannot be visually preserved for this interaction.
          occlusionSnapshotReadyRef.current = true
          await syncEmbeddedBrowserBounds(active)
        }
      } finally {
        if (occlusionSnapshotFallbackTimerRef.current !== null) {
          window.clearTimeout(occlusionSnapshotFallbackTimerRef.current)
          occlusionSnapshotFallbackTimerRef.current = null
        }
        occlusionSnapshotInFlightRef.current = false
        if (
          mountedRef.current &&
          embeddedBrowserOccludedRef.current &&
          generation !== occlusionSnapshotGenerationRef.current
        ) {
          setOcclusionCaptureRetry(current => current + 1)
        }
      }
    },
    [active, electronRuntime, label, syncEmbeddedBrowserBounds]
  )

  useEffect(() => {
    const generation = occlusionSnapshotGenerationRef.current
    void syncOcclusionState(generation).catch(error => {
      console.error('Failed to sync embedded browser occlusion visibility:', error)
    })
  }, [
    browserOcclusion.generation,
    embeddedBrowserOccluded,
    occlusionCaptureRetry,
    syncOcclusionState,
  ])

  const handleOcclusionSnapshotLoad = useCallback(
    (generation: number) => {
      if (
        !embeddedBrowserOccludedRef.current ||
        generation !== occlusionSnapshotGenerationRef.current
      ) {
        return
      }
      occlusionSnapshotReadyRef.current = true
      void syncEmbeddedBrowserBounds(active).catch(error => {
        console.error('Failed to hide embedded browser behind occlusion snapshot:', error)
      })
    },
    [active, syncEmbeddedBrowserBounds]
  )

  const runBrowserCommand = useCallback(
    async (command: () => Promise<void>) => {
      try {
        await command()
        await refreshPageState()
      } catch (error) {
        console.error('Failed to control embedded browser:', error)
        setStatus('error')
        setError(t('workbench.browser_control_failed'))
      }
    },
    [refreshPageState, t]
  )

  const reloadCurrentUrl = useCallback(
    (url: string) => {
      setNavigationError(null)
      if (!embeddedBrowserAvailable) {
        setCurrentUrl(null)
        window.setTimeout(() => setCurrentUrl(url), 0)
        setStatus('ready')
        return
      }

      if (!nativeBrowserOpenRef.current) {
        setStatus('loading')
        setError(null)
        setCurrentUrl(url)
        setBrowserOpenAttempt(attempt => attempt + 1)
        return
      }

      setStatus('loading')
      setError(null)
      void runBrowserCommand(() => reloadEmbeddedBrowser(label))
    },
    [embeddedBrowserAvailable, label, runBrowserCommand]
  )

  const openBrowserUrl = useCallback(
    (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl)
      if (!nextUrl) {
        setStatus('error')
        setError(t('workbench.browser_invalid_url'))
        return
      }

      setAddress(nextUrl)
      setError(null)
      setNavigationError(null)
      setLocalFilePreviewToast(null)
      setInvalidTlsCertificate(certificate =>
        certificate && haveSameOrigin(certificate.url, nextUrl) ? certificate : null
      )
      pageStateRequestGenerationRef.current += 1
      pendingNavigationUrlRef.current = nextUrl

      if (nextUrl === activePageUrl) {
        updatePageUrl(nextUrl)
        pendingNavigationUrlRef.current = null
        reloadCurrentUrl(nextUrl)
        return
      }

      updatePageUrl(nextUrl)

      if (embeddedBrowserAvailable && nativeBrowserOpenRef.current) {
        setStatus('loading')
        void runBrowserCommand(() => navigateEmbeddedBrowser(nextUrl, label)).then(async () => {
          pendingNavigationUrlRef.current = null
          setCurrentUrl(nextUrl)
          await refreshPageState()
          track('browser_navigation_completed', { runtime: 'embedded' })
        })
        return
      }

      setCurrentUrl(nextUrl)
      setStatus(embeddedBrowserAvailable ? 'loading' : 'ready')
      if (!embeddedBrowserAvailable) pendingNavigationUrlRef.current = null
      track('browser_navigation_completed', { runtime: 'fallback' })
    },
    [
      activePageUrl,
      embeddedBrowserAvailable,
      label,
      refreshPageState,
      reloadCurrentUrl,
      runBrowserCommand,
      t,
      updatePageUrl,
    ]
  )

  useEffect(() => {
    if (!openRequest?.url) return
    if (openRequest.label && openRequest.label !== label) {
      console.info('[Wework][browser-open] openRequestLabelMismatch', {
        requestId: openRequest.id,
        requestLabel: openRequest.label,
        panelLabel: label,
      })
      return
    }
    if (handledOpenRequestIdRef.current === openRequest.id) return
    handledOpenRequestIdRef.current = openRequest.id
    // Only agent (bridge) opens defer the initial navigation to the bridge and
    // therefore create the host with about:blank. User, popup, and restore
    // requests bind the target URL directly during host creation.
    activeOpenRequestIdRef.current = openRequest.source === 'agent' ? openRequest.id : null
    logBrowserOpenDiagnostic('request_consumed', {
      active,
      label,
      requestId: openRequest.id,
      requestLabel: openRequest.label,
      url: openRequest.url,
    })
    openBrowserUrl(openRequest.url)
  }, [
    active,
    label,
    openBrowserUrl,
    openRequest?.id,
    openRequest?.label,
    openRequest?.source,
    openRequest?.url,
  ])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const urlInput = event.currentTarget.elements.namedItem('url') as HTMLInputElement | null
    const submittedAddress = urlInput?.value ?? address
    openBrowserUrl(submittedAddress)
    addressEditingRef.current = false
    urlInput?.blur()
  }

  const handleReload = () => {
    if (!activePageUrl) return
    if (annotationMode) exitAnnotationMode()
    reloadCurrentUrl(activePageUrl)
  }

  const handleOpenExternal = () => {
    if (!activePageUrl || internalDesktopPage) return
    void openExternalUrl(activePageUrl, { target: 'system' })
  }

  const clearBrowserData = useCallback(
    async (kinds: EmbeddedBrowserDataKind[]) => {
      if (clearingDataKind) return
      setClearingDataKind(kinds[0] ?? null)
      setClearDataNotice({
        id: Date.now(),
        message: t('workbench.browser_clear_started'),
        tone: 'success',
      })
      await new Promise<void>(resolve =>
        window.setTimeout(resolve, BROWSER_CLEAR_STARTED_NOTICE_MIN_MS)
      )
      try {
        await clearEmbeddedBrowserData(kinds)
        setClearDataNotice({
          id: Date.now(),
          message: t('workbench.browser_clear_completed'),
          tone: 'success',
        })
      } catch (error) {
        console.error('Failed to clear embedded browser data:', error)
        setClearDataNotice({
          id: Date.now(),
          message: t('workbench.browser_clear_failed'),
          tone: 'error',
        })
      } finally {
        setClearingDataKind(null)
      }
    },
    [clearingDataKind, t]
  )

  const setAgentControlPaused = useCallback(
    (paused: boolean) => {
      void setEmbeddedBrowserAgentControlPaused(paused, label).catch(error => {
        console.error('Failed to update embedded browser agent control:', error)
      })
    },
    [label]
  )

  const resolveAgentApproval = useCallback(
    (approvalId: string, approved: boolean) => {
      void resolveEmbeddedBrowserAgentApproval(approvalId, approved, label).catch(error => {
        console.error('Failed to resolve embedded browser agent approval:', error)
      })
    },
    [label]
  )

  const agentActionLabel = (action: string | null) => {
    switch (action) {
      case 'open':
      case 'navigate':
        return t('workbench.browser_agent_action_open')
      case 'inspect':
        return t('workbench.browser_agent_action_inspect')
      case 'waitFor':
        return t('workbench.browser_agent_action_wait')
      case 'click':
        return t('workbench.browser_agent_action_click')
      case 'typeText':
      case 'fill':
        return t('workbench.browser_agent_action_fill')
      case 'hover':
        return t('workbench.browser_agent_action_hover')
      case 'press':
        return t('workbench.browser_agent_action_press')
      case 'scroll':
      case 'scrollIntoView':
        return t('workbench.browser_agent_action_scroll')
      case 'screenshot':
        return t('workbench.browser_agent_action_screenshot')
      default:
        return t('workbench.browser_agent_action_generic')
    }
  }

  const agentStatusText = (state: BrowserAgentState) => {
    if (state.approval) {
      return t('workbench.browser_agent_approval_required', {
        action: agentActionLabel(state.action || state.approval.actionKind),
      })
    }
    if (state.status === 'running') {
      return t('workbench.browser_agent_running', { action: agentActionLabel(state.action) })
    }
    if (state.status === 'paused') {
      return t('workbench.browser_agent_paused')
    }
    if (state.status === 'needs_user') {
      return t('workbench.browser_agent_needs_user')
    }
    if (state.status === 'error') {
      return t('workbench.browser_agent_error')
    }
    return t('workbench.browser_agent_ready')
  }

  const agentApprovalReason = (state: BrowserAgentState) => {
    if (!state.approval) return null
    return state.approval.reason || state.message || t('workbench.browser_agent_approval_reason')
  }

  const clearLocalFilePreviewToast = useCallback(() => setLocalFilePreviewToast(null), [])
  const clearClearDataNotice = useCallback(() => setClearDataNotice(null), [])

  // --- Find in page (JS injection; wry has no native find API) ---

  const canUsePageFind = Boolean(activePageUrl) && !internalDesktopPage

  const runFindSearch = useCallback(
    (query: string) => {
      const request = ++findRequestSequenceRef.current
      if (!query) {
        setFindResult(null)
        setFindUnavailable(false)
        void clearEmbeddedBrowserFind(label)
        return
      }
      void searchEmbeddedBrowserPage(query, label)
        .then(state => {
          if (findRequestSequenceRef.current !== request) return
          setFindResult(state)
          setFindUnavailable(state === null)
        })
        .catch(() => {
          if (findRequestSequenceRef.current !== request) return
          setFindResult(null)
          setFindUnavailable(true)
        })
    },
    [label]
  )

  const openFindBar = useCallback(() => {
    setFindOpen(true)
    if (!nativeBrowserOpenRef.current) return
    // Mirror Codex: prefill the find query with the current page selection.
    void evalEmbeddedBrowserJson<string | null>(
      'window.getSelection()?.toString()?.trim() || null',
      label
    )
      .then(selection => {
        if (typeof selection === 'string' && selection && !/[\r\n]/.test(selection)) {
          setFindQuery(selection)
        }
      })
      .catch(() => undefined)
  }, [label])

  const closeFindBar = useCallback(() => {
    findRequestSequenceRef.current += 1
    setFindOpen(false)
    setFindQuery('')
    setFindResult(null)
    setFindUnavailable(false)
    void clearEmbeddedBrowserFind(label)
  }, [label])

  const stepFind = useCallback(
    (direction: 1 | -1) => {
      if (!findQuery) return
      void stepEmbeddedBrowserFind(direction, label)
        .then(state => {
          if (state) setFindResult(state)
        })
        .catch(() => undefined)
    },
    [findQuery, label]
  )

  useEffect(() => {
    if (!findOpen) return
    const timer = window.setTimeout(() => runFindSearch(findQuery), 150)
    return () => window.clearTimeout(timer)
  }, [findOpen, findQuery, runFindSearch])

  // Re-run the active search after a navigation or reload replaces the page.
  useEffect(() => {
    if (!findOpen) {
      findPageUrlRef.current = activePageUrl
      return
    }
    if (status !== 'ready') return
    if (findPageUrlRef.current === activePageUrl) return
    findPageUrlRef.current = activePageUrl
    if (!findQuery) return
    const timer = window.setTimeout(() => runFindSearch(findQuery), 150)
    return () => window.clearTimeout(timer)
  }, [activePageUrl, findOpen, findQuery, runFindSearch, status])

  // --- Device toolbar (viewport emulation via bounds + fit scale) ---

  const changeBrowserZoom = useCallback(
    (nextPercent: number) => {
      zoomPercentRef.current = nextPercent
      setZoomPercent(nextPercent)
      // The bounds sync applies the correct combined zoom (page zoom alone,
      // or folded into the device viewport fit scale).
      scheduleEmbeddedBrowserBoundsSync(activeRef.current)
    },
    [scheduleEmbeddedBrowserBoundsSync]
  )

  // Re-apply the complete browser viewport after the webview reloads or is
  // recreated. Device mode must restore bounds, zoom, and CDP metrics as one
  // ordered operation; restoring zoom alone changes the emulated CSS viewport.
  useEffect(() => {
    if (status !== 'ready') return
    if (zoomPercentRef.current === BROWSER_ZOOM_DEFAULT_PERCENT && deviceFitScaleRef.current === 1)
      return
    if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return
    scheduleEmbeddedBrowserBoundsSync(activeRef.current)
  }, [status, embeddedBrowserAvailable, scheduleEmbeddedBrowserBoundsSync])

  const updateDeviceToolbar = useCallback(
    (patch: Partial<BrowserDeviceToolbarState>) => {
      setDeviceToolbar(current => {
        const next = { ...current, ...patch }
        deviceToolbarRef.current = next
        return next
      })
      scheduleEmbeddedBrowserBoundsSync(activeRef.current)
    },
    [scheduleEmbeddedBrowserBoundsSync]
  )

  const toggleDeviceToolbar = useCallback(() => {
    updateDeviceToolbar({ isEnabled: !deviceToolbarRef.current.isEnabled })
  }, [updateDeviceToolbar])

  const handleDevicePresetChange = useCallback(
    (presetId: string) => {
      const preset = resolveDevicePreset(presetId)
      if (!preset) return
      // Codex resets the page zoom when the preset changes.
      zoomPercentRef.current = BROWSER_ZOOM_DEFAULT_PERCENT
      setZoomPercent(BROWSER_ZOOM_DEFAULT_PERCENT)
      updateDeviceToolbar({ presetId, width: preset.width, height: preset.height })
    },
    [updateDeviceToolbar]
  )

  const handleDeviceDimensionsChange = useCallback(
    (width: number, height: number) => {
      const nextWidth = clampDeviceDimension(width, BROWSER_DEVICE_MIN_WIDTH)
      const nextHeight = clampDeviceDimension(height, BROWSER_DEVICE_MIN_HEIGHT)
      updateDeviceToolbar({
        width: nextWidth,
        height: nextHeight,
        presetId: matchDevicePresetId(nextWidth, nextHeight),
      })
    },
    [updateDeviceToolbar]
  )

  const handleDeviceRotate = useCallback(() => {
    const current = deviceToolbarRef.current
    updateDeviceToolbar({ width: current.height, height: current.width })
  }, [updateDeviceToolbar])

  const deviceResizeStateRef = useRef<{
    pointerId: number
    edge: BrowserDeviceResizeEdge
    startX: number
    startY: number
    startWidth: number
    startHeight: number
  } | null>(null)

  const handleDeviceResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const edge = event.currentTarget.dataset.edge as BrowserDeviceResizeEdge
    if (!edge) return
    event.preventDefault()
    event.stopPropagation()
    const current = deviceToolbarRef.current
    deviceResizeStateRef.current = {
      pointerId: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: current.width,
      startHeight: current.height,
    }
    if (event.nativeEvent.isTrusted) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }, [])

  const handleDeviceResizeMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = deviceResizeStateRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const next = resizeDeviceDimensions(
        drag.edge,
        drag.startWidth,
        drag.startHeight,
        event.clientX - drag.startX,
        event.clientY - drag.startY,
        deviceFitScaleRef.current
      )
      handleDeviceDimensionsChange(next.width, next.height)
    },
    [handleDeviceDimensionsChange]
  )

  const handleDeviceResizeEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = deviceResizeStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    deviceResizeStateRef.current = null
    if (event.nativeEvent.isTrusted && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  // --- Toolbar keyboard shortcuts (Cmd/Ctrl+F) ---

  const handleBrowserKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== 'f') return
      if (canUsePageFind && embeddedBrowserAvailable) {
        event.preventDefault()
        openFindBar()
      }
    },
    [canUsePageFind, embeddedBrowserAvailable, openFindBar]
  )

  return (
    <div
      ref={browserPanelRef}
      data-testid="workspace-browser-panel"
      data-embedded-browser-label={label}
      data-browser-annotation-original-view={annotationOriginalView}
      data-browser-annotation-revision={annotationRevision}
      data-browser-annotation-runtime-revision={annotationRuntimeRevision}
      onKeyDown={handleBrowserKeyDown}
      className={cn(
        'relative flex h-full min-h-0 w-full flex-col bg-background text-text-primary',
        !active && 'hidden'
      )}
    >
      {annotationMode && !internalDesktopPage ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-browser-annotation-border)] bg-[var(--color-browser-annotation-surface)] px-2 text-sm text-text-primary">
          <BrowserToolbarButton
            testId="workspace-browser-annotation-close-button"
            label={t('workbench.browser_annotation_close')}
            onClick={exitAnnotationMode}
          >
            <X className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-annotation-clear-button"
            label={t('workbench.browser_annotation_clear')}
            disabled={annotations.length === 0 || discardingAnnotations}
            onClick={() => setDiscardDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </BrowserToolbarButton>
          <div className="min-w-0 flex-1 truncate text-center font-medium">
            {originalViewEnabled
              ? t('workbench.browser_annotation_original_title', {
                  site: activePageUrl
                    ? getFallbackBrowserTitle(activePageUrl)
                    : t('workbench.browser'),
                })
              : t('workbench.browser_annotation_active', {
                  site: activePageUrl
                    ? getFallbackBrowserTitle(activePageUrl)
                    : t('workbench.browser'),
                })}
          </div>
          <button
            type="button"
            data-testid="workspace-browser-annotation-original-view-button"
            aria-pressed={originalViewEnabled}
            aria-label={t('workbench.browser_annotation_hold_to_view_original')}
            title={t('workbench.browser_annotation_hold_to_view_original')}
            disabled={!hasQueuedTweaks}
            onBlur={blurOriginalView}
            onKeyDown={handleOriginalViewKeyDown}
            onKeyUp={handleOriginalViewKeyUp}
            onPointerCancel={cancelOriginalView}
            onPointerDown={holdOriginalView}
            onPointerUp={releaseOriginalView}
            className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 aria-pressed:bg-muted aria-pressed:text-text-primary"
          >
            <span
              className={
                originalViewEnabled
                  ? 'inline-flex items-center justify-center transition-transform duration-200 motion-reduce:transition-none scale-[0.8]'
                  : 'inline-flex items-center justify-center transition-transform duration-200 motion-reduce:transition-none'
              }
            >
              {originalViewEnabled ? (
                <OriginalViewEyeOff className="h-4 w-4" />
              ) : (
                <OriginalViewEye className="h-4 w-4" />
              )}
            </span>
          </button>
          {annotations.length > 0 ? (
            <span
              data-testid="workspace-browser-annotation-count"
              className="rounded-md bg-[var(--color-browser-annotation-chip)] px-2 py-1 text-xs font-medium text-[rgb(var(--color-focus))]"
            >
              {t('workbench.browser_annotation_count', { count: annotations.length })}
            </span>
          ) : null}
        </div>
      ) : hideToolbar ? null : (
        <div className="relative flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2">
          <BrowserToolbarButton
            testId="workspace-browser-back-button"
            label={t('workbench.browser_back')}
            disabled={!currentUrl || !embeddedBrowserAvailable}
            onClick={() => void runBrowserCommand(() => goBackEmbeddedBrowser(label))}
          >
            <ArrowLeft className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-forward-button"
            label={t('workbench.browser_forward')}
            disabled={!currentUrl || !embeddedBrowserAvailable}
            onClick={() => void runBrowserCommand(() => goForwardEmbeddedBrowser(label))}
          >
            <ArrowRight className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-reload-button"
            label={t('workbench.browser_reload')}
            disabled={!activePageUrl}
            onClick={handleReload}
          >
            <RotateCw className="h-4 w-4" />
          </BrowserToolbarButton>
          <form onSubmit={handleSubmit} className="min-w-0 flex-1">
            <input
              ref={addressInputRef}
              name="url"
              data-testid="workspace-browser-url-input"
              value={address}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={event => setAddress(event.target.value)}
              onFocus={() => {
                addressEditingRef.current = true
              }}
              onBlur={() => {
                addressEditingRef.current = false
                const currentPageUrl = activePageUrlRef.current
                if (currentPageUrl) setAddress(currentPageUrl)
              }}
              placeholder={t('workbench.browser_url_placeholder')}
              className="h-8 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:bg-background"
            />
          </form>
          <BrowserToolbarButton
            testId="workspace-browser-downloads-button"
            label={t('workbench.browser_downloads')}
            onClick={() => setDownloadsOpen(open => !open)}
          >
            <span className="relative">
              <Download className="h-4 w-4" />
              {downloads.some(
                download => download.status === 'started' || download.status === 'progress'
              ) ? (
                <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-primary" />
              ) : null}
            </span>
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-annotate-button"
            label={t('workbench.browser_annotation_start')}
            disabled={!activePageUrl || !embeddedBrowserAvailable || internalDesktopPage}
            onClick={() => void enterAnnotationMode()}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            testId="workspace-browser-open-external-button"
            label={t('workbench.browser_open_external')}
            disabled={!activePageUrl || internalDesktopPage}
            onClick={handleOpenExternal}
          >
            <ExternalLink className="h-4 w-4" />
          </BrowserToolbarButton>
          {embeddedBrowserAvailable ? (
            <ActionMenu
              ariaLabel={t('workbench.browser_more_actions')}
              testId="workspace-browser-more-button"
              icon={EllipsisVertical}
              placement="bottom-end"
              width={240}
              itemClassName="min-h-9 px-2"
              triggerClassName="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
              items={[
                {
                  label: t('workbench.browser_find_in_page'),
                  testId: 'workspace-browser-find-item',
                  disabled: !canUsePageFind,
                  onSelect: openFindBar,
                },
                {
                  label: '',
                  testId: 'workspace-browser-more-separator-find',
                  separator: true,
                },
                {
                  label: deviceToolbar.isEnabled
                    ? t('workbench.browser_device_toolbar_hide')
                    : t('workbench.browser_device_toolbar_show'),
                  testId: 'workspace-browser-device-toolbar-item',
                  disabled: !activePageUrl || internalDesktopPage,
                  onSelect: toggleDeviceToolbar,
                },
                {
                  label: '',
                  testId: 'workspace-browser-more-separator-actions',
                  separator: true,
                },
                {
                  label: t('workbench.browser_history'),
                  testId: 'workspace-browser-history-item',
                  onSelect: () => navigateTo('/settings/browser/history'),
                },
                {
                  label: t('workbench.browser_clear_data'),
                  testId: 'workspace-browser-clear-data-item',
                  disabled: Boolean(clearingDataKind),
                  children: [
                    {
                      label: t('workbench.browser_clear_cookies'),
                      testId: 'workspace-browser-clear-cookies-item',
                      disabled: Boolean(clearingDataKind),
                      onSelect: () => clearBrowserData(['cookies']),
                    },
                    {
                      label: t('workbench.browser_clear_cache'),
                      testId: 'workspace-browser-clear-cache-item',
                      disabled: Boolean(clearingDataKind),
                      onSelect: () => clearBrowserData(['cache', 'storage']),
                    },
                  ],
                },
                {
                  label: '',
                  testId: 'workspace-browser-more-separator-data',
                  separator: true,
                },
                {
                  label: t('workbench.browser_settings'),
                  testId: 'workspace-browser-settings-item',
                  onSelect: () => navigateTo('/settings/browser'),
                },
              ]}
            />
          ) : null}
        </div>
      )}
      {findOpen && (!annotationMode || internalDesktopPage) ? (
        <BrowserFindBar
          query={findQuery}
          result={findResult}
          unavailable={findUnavailable}
          onQueryChange={setFindQuery}
          onStep={stepFind}
          onClose={closeFindBar}
        />
      ) : null}
      {deviceToolbar.isEnabled && (!annotationMode || internalDesktopPage) ? (
        <BrowserDeviceToolbar
          state={deviceToolbar}
          zoomPercent={zoomPercent}
          onPresetChange={handleDevicePresetChange}
          onDimensionsChange={handleDeviceDimensionsChange}
          onRotate={handleDeviceRotate}
          onZoomPercentChange={changeBrowserZoom}
          onClose={toggleDeviceToolbar}
        />
      ) : null}
      <ConfirmDialog
        open={discardDialogOpen}
        title={t('workbench.browser_annotation_discard_title')}
        description={t('workbench.browser_annotation_discard_description')}
        cancelLabel={t('workbench.cancel')}
        confirmLabel={t('workbench.browser_annotation_discard_confirm')}
        confirmTestId="workspace-browser-annotation-discard-confirm-button"
        destructive
        pending={discardingAnnotations}
        onClose={() => setDiscardDialogOpen(false)}
        onConfirm={() => {
          setDiscardingAnnotations(true)
          void clearEmbeddedBrowserAnnotations(label)
            .then(() => readEmbeddedBrowserAnnotationState(label))
            .then(state => {
              if (!applyAnnotationState(state)) return
              setOriginalViewHeld(false)
              if (state.scope) {
                onRemoveBrowserCodeComments?.({ ...state.scope, browserTabId })
              }
              setDiscardDialogOpen(false)
            })
            .catch(error => {
              console.error('Failed to clear embedded browser annotations:', error)
              setError(t('workbench.browser_annotation_clear_failed'))
            })
            .finally(() => setDiscardingAnnotations(false))
        }}
      />
      {shouldShowAgentState(agentState) ? (
        <div
          data-testid="workspace-browser-agent-status"
          className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-xs text-text-secondary"
        >
          {agentState?.status === 'paused' ? (
            <Pause className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          ) : (
            <CircleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {agentState ? agentStatusText(agentState) : null}
            {agentState?.approval ? (
              <span className="ml-1 text-text-muted">{agentApprovalReason(agentState)}</span>
            ) : null}
          </span>
          {agentState?.approval ? (
            <>
              <button
                type="button"
                data-testid="workspace-browser-agent-approval-approve-button"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
                onClick={() => resolveAgentApproval(agentState.approval?.approvalId || '', true)}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('workbench.browser_agent_approval_continue')}
              </button>
              <button
                type="button"
                data-testid="workspace-browser-agent-approval-reject-button"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
                onClick={() => resolveAgentApproval(agentState.approval?.approvalId || '', false)}
              >
                <X className="h-3.5 w-3.5" />
                {t('workbench.browser_agent_approval_cancel')}
              </button>
            </>
          ) : agentState?.status === 'paused' ? (
            <button
              type="button"
              data-testid="workspace-browser-agent-resume-button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
              onClick={() => setAgentControlPaused(false)}
            >
              <Play className="h-3.5 w-3.5" />
              {t('workbench.browser_agent_resume')}
            </button>
          ) : null}
        </div>
      ) : null}
      {(!annotationMode || internalDesktopPage) && downloadsOpen ? (
        <div
          data-testid="workspace-browser-downloads-panel"
          className="flex max-h-40 shrink-0 flex-col overflow-y-auto border-b border-border bg-surface px-3 py-2"
        >
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-medium text-text-secondary">
              {t('workbench.browser_downloads')}
            </span>
            <button
              type="button"
              data-testid="workspace-browser-downloads-close"
              aria-label={t('workbench.browser_downloads_close')}
              className="rounded-md p-1 text-text-secondary hover:bg-muted hover:text-text-primary"
              onClick={() => setDownloadsOpen(false)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {downloads.length === 0 ? (
            <span className="text-xs text-text-muted">
              {t('workbench.browser_downloads_empty')}
            </span>
          ) : (
            downloads.map(download => {
              const fileName = download.path?.split(/[\\/]/).pop() || download.url
              const downloading = download.status === 'started' || download.status === 'progress'
              const progress =
                download.totalBytes && download.receivedBytes !== null
                  ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))
                  : null
              return (
                <div
                  key={download.id}
                  data-testid="workspace-browser-download-item"
                  className="flex min-h-12 flex-col justify-center gap-1 text-xs"
                >
                  <div className="flex items-center gap-2">
                    {download.status === 'finished' ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
                    ) : download.status === 'failed' ? (
                      <CircleAlert className="h-4 w-4 shrink-0 text-red-500" />
                    ) : download.status === 'paused' ? (
                      <Download className="h-4 w-4 shrink-0 text-text-muted" />
                    ) : (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={download.path ?? download.url}>
                      {fileName}
                    </span>
                    <span className="shrink-0 text-text-muted">
                      {downloading
                        ? progress !== null
                          ? `${progress}% · ${formatDownloadBytes(download.receivedBytes)} / ${formatDownloadBytes(download.totalBytes)}`
                          : formatDownloadBytes(download.receivedBytes) ||
                            t('workbench.browser_download_started')
                        : t(`workbench.browser_download_${download.status}`)}
                    </span>
                    {download.status === 'finished' && download.path ? (
                      <button
                        type="button"
                        data-testid="workspace-browser-download-reveal-button"
                        className="shrink-0 rounded-md px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                        onClick={() => void revealLocalFile(download.path ?? undefined)}
                      >
                        {fileManagerRevealLabel(t)}
                      </button>
                    ) : null}
                    {downloading ? (
                      <button
                        type="button"
                        data-testid="workspace-browser-download-pause-button"
                        className="shrink-0 rounded-md p-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                        aria-label={t('workbench.browser_download_pause')}
                        onClick={() => void pauseEmbeddedBrowserDownload(download.id)}
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    {download.status === 'paused' ? (
                      <>
                        <button
                          type="button"
                          data-testid="workspace-browser-download-resume-button"
                          className="shrink-0 rounded-md p-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                          aria-label={t('workbench.browser_download_resume')}
                          onClick={() => void resumeEmbeddedBrowserDownload(download.id)}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid="workspace-browser-download-delete-button"
                          className="shrink-0 rounded-md p-1 text-red-500 hover:bg-red-500/10"
                          aria-label={t('workbench.browser_download_delete')}
                          onClick={() => void deleteEmbeddedBrowserDownload(download.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : null}
                  </div>
                  {downloading ? (
                    <div
                      data-testid="workspace-browser-download-progress"
                      className="ml-6 h-1 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className={`h-full rounded-full bg-primary transition-[width] ${
                          progress === null ? 'w-1/3 animate-pulse' : ''
                        }`}
                        style={progress === null ? undefined : { width: `${progress}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      ) : null}
      <TransientNotice
        key={localFilePreviewToast?.id ?? 'workspace-browser-local-file-toast'}
        message={localFilePreviewToast?.message ?? null}
        tone="error"
        onClear={clearLocalFilePreviewToast}
        horizontalAnchorRef={browserPanelRef}
        visible={active}
      />
      {downloadPeek ? (
        <div
          key={downloadPeek.id}
          data-testid="workspace-browser-download-peek"
          role="status"
          className="absolute bottom-4 right-4 z-20 flex w-72 flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-[0_8px_28px_rgba(0,0,0,0.12)]"
        >
          <div className="flex items-center gap-2">
            {downloadPeek.status === 'finished' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
            ) : (
              <CircleAlert className="h-4 w-4 shrink-0 text-red-500" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-text-primary">
                {t(`workbench.browser_download_${downloadPeek.status}`)}
              </p>
              <p
                className="truncate text-xs text-text-muted"
                title={downloadPeek.path ?? downloadPeek.fileName}
              >
                {downloadPeek.fileName}
              </p>
            </div>
            <button
              type="button"
              data-testid="workspace-browser-download-peek-dismiss"
              aria-label={t('workbench.browser_download_peek_dismiss')}
              className="shrink-0 rounded-md p-1 text-text-secondary hover:bg-muted hover:text-text-primary"
              onClick={() => setDownloadPeek(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {downloadPeek.status === 'finished' && downloadPeek.path ? (
              <>
                <button
                  type="button"
                  data-testid="workspace-browser-download-peek-open"
                  className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                  onClick={() => {
                    void openLocalFile(downloadPeek.path ?? undefined)
                    setDownloadPeek(null)
                  }}
                >
                  {t('workbench.browser_download_peek_open')}
                </button>
                <button
                  type="button"
                  data-testid="workspace-browser-download-peek-show-in-folder"
                  className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                  onClick={() => {
                    void revealLocalFile(downloadPeek.path ?? undefined)
                    setDownloadPeek(null)
                  }}
                >
                  {fileManagerRevealLabel(t)}
                </button>
              </>
            ) : null}
            <button
              type="button"
              data-testid="workspace-browser-download-peek-view-downloads"
              className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
              onClick={() => {
                setDownloadPeek(null)
                setDownloadsOpen(true)
              }}
            >
              {t('workbench.browser_download_peek_view_downloads')}
            </button>
          </div>
        </div>
      ) : null}
      <TransientNotice
        key={clearDataNotice?.id ?? 'workspace-browser-clear-data-toast'}
        message={clearDataNotice?.message ?? null}
        tone={clearDataNotice?.tone}
        onClear={clearClearDataNotice}
        horizontalAnchorRef={browserPanelRef}
        visible={active}
      />
      {invalidTlsCertificate ? (
        <div
          data-testid="workspace-browser-invalid-tls-warning"
          role="status"
          className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-text-primary"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0">
            <p className="font-medium">{t('workbench.browser_invalid_tls_title')}</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {t('workbench.browser_invalid_tls_desc', {
                host: invalidTlsCertificate.host,
              })}
            </p>
          </div>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background pl-1">
        {!currentUrl && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Globe2 className="mb-4 h-8 w-8 text-text-muted" />
            <p className="text-sm font-semibold text-text-primary">
              {t('workbench.browser_empty_title')}
            </p>
            <p className="mt-2 text-sm leading-[18px] text-text-secondary">
              {t('workbench.browser_empty_desc')}
            </p>
          </div>
        )}
        {currentUrl && !embeddedBrowserAvailable && (
          <iframe
            key={currentUrl}
            data-testid="workspace-browser-frame"
            title={t('workbench.browser')}
            src={currentUrl}
            className="h-full w-full border-0 bg-background"
          />
        )}
        {currentUrl && embeddedBrowserAvailable && (
          <div
            ref={browserHostRef}
            data-testid="workspace-browser-native-view"
            className={cn(
              'relative h-full min-h-0 w-full overflow-hidden',
              deviceToolbar.isEnabled ? 'bg-neutral-700' : 'bg-background'
            )}
            aria-label={t('workbench.browser')}
          >
            {electronRuntime ? (
              <ElectronEmbeddedBrowserView
                active={active}
                cursor={agentCursor}
                cursorScale={
                  deviceToolbar.isEnabled
                    ? (deviceVisualRect ? deviceVisualRect.width / deviceToolbar.width : 1) *
                      zoomPercentToScaleFactor(zoomPercent)
                    : zoomPercentToScaleFactor(zoomPercent)
                }
                interactionBlocked={embeddedBrowserOccluded || Boolean(navigationError)}
                label={label}
                transferFromLabel={transferFromLabel}
                visualRect={deviceVisualRect}
              />
            ) : active &&
              embeddedBrowserOccluded &&
              occlusionSnapshot?.generation === browserOcclusion.generation ? (
              <img
                data-testid="workspace-browser-occlusion-snapshot"
                src={occlusionSnapshot.url}
                alt=""
                onLoad={() => handleOcclusionSnapshotLoad(occlusionSnapshot.generation)}
                style={
                  deviceVisualRect
                    ? {
                        left: deviceVisualRect.x,
                        top: deviceVisualRect.y,
                        width: deviceVisualRect.width,
                        height: deviceVisualRect.height,
                      }
                    : undefined
                }
                className={cn(
                  'pointer-events-none absolute bg-background object-fill',
                  deviceVisualRect ? '' : 'inset-0 h-full w-full'
                )}
              />
            ) : null}
            {navigationError ? (
              <div
                data-testid="workspace-browser-navigation-error"
                role="alert"
                className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
              >
                <CircleAlert className="mb-4 h-7 w-7 text-text-muted" />
                <p className="text-sm font-medium text-text-primary">
                  {t('workbench.browser_navigation_failed_title')}
                </p>
                <p className="mt-2 max-w-md text-sm leading-[18px] text-text-secondary">
                  {t('workbench.browser_navigation_failed_desc')}
                </p>
              </div>
            ) : null}
            {status === 'loading' && !navigationError && (
              <div
                data-testid="workspace-browser-loading"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40"
              >
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            )}
            {deviceToolbar.isEnabled && deviceVisualRect
              ? [
                  { edge: 'left' as const, cursor: 'ew-resize' },
                  { edge: 'right' as const, cursor: 'ew-resize' },
                  { edge: 'bottom' as const, cursor: 'ns-resize' },
                  { edge: 'bottom-left' as const, cursor: 'nesw-resize' },
                  { edge: 'bottom-right' as const, cursor: 'nwse-resize' },
                ].map(handle => {
                  const rect = deviceVisualRect
                  // Handles sit 20px outside the device viewport, as in Codex.
                  const thickness = 20
                  const style =
                    handle.edge === 'left'
                      ? {
                          left: rect.x - thickness,
                          top: rect.y,
                          width: thickness,
                          height: rect.height,
                        }
                      : handle.edge === 'right'
                        ? {
                            left: rect.x + rect.width,
                            top: rect.y,
                            width: thickness,
                            height: rect.height,
                          }
                        : handle.edge === 'bottom'
                          ? {
                              left: rect.x - thickness,
                              top: rect.y + rect.height,
                              width: rect.width + thickness * 2,
                              height: thickness,
                            }
                          : handle.edge === 'bottom-left'
                            ? {
                                left: rect.x - thickness,
                                top: rect.y + rect.height,
                                width: thickness,
                                height: thickness,
                              }
                            : {
                                left: rect.x + rect.width,
                                top: rect.y + rect.height,
                                width: thickness,
                                height: thickness,
                              }
                  const left = 'left' in style ? (style.left ?? 0) : 0
                  const top = 'top' in style ? (style.top ?? 0) : 0
                  if (
                    left < 0 ||
                    top < 0 ||
                    left + style.width > rect.hostWidth ||
                    top + style.height > rect.hostHeight
                  ) {
                    return null
                  }
                  return (
                    <div
                      key={handle.edge}
                      data-testid={`workspace-browser-device-resize-${handle.edge}`}
                      data-edge={handle.edge}
                      aria-hidden="true"
                      className="absolute z-30"
                      style={{ ...style, cursor: handle.cursor, touchAction: 'none' }}
                      onPointerDown={handleDeviceResizeStart}
                      onPointerMove={handleDeviceResizeMove}
                      onPointerUp={handleDeviceResizeEnd}
                      onPointerCancel={handleDeviceResizeEnd}
                    />
                  )
                })
              : null}
          </div>
        )}
        {error && (
          <div
            data-testid="workspace-browser-error"
            role="alert"
            className="absolute inset-x-4 top-4 rounded-md border border-red-500/30 bg-background px-3 py-2 text-sm text-red-500 shadow-sm"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

function BrowserToolbarButton({
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
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

const ORIGINAL_VIEW_EYE_PATH =
  'M8.50195 17.5V16.498H6.5C5.81091 16.498 5.25395 16.4987 4.80371 16.4619C4.40303 16.4292 4.04237 16.364 3.70606 16.2197L3.56348 16.1533C3.04236 15.8878 2.60586 15.4841 2.30176 14.9883L2.17969 14.7705C1.98772 14.3937 1.90851 13.9873 1.87109 13.5293C1.83432 13.0791 1.83496 12.522 1.83496 11.833V8.16699C1.83496 7.478 1.83432 6.92091 1.87109 6.4707C1.90851 6.0127 1.98772 5.60625 2.17969 5.22949L2.30176 5.01172C2.60586 4.5159 3.04236 4.1122 3.56348 3.84668L3.70606 3.78027C4.04237 3.636 4.40303 3.57083 4.80371 3.53809C5.25395 3.5013 5.81091 3.50195 6.5 3.50195H8.50195V2.5C8.50195 2.13273 8.79972 1.83496 9.16699 1.83496C9.53411 1.83514 9.83203 2.13284 9.83203 2.5V17.5C9.83203 17.8672 9.53411 18.1649 9.16699 18.165C8.79972 18.165 8.50195 17.8673 8.50195 17.5ZM16.835 11.833V8.16699C16.835 7.4561 16.8341 6.96259 16.8027 6.5791C16.7797 6.29739 16.7428 6.1076 16.6914 5.96387L16.6348 5.83398C16.4808 5.53176 16.2466 5.27886 15.959 5.10254L15.833 5.03125C15.675 4.9508 15.4635 4.89397 15.0879 4.86328C14.7044 4.83195 14.211 4.83203 13.5 4.83203H12.5C12.1328 4.83203 11.8351 4.53411 11.835 4.16699C11.835 3.79972 12.1327 3.50195 12.5 3.50195H13.5C14.1891 3.50195 14.746 3.5013 15.1963 3.53809C15.6541 3.5755 16.0599 3.65483 16.4365 3.84668L16.6553 3.96875C17.1509 4.27282 17.5549 4.70856 17.8203 5.22949L17.8867 5.37207C18.0311 5.70855 18.0961 6.06979 18.1289 6.4707C18.1657 6.92091 18.165 7.478 18.165 8.16699V11.833C18.165 12.522 18.1657 13.0791 18.1289 13.5293C18.0961 13.9302 18.0311 14.2914 17.8867 14.6279L17.8203 14.7705C17.5549 15.2914 17.1509 15.7272 16.6553 16.0312L16.4365 16.1533C16.0599 16.3452 15.6541 16.4245 15.1963 16.4619C14.746 16.4987 14.1891 16.498 13.5 16.498H12.5C12.1327 16.498 11.835 16.2003 11.835 15.833C11.8351 15.4659 12.1328 15.168 12.5 15.168H13.5C14.211 15.168 14.7044 15.1681 15.0879 15.1367C15.4635 15.106 15.675 15.0492 15.833 14.9688L15.959 14.8975C16.2466 14.7211 16.4808 14.4682 16.6348 14.166L16.6914 14.0361C16.7428 13.8924 16.7797 13.7026 16.8027 13.4209C16.8341 13.0374 16.835 12.5439 16.835 11.833Z'

const ORIGINAL_VIEW_EYE_OFF_PATH = `${ORIGINAL_VIEW_EYE_PATH}M3.16504 11.833C3.16504 12.5439 3.16595 13.0374 3.19727 13.4209C3.22795 13.7965 3.28478 14.008 3.36524 14.166L3.43555 14.293C3.61186 14.5804 3.86488 14.8148 4.16699 14.9688L4.29688 15.0244C4.44065 15.0759 4.6021 15.1167 4.7725 15.1481L3.26013 16.7501C2.98382 17.049 3.01822 17.5198 3.33734 17.7341C3.63373 17.9333 4.04444 17.8667 4.26816 17.6251L11.5435 9.67934C11.7375 9.45741 11.7047 9.12753 11.4624 8.94551C11.2303 8.78669 10.9187 8.78911 10.7261 8.99983L3.16504 11.833ZM16.7005 10.4814C16.8404 10.6582 16.88 10.8534 16.7992 10.9698C16.6982 11.0864 16.6063 11.2251 16.5394 11.3935C16.4229 11.6894 16.3539 11.9974 16.3343 12.3106C16.3182 12.5668 16.2619 12.815 16.1672 13.0501L16.124 13.1764C16.0123 13.4719 15.8415 13.7402 15.6236 13.9647L15.4308 14.1801L17.3971 12.0618C17.7 11.7297 17.6586 11.2544 17.2998 11.0136C16.9799 10.7991 16.5405 10.9042 16.7005 11.2238V10.4814Z`

function OriginalViewEye({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={ORIGINAL_VIEW_EYE_PATH} />
    </svg>
  )
}

function OriginalViewEyeOff({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={ORIGINAL_VIEW_EYE_OFF_PATH} />
    </svg>
  )
}
