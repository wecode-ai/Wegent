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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { cloudDesktopExtension } from '@extensions/cloud-desktop'
import { TransientNotice } from '@/components/common/TransientNotice'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ActionMenu } from '@/components/common/ActionMenu'
import {
  canUseEmbeddedBrowser,
  clearEmbeddedBrowserData,
  closeEmbeddedBrowser,
  consumeEmbeddedBrowserLabelTransfer,
  deleteEmbeddedBrowserDownload,
  listenEmbeddedBrowserAgentState,
  listenEmbeddedBrowserCloseRequests,
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
  EMBEDDED_BROWSER_OCCLUSION_EVENT,
  evalEmbeddedBrowser,
  evalEmbeddedBrowserJson,
  goBackEmbeddedBrowser,
  goForwardEmbeddedBrowser,
  listenEmbeddedBrowserInvalidTlsCertificates,
  listenEmbeddedBrowserLocalFilePreview,
  listenEmbeddedBrowserPageStateChanges,
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  pauseEmbeddedBrowserDownload,
  readEmbeddedBrowserPageState,
  reloadEmbeddedBrowser,
  resumeEmbeddedBrowserDownload,
  resolveEmbeddedBrowserAgentApproval,
  setEmbeddedBrowserAgentControlPaused,
  setEmbeddedBrowserBounds,
  type EmbeddedBrowserAgentStateEvent,
  type EmbeddedBrowserDataKind,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserDownloadEvent,
  type EmbeddedBrowserInvalidTlsCertificateEvent,
  type EmbeddedBrowserOcclusionChange,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import {
  readEmbeddedBrowserDownloadSnapshot,
  subscribeEmbeddedBrowserDownloadEvents,
} from '@/lib/embedded-browser-download-store'
import { openExternalUrl } from '@/lib/external-links'
import { revealLocalFile } from '@/lib/local-terminal'
import { normalizeBrowserUrl } from '@/lib/browser-url'
import {
  embeddedBrowserOverlayMutationAffectsVisibility,
  hasEmbeddedBrowserOverlayConflict,
} from '@/lib/embedded-browser-overlay'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { BrowserAnnotationScope } from '@/types/browser-annotation'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { track } from '@/telemetry/client'
import { browserAnnotationInjectionScript as createBrowserAnnotationInjectionScript } from './browser-annotation/injection-script'
import type {
  BrowserAnnotationCommand,
  BrowserAnnotationSnapshot,
  PageAnnotationDto,
} from '@/types/browser-annotation'
import { browserSnapshotToContexts } from '@/lib/browser-annotation-context'

const EMBEDDED_BROWSER_READY_TIMEOUT_MS = 800
const EMBEDDED_BROWSER_STATE_INTERVAL_MS = 1000
const EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS = 80
const EMBEDDED_BROWSER_VISIBLE_HOST_TIMEOUT_MS = 12_000
const EMBEDDED_BROWSER_VISIBLE_HOST_INTERVAL_MS = 50
const EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS = [0, 120, 300, 600]
const BROWSER_CLEAR_STARTED_NOTICE_MIN_MS = 350
const BROWSER_ANNOTATION_LOG_PREFIX = '[Wework][BrowserAnnotation]'
const BROWSER_ANNOTATION_CLEANUP_SCRIPT = `(() => {
  try { window.__WEWORK_BROWSER_ANNOTATION__?.destroy?.(); } catch (_) {}
  document.getElementById('__wework_browser_annotation_layer__')?.remove();
  document.querySelectorAll('[data-wework-annotation]').forEach((node) => node.remove());
  return true;
})()`

export interface WorkspaceBrowserPanelProps {
  active: boolean
  label?: string
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
  onTitleChange?: (title: string | null) => void
}

export const WorkspaceBrowserPanel = WorkspaceBrowserTabPanel

type BrowserStatus = 'idle' | 'loading' | 'ready' | 'error'
type BrowserDownload = EmbeddedBrowserDownloadEvent
type BrowserAgentState = EmbeddedBrowserAgentStateEvent
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
  return Boolean(state && state.status !== 'idle')
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
  label = 'workspace-browser',
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
  onTitleChange,
}: WorkspaceBrowserPanelProps) {
  const { t } = useTranslation('common')
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const browserHostRef = useRef<HTMLDivElement | null>(null)
  const nativeBrowserOpenRef = useRef(false)
  const nativeBrowserOpeningRef = useRef(false)
  const currentUrlRef = useRef<string | null>(null)
  const activePageUrlRef = useRef<string | null>(null)
  const addressEditingRef = useRef(false)
  const annotationModeRef = useRef(false)
  const annotationCleanupPromiseRef = useRef<Promise<void> | null>(null)
  const annotationInjectionOwnerRef = useRef<number | null>(null)
  const annotationRequestGenerationRef = useRef(0)
  const currentLabelRef = useRef(label)
  const activeRef = useRef(active)
  const nativeLabelRef = useRef<string | null>(null)
  const adoptedDownloadOwnerLabelRef = useRef<string | null>(null)
  const trackedTerminalDownloadIdsRef = useRef(new Set<string>())
  const activeDownloadIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  const pageStateRequestGenerationRef = useRef(0)
  const lastAnnotationCommandSequenceRef = useRef(0)
  const annotationSnapshotRef = useRef<{ pageSessionId: string; revision: number } | null>(null)
  const handledOpenRequestIdRef = useRef<string | null>(null)
  const activeOpenRequestIdRef = useRef<string | null>(null)
  const syncBoundsTimerRef = useRef<number | null>(null)
  const syncBoundsAnimationFrameRef = useRef<number | null>(null)
  const postOpenSyncTimerRefs = useRef<number[]>([])
  const annotationEmptyPollLogCountRef = useRef(0)
  const [occludingOverlayIds, setOccludingOverlayIds] = useState<Set<string>>(() => new Set())
  const [documentOverlayOccluded, setDocumentOverlayOccluded] = useState(false)
  const [address, setAddress] = useState('')
  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [browserOpenAttempt, setBrowserOpenAttempt] = useState(0)
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<BrowserStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<PageAnnotationDto[]>([])
  const [, setAnnotationScope] = useState<BrowserAnnotationScope | null>(null)
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false)
  const [discardingAnnotations, setDiscardingAnnotations] = useState(false)
  const [downloads, setDownloads] = useState<BrowserDownload[]>([])
  const [downloadsOpen, setDownloadsOpen] = useState(false)
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
  const [invalidTlsCertificate, setInvalidTlsCertificate] =
    useState<EmbeddedBrowserInvalidTlsCertificateEvent | null>(null)
  const embeddedBrowserAvailable = canUseEmbeddedBrowser()
  const activePageUrl = pageUrl ?? currentUrl
  const internalDesktopPage = Boolean(
    activePageUrl && cloudDesktopExtension.isInternalPageUrl(activePageUrl)
  )
  const embeddedBrowserOccluded =
    occludingOverlayIds.size > 0 || (active && Boolean(currentUrl) && documentOverlayOccluded)
  const pendingCommentContextCount = Math.max(codeCommentCount, codeCommentContexts.length)

  const applyDownloadEvent = useCallback((download: EmbeddedBrowserDownloadEvent) => {
    setDownloads(current => {
      const remaining = current.filter(item => item.id !== download.id)
      if (download.status === 'deleted') return remaining
      return [download, ...remaining].slice(0, 10)
    })
    setDownloadsOpen(true)
  }, [])

  const reconcileDownloadSnapshot = useCallback(
    (nativeLabel: string) => {
      const snapshot = readEmbeddedBrowserDownloadSnapshot(nativeLabel).slice(0, 10)
      setDownloads(snapshot)
      setDownloadsOpen(snapshot.length > 0)
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
      annotationRequestGenerationRef.current += 1
    }
  }, [])

  useLayoutEffect(() => {
    currentLabelRef.current = label
    activeRef.current = active
    pageStateRequestGenerationRef.current += 1
    annotationRequestGenerationRef.current += 1
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
      if (nativeLabelRef.current && event.nativeLabel !== nativeLabelRef.current) {
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
      activePageUrlRef.current = null
      annotationModeRef.current = false
      pageStateRequestGenerationRef.current += 1
      annotationRequestGenerationRef.current += 1
      setCurrentUrl(null)
      setPageUrl(null)
      setAddress('')
      setStatus('ready')
      setError(null)
      setInvalidTlsCertificate(null)
      setAnnotationMode(false)
      setAnnotations([])
      setDownloads([])
      setDownloadsOpen(false)
      setLocalFilePreviewToast(null)
      setClearDataNotice(null)
      setClearingDataKind(null)
      setAgentState(null)
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
  }, [onDownloadActivityChange, onFaviconChange, onNativeLabelChange, onTitleChange])

  useEffect(() => {
    if (!active || !nativeLabelRef.current) return
    reconcileDownloadSnapshot(nativeLabelRef.current)
  }, [active, reconcileDownloadSnapshot])

  const updatePageUrl = useCallback(
    (url: string | null) => {
      activePageUrlRef.current = url
      setPageUrl(url)
      if (url) {
        if (!addressEditingRef.current) setAddress(url)
        onTitleChange?.(getFallbackBrowserTitle(url))
        onFaviconChange?.(getFallbackFaviconUrl(url))
        return
      }

      onTitleChange?.(null)
      onFaviconChange?.(null)
    },
    [onFaviconChange, onTitleChange]
  )

  useEffect(() => {
    const listener = listenEmbeddedBrowserPageStateChanges(pageState => {
      if (!activeRef.current || pageState.nativeLabel !== nativeLabelRef.current) return
      setInvalidTlsCertificate(pageState.invalidTlsCertificate ?? null)
      const nextUrl = pageState.url || currentUrlRef.current
      if (
        annotationModeRef.current &&
        nextUrl &&
        activePageUrlRef.current &&
        nextUrl !== activePageUrlRef.current
      ) {
        annotationSnapshotRef.current = null
        annotationRequestGenerationRef.current += 1
        annotationModeRef.current = false
        setAnnotations([])
        setAnnotationScope(null)
        setAnnotationMode(false)
        void evalEmbeddedBrowser('window.__WEWORK_BROWSER_ANNOTATION__?.suspend?.() ?? true', label)
      }
      updatePageUrl(nextUrl)
      if (nextUrl) {
        onTitleChange?.(pageState.title || getFallbackBrowserTitle(nextUrl))
        onFaviconChange?.(getFallbackFaviconUrl(nextUrl))
      }
      setStatus('ready')
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
  }, [label, onFaviconChange, onTitleChange, updatePageUrl])

  const syncEmbeddedBrowserBounds = useCallback(
    async (visible = active) => {
      if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return
      const host = browserHostRef.current
      if (!host) {
        if (!visible) {
          await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
        }
        return
      }
      const bounds = getElementBounds(host)
      if (!bounds) {
        if (!visible) {
          await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
        }
        return
      }
      await setEmbeddedBrowserBounds(bounds, visible && !embeddedBrowserOccluded, label)
    },
    [active, embeddedBrowserAvailable, embeddedBrowserOccluded, label]
  )

  const hideEmbeddedBrowser = useCallback(async () => {
    if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) return
    await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, label)
  }, [embeddedBrowserAvailable, label])

  const cleanupAnnotationLayer = useCallback((targetLabel: string) => {
    const previousCleanup = annotationCleanupPromiseRef.current ?? Promise.resolve()
    const cleanupPromise = previousCleanup
      .then(() => evalEmbeddedBrowser(BROWSER_ANNOTATION_CLEANUP_SCRIPT, targetLabel))
      .then(() => undefined)
      .catch(error => {
        console.error('Failed to close embedded browser annotation layer:', error)
      })
    annotationCleanupPromiseRef.current = cleanupPromise
    void cleanupPromise.finally(() => {
      if (annotationCleanupPromiseRef.current === cleanupPromise) {
        annotationCleanupPromiseRef.current = null
      }
    })
    return cleanupPromise
  }, [])

  const suspendAnnotationLayer = useCallback(async (targetLabel: string) => {
    try {
      await evalEmbeddedBrowser(
        'window.__WEWORK_BROWSER_ANNOTATION__?.suspend?.() ?? true',
        targetLabel
      )
    } catch (error) {
      console.error('Failed to suspend embedded browser annotation layer:', error)
    }
  }, [])

  const cleanupInvalidatedAnnotationRequest = useCallback(
    async (requestGeneration: number, targetLabel: string) => {
      if (
        !mountedRef.current ||
        currentLabelRef.current !== targetLabel ||
        annotationInjectionOwnerRef.current !== requestGeneration
      ) {
        return
      }
      annotationInjectionOwnerRef.current = null
      await cleanupAnnotationLayer(targetLabel)
    },
    [cleanupAnnotationLayer]
  )

  const exitAnnotationMode = useCallback(() => {
    logBrowserAnnotation('exit annotation mode', {
      label,
      currentUrl,
      pendingCommentContextCount,
      nativeBrowserOpen: nativeBrowserOpenRef.current,
    })
    annotationRequestGenerationRef.current += 1
    annotationModeRef.current = false
    setAnnotationMode(false)
    void suspendAnnotationLayer(label)
  }, [currentUrl, label, pendingCommentContextCount, suspendAnnotationLayer])

  const enterAnnotationMode = useCallback(async () => {
    logBrowserAnnotation('enter annotation mode requested', {
      label,
      active,
      currentUrl,
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
    const requestGeneration = annotationRequestGenerationRef.current + 1
    annotationRequestGenerationRef.current = requestGeneration
    try {
      const pendingCleanup = annotationCleanupPromiseRef.current
      if (pendingCleanup) {
        await pendingCleanup
      }
      if (
        !mountedRef.current ||
        currentLabelRef.current !== label ||
        annotationRequestGenerationRef.current !== requestGeneration
      ) {
        return
      }
      annotationInjectionOwnerRef.current = requestGeneration
      await evalEmbeddedBrowser(
        createBrowserAnnotationInjectionScript({
          browserTabId,
          uiFontSize: appearance.uiFontSize,
          strings: {
            placeholder: t('workbench.browser_annotation_placeholder'),
            publish: t('workbench.browser_annotation_publish'),
            save: t('workbench.browser_annotation_save'),
            cancel: t('workbench.cancel'),
            adjust: t('workbench.browser_annotation_adjust'),
            add: t('workbench.browser_annotation_add'),
            send: t('workbench.browser_annotation_send'),
            delete: t('workbench.browser_annotation_delete'),
            deleteTitle: t('workbench.browser_annotation_delete_title'),
            deleteDescription: t('workbench.browser_annotation_delete_description'),
            targetUnavailable: t('workbench.browser_annotation_target_unavailable'),
            resetProperty: t('workbench.browser_annotation_reset_property'),
            tweaksPlaceholder: t('workbench.browser_annotation_tweaks_placeholder'),
            selectedItems: t('workbench.browser_annotation_selected_items'),
            removeAnnotationSelection: t('workbench.browser_annotation_remove_selection'),
            comment: t('workbench.code_comment_preview_comment'),
            properties: {
              text: t('workbench.browser_annotation_adjustment_text'),
              color: t('workbench.browser_annotation_adjustment_color'),
              'background-color': t('workbench.browser_annotation_adjustment_background-color'),
              opacity: t('workbench.browser_annotation_adjustment_opacity'),
              'font-family': t('workbench.browser_annotation_adjustment_font-family'),
              'font-size': t('workbench.browser_annotation_adjustment_font-size'),
              'font-weight': t('workbench.browser_annotation_adjustment_font-weight'),
              width: t('workbench.browser_annotation_adjustment_width'),
              height: t('workbench.browser_annotation_adjustment_height'),
              padding: t('workbench.browser_annotation_adjustment_padding'),
              margin: t('workbench.browser_annotation_adjustment_margin'),
              'border-radius': t('workbench.browser_annotation_adjustment_border-radius'),
              'border-color': t('workbench.browser_annotation_adjustment_border-color'),
              'border-width': t('workbench.browser_annotation_adjustment_border-width'),
            },
          },
        }),
        label
      )
      if (
        !mountedRef.current ||
        currentLabelRef.current !== label ||
        annotationRequestGenerationRef.current !== requestGeneration
      ) {
        await cleanupInvalidatedAnnotationRequest(requestGeneration, label)
        return
      }
      if (
        activePageUrlRef.current &&
        cloudDesktopExtension.isInternalPageUrl(activePageUrlRef.current)
      ) {
        exitAnnotationMode()
        return
      }
      annotationEmptyPollLogCountRef.current = 0
      annotationModeRef.current = true
      setAnnotationMode(true)
      logBrowserAnnotation('enter annotation mode succeeded', { label, currentUrl })
    } catch (error) {
      if (
        !mountedRef.current ||
        currentLabelRef.current !== label ||
        annotationRequestGenerationRef.current !== requestGeneration
      ) {
        await cleanupInvalidatedAnnotationRequest(requestGeneration, label)
        return
      }
      annotationInjectionOwnerRef.current = null
      console.error('Failed to enter embedded browser annotation mode:', error)
      logBrowserAnnotation('enter annotation mode failed', {
        label,
        currentUrl,
        error: error instanceof Error ? error.message : String(error),
      })
      setStatus('error')
      setError(t('workbench.browser_annotation_failed'))
    }
  }, [
    active,
    appearance.uiFontSize,
    currentUrl,
    cleanupInvalidatedAnnotationRequest,
    embeddedBrowserAvailable,
    exitAnnotationMode,
    internalDesktopPage,
    label,
    browserTabId,
    t,
  ])

  useEffect(() => {
    if (
      !browserAnnotationCommand ||
      browserAnnotationCommand.sequence <= lastAnnotationCommandSequenceRef.current
    ) {
      return
    }
    lastAnnotationCommandSequenceRef.current = browserAnnotationCommand.sequence
    void evalEmbeddedBrowserJson<BrowserAnnotationSnapshot | null>(
      'window.__WEWORK_BROWSER_ANNOTATION__?.clear?.() ?? null',
      label
    )
      .then(snapshot => {
        if (!snapshot || snapshot.scope.browserTabId !== browserTabId) return
        setAnnotations(snapshot.annotations)
        setAnnotationScope(snapshot.scope)
      })
      .catch(error => {
        console.error('Failed to execute browser annotation cleanup command:', error)
      })
      .finally(exitAnnotationMode)
  }, [browserAnnotationCommand, browserTabId, exitAnnotationMode, label])

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

    let readyTimer: number | null = null
    const requestId = activeOpenRequestIdRef.current
    const openingLabel = label
    const openingUrl = currentUrl
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
          schedulePostOpenBoundsSync(activeRef.current)
          setStatus('ready')
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
        readyTimer = window.setTimeout(() => {
          if (!isAbandoned()) setStatus('ready')
        }, EMBEDDED_BROWSER_READY_TIMEOUT_MS)

        logBrowserOpenDiagnostic('native_open_started', {
          active,
          label: openingLabel,
          requestId,
          url: openingUrl,
          visible,
        })
        const pageState = visible
          ? await openEmbeddedBrowser(openingUrl, bounds, openingLabel)
          : await openEmbeddedBrowser(openingUrl, bounds, openingLabel, false, !active)
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
        updatePageUrl(pageState.url || openingUrl)
        await revealHiddenBrowser(visible)
        schedulePostOpenBoundsSync(activeRef.current)
        if (readyTimer !== null) window.clearTimeout(readyTimer)
        setStatus('ready')
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
          if (readyTimer !== null) window.clearTimeout(readyTimer)
          if (await recoverBrowserFromPageState()) return
          setStatus('error')
          setError(t('workbench.browser_open_failed'))
        }
      } finally {
        if (readyTimer !== null) window.clearTimeout(readyTimer)
        nativeBrowserOpeningRef.current = false
      }
    }

    void openWhenHostIsReady()
  }, [
    active,
    adoptNativeLabel,
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
        if (pageState.title) {
          onTitleChange?.(pageState.title)
        }
        setStatus('ready')
        schedulePostOpenBoundsSync(active)
        if (!annotationModeRef.current) {
          void suspendAnnotationLayer(label)
        }
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
    currentUrl,
    embeddedBrowserAvailable,
    label,
    onTitleChange,
    schedulePostOpenBoundsSync,
    suspendAnnotationLayer,
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

  useEffect(() => {
    if (
      !active ||
      !annotationMode ||
      internalDesktopPage ||
      !embeddedBrowserAvailable ||
      !nativeBrowserOpenRef.current
    ) {
      if (annotationMode) {
        logBrowserAnnotation('consume effect inactive', {
          label,
          active,
          annotationMode,
          embeddedBrowserAvailable,
          nativeBrowserOpen: nativeBrowserOpenRef.current,
        })
      }
      return
    }

    logBrowserAnnotation('consume effect active', {
      label,
      activePageUrl,
      hasAddCodeComment: Boolean(onAddCodeComment),
    })
    let cancelled = false

    const consumeAnnotations = async () => {
      try {
        const snapshot = await evalEmbeddedBrowserJson<BrowserAnnotationSnapshot | null>(
          'window.__WEWORK_BROWSER_ANNOTATION__?.getSnapshot?.() ?? null',
          label
        )
        if (cancelled) return
        if (!snapshot || !snapshot.scope || snapshot.scope.browserTabId !== browserTabId) {
          logBrowserAnnotation('snapshot returned invalid payload', {
            label,
            hasSnapshot: Boolean(snapshot),
          })
          return
        }
        const previousSnapshot = annotationSnapshotRef.current
        if (
          previousSnapshot?.pageSessionId === snapshot.scope.pageSessionId &&
          previousSnapshot.revision === snapshot.revision
        ) {
          if (annotationEmptyPollLogCountRef.current < 5) {
            annotationEmptyPollLogCountRef.current += 1
            logBrowserAnnotation('snapshot unchanged', {
              label,
              emptyPollCount: annotationEmptyPollLogCountRef.current,
            })
          }
          return
        }
        annotationSnapshotRef.current = {
          pageSessionId: snapshot.scope.pageSessionId,
          revision: snapshot.revision,
        }
        annotationEmptyPollLogCountRef.current = 0
        logBrowserAnnotation('snapshot returned annotations', {
          label,
          count: snapshot.annotations.length,
          revision: snapshot.revision,
          hasAddCodeComment: Boolean(onAddCodeComment),
        })
        setAnnotations(snapshot.annotations)
        setAnnotationScope(snapshot.scope)
        const contexts = browserSnapshotToContexts(
          snapshot,
          activePageUrl ? getFallbackBrowserTitle(activePageUrl) : null
        )
        if (onReplaceBrowserCodeComments) {
          onReplaceBrowserCodeComments(snapshot.scope, contexts)
        } else {
          contexts.forEach(context => onAddCodeComment?.(context))
        }
      } catch (error) {
        if (cancelled) return
        console.error('Failed to consume embedded browser annotations:', error)
        logBrowserAnnotation('consume annotations failed', {
          label,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const intervalId = window.setInterval(() => {
      void consumeAnnotations()
    }, 500)
    void consumeAnnotations()

    return () => {
      cancelled = true
      logBrowserAnnotation('consume effect cleanup', { label })
      window.clearInterval(intervalId)
    }
  }, [
    active,
    activePageUrl,
    annotationMode,
    browserTabId,
    embeddedBrowserAvailable,
    internalDesktopPage,
    label,
    onAddCodeComment,
    onReplaceBrowserCodeComments,
  ])

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
      setOccludingOverlayIds(current => {
        const next = new Set(current)
        if (expanded) {
          next.add('debug-panel')
        } else {
          next.delete('debug-panel')
        }
        return next
      })
    }

    const handleBrowserOcclusion = (event: Event) => {
      const detail = (event as CustomEvent<EmbeddedBrowserOcclusionChange>).detail
      if (!detail?.id) return

      setOccludingOverlayIds(current => {
        const next = new Set(current)
        if (detail.occluded) {
          next.add(detail.id)
        } else {
          next.delete(detail.id)
        }
        return next
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
    if (!active || !embeddedBrowserAvailable || !currentUrl) return

    let animationFrame: number | null = null
    const updateOverlayOcclusion = () => {
      animationFrame = null
      const host = browserHostRef.current
      setDocumentOverlayOccluded(Boolean(host && hasEmbeddedBrowserOverlayConflict(host)))
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

  useEffect(() => {
    void syncEmbeddedBrowserBounds(active).catch(error => {
      console.error('Failed to sync embedded browser occlusion visibility:', error)
    })
  }, [active, embeddedBrowserOccluded, syncEmbeddedBrowserBounds])

  const runBrowserCommand = useCallback(
    async (command: () => Promise<void>) => {
      if (!currentUrl) return
      try {
        await command()
        if (!(await refreshPageState())) return
        setStatus('ready')
      } catch (error) {
        console.error('Failed to control embedded browser:', error)
        setStatus('error')
        setError(t('workbench.browser_control_failed'))
      }
    },
    [currentUrl, refreshPageState, t]
  )

  const reloadCurrentUrl = useCallback(
    (url: string) => {
      if (!embeddedBrowserAvailable || !nativeBrowserOpenRef.current) {
        setCurrentUrl(null)
        window.setTimeout(() => setCurrentUrl(url), 0)
        setStatus(embeddedBrowserAvailable ? 'loading' : 'ready')
        return
      }

      if (!nativeBrowserOpenRef.current) {
        setStatus('loading')
        setError(null)
        setCurrentUrl(url)
        setBrowserOpenAttempt(attempt => attempt + 1)
        return
      }

      void runBrowserCommand(() => reloadEmbeddedBrowser(label))
    },
    [embeddedBrowserAvailable, label, runBrowserCommand]
  )

  const openBrowserUrl = useCallback(
    (rawUrl: string) => {
      const nextUrl = normalizeBrowserUrl(rawUrl, window.location.href)
      if (!nextUrl) {
        setStatus('error')
        setError(t('workbench.browser_invalid_url'))
        return
      }

      setAddress(nextUrl)
      setError(null)
      setLocalFilePreviewToast(null)
      setInvalidTlsCertificate(certificate =>
        certificate && haveSameOrigin(certificate.url, nextUrl) ? certificate : null
      )
      pageStateRequestGenerationRef.current += 1

      if (annotationMode && nextUrl !== activePageUrl) {
        exitAnnotationMode()
      }

      if (nextUrl === activePageUrl) {
        updatePageUrl(nextUrl)
        reloadCurrentUrl(nextUrl)
        return
      }

      updatePageUrl(nextUrl)

      if (embeddedBrowserAvailable && nativeBrowserOpenRef.current) {
        setStatus('loading')
        void runBrowserCommand(() => navigateEmbeddedBrowser(nextUrl, label)).then(() => {
          setCurrentUrl(nextUrl)
          track('browser_navigation_completed', { runtime: 'embedded' })
        })
        return
      }

      setCurrentUrl(nextUrl)
      setStatus(embeddedBrowserAvailable ? 'loading' : 'ready')
      track('browser_navigation_completed', { runtime: 'fallback' })
    },
    [
      activePageUrl,
      annotationMode,
      embeddedBrowserAvailable,
      exitAnnotationMode,
      label,
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
    activeOpenRequestIdRef.current = openRequest.id
    logBrowserOpenDiagnostic('request_consumed', {
      active,
      label,
      requestId: openRequest.id,
      requestLabel: openRequest.label,
      url: openRequest.url,
    })
    openBrowserUrl(openRequest.url)
  }, [active, label, openBrowserUrl, openRequest?.id, openRequest?.label, openRequest?.url])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    addressEditingRef.current = false
    const urlInput = event.currentTarget.elements.namedItem('url') as HTMLInputElement | null
    urlInput?.blur()
    openBrowserUrl(address)
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

  return (
    <div
      data-testid="workspace-browser-panel"
      data-embedded-browser-label={label}
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-background text-text-primary',
        !active && 'hidden'
      )}
    >
      {annotationMode && !internalDesktopPage ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-blue-200 bg-blue-50 px-2 text-sm text-text-primary">
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
            {t('workbench.browser_annotation_active', {
              site: activePageUrl ? getFallbackBrowserTitle(activePageUrl) : t('workbench.browser'),
            })}
          </div>
          {annotations.length > 0 ? (
            <span
              data-testid="workspace-browser-annotation-count"
              className="rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700"
            >
              {t('workbench.browser_annotation_count', { count: annotations.length })}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2">
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
              name="url"
              data-testid="workspace-browser-url-input"
              value={address}
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
              triggerClassName="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
              items={[
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
              ]}
            />
          ) : null}
        </div>
      )}
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
          void evalEmbeddedBrowserJson<BrowserAnnotationSnapshot>(
            'window.__WEWORK_BROWSER_ANNOTATION__?.clear?.() ?? null',
            label
          )
            .then(snapshot => {
              if (!snapshot) throw new Error('Annotation runtime is unavailable')
              setAnnotations(snapshot.annotations)
              setAnnotationScope(snapshot.scope)
              onRemoveBrowserCodeComments?.(snapshot.scope)
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
          {agentState?.status === 'running' ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
          ) : agentState?.status === 'paused' ? (
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
          ) : (
            <button
              type="button"
              data-testid="workspace-browser-agent-pause-button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 font-medium text-text-primary hover:bg-muted"
              onClick={() => setAgentControlPaused(true)}
            >
              <Pause className="h-3.5 w-3.5" />
              {t('workbench.browser_agent_take_control')}
            </button>
          )}
        </div>
      ) : null}
      {(!annotationMode || internalDesktopPage) && downloadsOpen ? (
        <div
          data-testid="workspace-browser-downloads-panel"
          className="flex max-h-40 shrink-0 flex-col overflow-y-auto border-b border-border bg-surface px-3 py-2"
        >
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
                        {t('workbench.browser_download_reveal')}
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
      />
      <TransientNotice
        key={clearDataNotice?.id ?? 'workspace-browser-clear-data-toast'}
        message={clearDataNotice?.message ?? null}
        tone={clearDataNotice?.tone}
        onClear={clearClearDataNotice}
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
            className="relative h-full min-h-0 w-full bg-background"
            aria-label={t('workbench.browser')}
          >
            {status === 'loading' && (
              <div
                data-testid="workspace-browser-loading"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40"
              >
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            )}
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
