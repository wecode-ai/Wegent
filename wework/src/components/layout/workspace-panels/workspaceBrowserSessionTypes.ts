import {
  type EmbeddedBrowserAgentStateEvent,
  type EmbeddedBrowserAnnotationRequest,
  type EmbeddedBrowserAgentCursorEvent,
  type EmbeddedBrowserDataKind,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserDownloadEvent,
  type EmbeddedBrowserInvalidTlsCertificateEvent,
  type EmbeddedBrowserNavigationError,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { browserDiagnosticOrigin } from '@/lib/browser-url'
import { BROWSER_ZOOM_DEFAULT_PERCENT } from '@/lib/browser-zoom'
import {
  defaultBrowserDeviceToolbarState,
  type BrowserDeviceResizeEdge,
  type BrowserDeviceToolbarState,
} from '@/lib/browser-device-toolbar'
import { type BrowserFindState } from './browser-find/browser-find-store'
import type { CodeCommentContext } from '@/types/workspace-files'
import type { BrowserAnnotationComment, BrowserAnnotationScope } from '@/types/browser-annotation'
import type { BrowserAnnotationCommand } from '@/types/browser-annotation'
import type { TFunction } from 'i18next'
import type { GeometrySnapshot } from '@wegent/collaboration/dom-events'
import type { createBrowserNavigation } from './workspaceBrowserNavigation'
import type { createBrowserViewport } from './workspaceBrowserViewport'
import type { createBrowserAnnotations } from './workspaceBrowserAnnotations'
import type { createBrowserActions } from './workspaceBrowserActions'
export const EMBEDDED_BROWSER_STATE_INTERVAL_MS = 1000
export const EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS = 80
export const EMBEDDED_BROWSER_VISIBLE_HOST_TIMEOUT_MS = 12_000
export const EMBEDDED_BROWSER_VISIBLE_HOST_INTERVAL_MS = 50
export const EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS = [0, 120, 300, 600]
export const BROWSER_CLEAR_STARTED_NOTICE_MIN_MS = 600
export const DOWNLOAD_PEEK_DURATION_MS = 8000
export const BROWSER_ANNOTATION_LOG_PREFIX = '[Wework][BrowserAnnotation]'
export interface BrowserOcclusionState {
  documentOverlayOccluded: boolean
  generation: number
  overlayIds: Set<string>
}
export interface AnnotationEntry {
  mode?: EmbeddedBrowserAnnotationRequest['mode']
  point?: { x: number; y: number }
}
export type BrowserOcclusionAction =
  | { id: string; occluded: boolean; type: 'overlay' }
  | { occluded: boolean; type: 'document' }
export function isBrowserOccluded(state: BrowserOcclusionState): boolean {
  return state.overlayIds.size > 0 || state.documentOverlayOccluded
}
export function browserOcclusionReducer(
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
export type BrowserStatus = 'idle' | 'loading' | 'ready' | 'error'
export type BrowserDownload = EmbeddedBrowserDownloadEvent
export type BrowserAgentState = EmbeddedBrowserAgentStateEvent
export type BrowserAgentCursor = EmbeddedBrowserAgentCursorEvent
export type BrowserOpenDiagnosticStage =
  | 'request_consumed'
  | 'host_ready'
  | 'host_waiting'
  | 'host_visible'
  | 'native_open_started'
  | 'native_open_succeeded'
  | 'native_open_failed'
  | 'lifecycle_cancelled'
export function logBrowserAnnotation(message: string, data?: Record<string, unknown>) {
  console.info(BROWSER_ANNOTATION_LOG_PREFIX, message, data ?? {})
}
export function getFallbackBrowserTitle(url: string) {
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
export function getFallbackFaviconUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol === 'file:') return null
    return new URL('/favicon.ico', parsedUrl).toString()
  } catch {
    return null
  }
}
export function haveSameOrigin(leftUrl: string, rightUrl: string) {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin
  } catch {
    return false
  }
}
export function formatDownloadBytes(bytes: number | null) {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}
export function shouldShowAgentState(state: BrowserAgentState | null) {
  return Boolean(state && ['paused', 'needs_user', 'error'].includes(state.status))
}
export function getElementBounds(element: HTMLElement): EmbeddedBrowserBounds | null {
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }
}
export async function waitForVisibleBrowserHost(
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
export function logBrowserOpenDiagnostic(
  stage: BrowserOpenDiagnosticStage,
  detail: Record<string, unknown>
) {
  console.info(
    '[Wework] Embedded browser open diagnostic',
    JSON.stringify({
      stage,
      ...detail,
      url: typeof detail.url === 'string' ? browserDiagnosticOrigin(detail.url) : null,
    })
  )
}
export interface BrowserSessionState {
  browserOcclusion: BrowserOcclusionState
  occlusionSnapshot: {
    generation: number
    url: string
  } | null
  occlusionCaptureRetry: number
  address: string
  currentUrl: string | null
  browserOpenAttempt: number
  pageUrl: string | null
  status: BrowserStatus
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  navigationError: EmbeddedBrowserNavigationError | null
  annotationMode: boolean
  annotations: BrowserAnnotationComment[]
  annotationRevision: number
  annotationRuntimeRevision: number
  annotationOriginalView: boolean
  discardDialogOpen: boolean
  discardingAnnotations: boolean
  originalViewHeld: boolean
  downloads: BrowserDownload[]
  downloadsOpen: boolean
  downloadPeek: {
    id: string
    fileName: string
    path: string | null
    status: 'finished' | 'failed'
  } | null
  localFilePreviewToast: {
    id: number
    message: string
  } | null
  clearDataNotice: {
    id: number
    message: string
    tone: 'success' | 'error'
  } | null
  clearingDataKind: EmbeddedBrowserDataKind | null
  agentState: BrowserAgentState | null
  agentCursor: BrowserAgentCursor | null
  invalidTlsCertificate: EmbeddedBrowserInvalidTlsCertificateEvent | null
  zoomPercent: number
  findOpen: boolean
  findQuery: string
  findResult: BrowserFindState | null
  findUnavailable: boolean
  deviceToolbar: BrowserDeviceToolbarState
  deviceVisualRect: {
    x: number
    y: number
    width: number
    height: number
    hostWidth: number
    hostHeight: number
  } | null
}
export interface BrowserSessionRuntime {
  nativeGeneration: number
  nativeBrowserOpen: boolean
  nativeBrowserOpening: boolean
  pendingNavigationUrl: string | null
  addressEditing: boolean
  nativeLabel: string | null
  adoptedDownloadOwnerLabel: string | null
  trackedTerminalDownloadIds: Set<string>
  activeDownloadIds: Set<string>
  pageStateRequestGeneration: number
  lastAnnotationCommandSequence: number
  handledOpenRequestId: string | null
  activeOpenRequestId: string | null
  syncBoundsTimer: number | null
  syncBoundsAnimationFrame: number | null
  postOpenSyncTimer: number[]
  occlusionSnapshotInFlight: boolean
  occlusionSnapshotReady: boolean
  occlusionSnapshotFallbackTimer: number | null
  annotationStateVersion: {
    pageSessionId: string | null
    revision: number
    runtimeRevision: number
  }
  deviceFitScale: number
  browserBoundsSyncGeneration: number
  findRequestSequence: number
  findPageUrl: string | null
  deviceResizeState: {
    pointerId: number
    edge: BrowserDeviceResizeEdge
    startX: number
    startY: number
    startWidth: number
    startHeight: number
  } | null
}
export interface BrowserSessionOptions extends WorkspaceBrowserPanelProps {
  label: string
  browserTabId: string
  codeCommentCount: number
  codeCommentContexts: CodeCommentContext[]
  t: TFunction
  geometry: GeometrySnapshot | null
}
export interface BrowserSessionDom {
  readonly host: HTMLDivElement | null
  readonly addressInput: HTMLInputElement | null
}
export type BrowserStateUpdate<K extends keyof BrowserSessionState> =
  | BrowserSessionState[K]
  | ((current: BrowserSessionState[K]) => BrowserSessionState[K])
export type BrowserSessionActions = ReturnType<typeof createBrowserNavigation> &
  ReturnType<typeof createBrowserViewport> &
  ReturnType<typeof createBrowserAnnotations> &
  ReturnType<typeof createBrowserActions>
export interface BrowserSessionModel {
  state: BrowserSessionState
  options: BrowserSessionOptions
  runtime: BrowserSessionRuntime
  dom: BrowserSessionDom
  observed: boolean
  actions: BrowserSessionActions
  electronRuntime: boolean
  embeddedBrowserAvailable: boolean
  activePageUrl: string | null
  internalExtensionPage: boolean
  embeddedBrowserOccluded: boolean
  pendingCommentContextCount: number
  hasQueuedTweaks: boolean
  originalViewEnabled: boolean
  canUsePageFind: boolean
  set: <K extends keyof BrowserSessionState>(
    key: K,
    value: BrowserSessionState[K] | ((current: BrowserSessionState[K]) => BrowserSessionState[K])
  ) => void
  dispatchOcclusion: (action: BrowserOcclusionAction) => void
}
export function createBrowserSessionInitial(options: BrowserSessionOptions) {
  const { label, transferFromLabel, transferredUrl, transferredNativeLabel } = options
  const initialTransferredUrl = transferFromLabel ? (transferredUrl ?? null) : null
  const state: BrowserSessionState = {
    browserOcclusion: {
      documentOverlayOccluded: false,
      generation: 0,
      overlayIds: new Set<string>(),
    },
    occlusionSnapshot: null,
    occlusionCaptureRetry: 0,
    address: initialTransferredUrl ?? '',
    currentUrl: initialTransferredUrl,
    browserOpenAttempt: 0,
    pageUrl: initialTransferredUrl,
    status: initialTransferredUrl ? 'ready' : 'idle',
    canGoBack: false,
    canGoForward: false,
    error: null,
    navigationError: null,
    annotationMode: false,
    annotations: [],
    annotationRevision: 0,
    annotationRuntimeRevision: 0,
    annotationOriginalView: false,
    discardDialogOpen: false,
    discardingAnnotations: false,
    originalViewHeld: false,
    downloads: [],
    downloadsOpen: false,
    downloadPeek: null,
    localFilePreviewToast: null,
    clearDataNotice: null,
    clearingDataKind: null,
    agentState: null,
    agentCursor: null,
    invalidTlsCertificate: null,
    zoomPercent: BROWSER_ZOOM_DEFAULT_PERCENT,
    findOpen: false,
    findQuery: '',
    findResult: null,
    findUnavailable: false,
    deviceToolbar: defaultBrowserDeviceToolbarState(),
    deviceVisualRect: null,
  }
  const runtime: BrowserSessionRuntime = {
    nativeGeneration: 0,
    nativeBrowserOpen: Boolean(initialTransferredUrl),
    nativeBrowserOpening: false,
    pendingNavigationUrl: null,
    addressEditing: false,
    nativeLabel: initialTransferredUrl ? (transferredNativeLabel ?? null) : null,
    adoptedDownloadOwnerLabel: initialTransferredUrl && transferredNativeLabel ? label : null,
    trackedTerminalDownloadIds: new Set<string>(),
    activeDownloadIds: new Set<string>(),
    pageStateRequestGeneration: 0,
    lastAnnotationCommandSequence: 0,
    handledOpenRequestId: null,
    activeOpenRequestId: null,
    syncBoundsTimer: null,
    syncBoundsAnimationFrame: null,
    postOpenSyncTimer: [],
    occlusionSnapshotInFlight: false,
    occlusionSnapshotReady: true,
    occlusionSnapshotFallbackTimer: null,
    annotationStateVersion: { pageSessionId: null, revision: -1, runtimeRevision: -1 },
    deviceFitScale: 1,
    browserBoundsSyncGeneration: 0,
    findRequestSequence: 0,
    findPageUrl: null,
    deviceResizeState: null,
  }
  return { state, runtime }
}
