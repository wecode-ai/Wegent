import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { disposeTauriListener } from '@/tauri/disposeTauriListener'
import { normalizeBrowserUrl } from './browser-url'
import { isTauriRuntime } from './runtime-environment'

export const DEFAULT_EMBEDDED_BROWSER_LABEL = 'workspace-browser'
const transferredBrowserLabels = new Set<string>()
const embeddedBrowserOpenRequestHandlers = new Set<(request: EmbeddedBrowserOpenRequest) => void>()
let embeddedBrowserOpenRequestUnlistenPromise: Promise<UnlistenFn> | null = null
let embeddedBrowserOpenRequestUnlisten: UnlistenFn | null = null
let embeddedBrowserOpenRequestReleaseTimer: ReturnType<typeof setTimeout> | null = null
let embeddedBrowserOpenRequestHandlerSequence = 1
let embeddedBrowserOpenRequestSequence = 0
export const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT = 'wework:embedded-browser-open-request'
export const EMBEDDED_BROWSER_DOWNLOAD_EVENT = 'wework:embedded-browser-download'
export const EMBEDDED_BROWSER_LOCAL_FILE_PREVIEW_EVENT =
  'wework:embedded-browser-local-file-preview'
export const EMBEDDED_BROWSER_PAGE_STATE_CHANGE_EVENT = 'wework:embedded-browser-page-state-change'
export const EMBEDDED_BROWSER_CLOSE_EVENT = 'wework:embedded-browser-close'
export const EMBEDDED_BROWSER_INVALID_TLS_CERTIFICATE_EVENT =
  'wework:embedded-browser-invalid-tls-certificate'
export const EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT = 'wework:debug-panel-visibility-change'
export const EMBEDDED_BROWSER_OCCLUSION_EVENT = 'wework:embedded-browser-occlusion-change'
export const EMBEDDED_BROWSER_AGENT_STATE_EVENT = 'wework:embedded-browser-agent-state'
export const EMBEDDED_BROWSER_POPUP_EVENT = 'wework:embedded-browser-popup'

export function browserDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return '<invalid-url>'
  }
}

export interface EmbeddedBrowserOcclusionChange {
  id: string
  occluded: boolean
}

export interface EmbeddedBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface EmbeddedBrowserPageState {
  nativeLabel: string
  title: string | null
  url: string | null
  invalidTlsCertificate?: EmbeddedBrowserInvalidTlsCertificateEvent | null
}

export interface EmbeddedBrowserOpenRequest {
  id: string
  url: string
  /** @deprecated Use baseLabel for routing. */
  label?: string
  baseLabel: string
  source: 'user' | 'agent' | 'popup' | 'restore'
  disposition: 'new-tab' | 'current-tab' | 'restore-tab'
  targetLabel?: string
  parentLabel?: string
  browserSessionId?: string
}

function logEmbeddedBrowserOpenTransport(stage: string, detail: Record<string, unknown> = {}) {
  console.info(
    '[Wework] Embedded browser open transport',
    JSON.stringify({
      stage,
      handlerCount: embeddedBrowserOpenRequestHandlers.size,
      ...detail,
    })
  )
}

export interface EmbeddedBrowserCloseRequest {
  label: string
  nativeLabel: string
}

export type EmbeddedBrowserDataKind = 'cookies' | 'cache' | 'storage'

export interface EmbeddedBrowserDownloadEvent {
  id: string
  label: string
  nativeLabel: string
  url: string
  path: string | null
  status: 'started' | 'progress' | 'paused' | 'finished' | 'failed' | 'deleted'
  receivedBytes: number | null
  totalBytes: number | null
}

export interface EmbeddedBrowserLocalFilePreviewEvent {
  label: string
  nativeLabel: string
  url: string
}

export interface EmbeddedBrowserAgentStateEvent {
  label: string
  status: 'idle' | 'running' | 'paused' | 'needs_user' | 'error'
  action: string | null
  target: string | null
  message: string | null
  errorCode: string | null
  approval: EmbeddedBrowserAgentApproval | null
  createdAtUnixMs: number
}

export interface EmbeddedBrowserAgentApproval {
  approvalId: string
  risk: string
  actionKind: string
  reason: string
  target: unknown | null
  expiresAtUnixMs: number
}

export interface EmbeddedBrowserPopupRequest {
  popupId: string
  parentLabel: string
  parentNativeLabel: string
  url: string
  origin: string
  kind: string
  strategy: string
  status: string
  createdAtUnixMs: number
  warning: string | null
}

export interface EmbeddedBrowserInvalidTlsCertificateEvent {
  nativeLabel: string
  url: string
  host: string
  port: number
}

export function listenEmbeddedBrowserInvalidTlsCertificates(
  handler: (event: EmbeddedBrowserInvalidTlsCertificateEvent) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserInvalidTlsCertificateEvent>(
    EMBEDDED_BROWSER_INVALID_TLS_CERTIFICATE_EVENT,
    event => handler(event.payload)
  )
}

export function listenEmbeddedBrowserPopupRequests(
  handler: (request: EmbeddedBrowserPopupRequest) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserPopupRequest>(EMBEDDED_BROWSER_POPUP_EVENT, event => {
    handler(event.payload)
  }).catch(error => {
    console.error('[Wework] Failed to listen for embedded browser popup requests', error)
    return () => {}
  })
}

export async function pauseEmbeddedBrowserDownload(id: string): Promise<void> {
  await invoke('embedded_browser_pause_download', { id })
}

export async function resumeEmbeddedBrowserDownload(id: string): Promise<void> {
  await invoke('embedded_browser_resume_download', { id })
}

export async function deleteEmbeddedBrowserDownload(id: string): Promise<void> {
  await invoke('embedded_browser_delete_download', { id })
}

export async function setEmbeddedBrowserAgentControlPaused(
  paused: boolean,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_set_agent_control_paused', { label, paused })
}

export async function resolveEmbeddedBrowserAgentApproval(
  approvalId: string,
  approved: boolean,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_resolve_agent_approval', { label, approvalId, approved })
}

export function listenEmbeddedBrowserDownloads(
  handler: (event: EmbeddedBrowserDownloadEvent) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserDownloadEvent>(EMBEDDED_BROWSER_DOWNLOAD_EVENT, event => {
    handler(event.payload)
  })
}

export function listenEmbeddedBrowserLocalFilePreview(
  handler: (event: EmbeddedBrowserLocalFilePreviewEvent) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserLocalFilePreviewEvent>(
    EMBEDDED_BROWSER_LOCAL_FILE_PREVIEW_EVENT,
    event => handler(event.payload)
  )
}

export function listenEmbeddedBrowserPageStateChanges(
  handler: (event: EmbeddedBrowserPageState) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserPageState>(EMBEDDED_BROWSER_PAGE_STATE_CHANGE_EVENT, event => {
    handler(event.payload)
  })
}

export function listenEmbeddedBrowserCloseRequests(
  handler: (event: EmbeddedBrowserCloseRequest) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserCloseRequest>(EMBEDDED_BROWSER_CLOSE_EVENT, event =>
    handler(event.payload)
  )
}

export function listenEmbeddedBrowserAgentState(
  handler: (event: EmbeddedBrowserAgentStateEvent) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) return null
  return listen<EmbeddedBrowserAgentStateEvent>(EMBEDDED_BROWSER_AGENT_STATE_EVENT, event => {
    handler(event.payload)
  })
}

interface EmbeddedBrowserEvalResult {
  ok?: boolean
  value?: unknown
  error?: string
}

export function canUseEmbeddedBrowser(): boolean {
  return isTauriRuntime()
}

export function setEmbeddedBrowserOcclusion(id: string, occluded: boolean): void {
  window.dispatchEvent(
    new CustomEvent<EmbeddedBrowserOcclusionChange>(EMBEDDED_BROWSER_OCCLUSION_EVENT, {
      detail: { id, occluded },
    })
  )
}

function browserArgs(label = DEFAULT_EMBEDDED_BROWSER_LABEL) {
  return { label }
}

export function markEmbeddedBrowserLabelTransferred(label = DEFAULT_EMBEDDED_BROWSER_LABEL): void {
  transferredBrowserLabels.add(label)
}

export function isEmbeddedBrowserLabelTransferred(label = DEFAULT_EMBEDDED_BROWSER_LABEL): boolean {
  return transferredBrowserLabels.has(label)
}

export function consumeEmbeddedBrowserLabelTransfer(
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): boolean {
  if (!transferredBrowserLabels.has(label)) return false
  transferredBrowserLabels.delete(label)
  return true
}

export async function openEmbeddedBrowser(
  url: string,
  bounds: EmbeddedBrowserBounds,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL,
  visible = true,
  readyWhenHidden = true
): Promise<EmbeddedBrowserPageState> {
  return invoke<EmbeddedBrowserPageState>('embedded_browser_open', {
    ...browserArgs(label),
    url,
    bounds,
    visible,
    readyWhenHidden,
  })
}

export async function setEmbeddedBrowserBounds(
  bounds: EmbeddedBrowserBounds,
  visible: boolean,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL,
  readyWhenHidden = false
): Promise<void> {
  await invoke('embedded_browser_set_bounds', {
    ...browserArgs(label),
    bounds,
    visible,
    readyWhenHidden,
  })
}

export async function navigateEmbeddedBrowser(
  url: string,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_navigate', {
    ...browserArgs(label),
    url,
  })
}

export async function reloadEmbeddedBrowser(label = DEFAULT_EMBEDDED_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_reload', browserArgs(label))
}

export async function goBackEmbeddedBrowser(label = DEFAULT_EMBEDDED_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_go_back', browserArgs(label))
}

export async function goForwardEmbeddedBrowser(
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_go_forward', browserArgs(label))
}

export async function evalEmbeddedBrowser(
  script: string,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_eval', {
    ...browserArgs(label),
    script,
  })
}

export async function evalEmbeddedBrowserJson<T = unknown>(
  expression: string,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<T> {
  const result = await invoke<EmbeddedBrowserEvalResult | T>('embedded_browser_eval_json', {
    ...browserArgs(label),
    expression,
  })
  if (isEmbeddedBrowserEvalResult(result)) {
    if (result.ok === false) {
      throw new Error(result.error || 'Embedded browser evaluation failed')
    }
    return result.value as T
  }
  return result as T
}

function isEmbeddedBrowserEvalResult(value: unknown): value is EmbeddedBrowserEvalResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as EmbeddedBrowserEvalResult).ok === 'boolean'
  )
}

export async function readEmbeddedBrowserPageState(
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<EmbeddedBrowserPageState> {
  return invoke<EmbeddedBrowserPageState>('embedded_browser_page_state', browserArgs(label))
}

export async function relabelEmbeddedBrowser(
  fromLabel: string,
  toLabel = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_relabel', {
    fromLabel,
    toLabel,
  })
}

export async function setEmbeddedBrowserActiveTab(
  baseLabel: string,
  activeTabLabel: string
): Promise<void> {
  await invoke('embedded_browser_set_active_tab', { baseLabel, activeTabLabel })
}

export async function closeEmbeddedBrowser(
  label = DEFAULT_EMBEDDED_BROWSER_LABEL,
  expectedNativeLabel?: string
): Promise<void> {
  await invoke('embedded_browser_close', {
    ...browserArgs(label),
    expectedNativeLabel: expectedNativeLabel ?? null,
  })
}

export async function closeEmbeddedBrowsers(labels: string[]): Promise<void> {
  if (labels.length === 0) return
  await invoke('embedded_browser_close_many', { labels })
}

export async function clearEmbeddedBrowserData(kinds?: EmbeddedBrowserDataKind[]): Promise<number> {
  return invoke<number>('embedded_browser_clear_data', { dataKinds: kinds ?? null })
}

export function requestEmbeddedBrowserOpen(
  url: string,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): boolean {
  if (!canUseEmbeddedBrowser() || embeddedBrowserOpenRequestHandlers.size === 0) {
    return false
  }

  const normalizedUrl = normalizeBrowserUrl(url, window.location.href)
  if (!normalizedUrl) return false

  const requestId =
    globalThis.crypto?.randomUUID?.() ?? `user-${++embeddedBrowserOpenRequestSequence}`

  const request: EmbeddedBrowserOpenRequest = {
    id: requestId,
    url: normalizedUrl,
    label,
    baseLabel: label,
    source: 'user',
    disposition: 'new-tab',
  }
  embeddedBrowserOpenRequestHandlers.forEach(handler => handler(request))
  return true
}

export function listenEmbeddedBrowserOpenRequests(
  handler: (request: EmbeddedBrowserOpenRequest) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) {
    return null
  }

  if (embeddedBrowserOpenRequestReleaseTimer !== null) {
    clearTimeout(embeddedBrowserOpenRequestReleaseTimer)
    embeddedBrowserOpenRequestReleaseTimer = null
    logEmbeddedBrowserOpenTransport('native_listener_release_cancelled')
  }

  const handlerId = embeddedBrowserOpenRequestHandlerSequence++
  embeddedBrowserOpenRequestHandlers.add(handler)
  logEmbeddedBrowserOpenTransport('handler_registered', { handlerId })

  if (!embeddedBrowserOpenRequestUnlistenPromise) {
    logEmbeddedBrowserOpenTransport('native_listener_registering', { handlerId })
    embeddedBrowserOpenRequestUnlistenPromise = listen<EmbeddedBrowserOpenRequest>(
      EMBEDDED_BROWSER_OPEN_REQUEST_EVENT,
      event => {
        logEmbeddedBrowserOpenTransport('native_event_received', {
          requestId: event.payload.id,
          label: event.payload.label,
          url: event.payload.url,
        })
        embeddedBrowserOpenRequestHandlers.forEach(currentHandler => currentHandler(event.payload))
      }
    )
      .then(unlisten => {
        embeddedBrowserOpenRequestUnlisten = unlisten
        logEmbeddedBrowserOpenTransport('native_listener_registered', { handlerId })
        if (
          embeddedBrowserOpenRequestHandlers.size === 0 &&
          embeddedBrowserOpenRequestReleaseTimer === null
        ) {
          embeddedBrowserOpenRequestUnlisten?.()
          embeddedBrowserOpenRequestUnlisten = null
          embeddedBrowserOpenRequestUnlistenPromise = null
          logEmbeddedBrowserOpenTransport('native_listener_released_after_registration', {
            handlerId,
          })
        }
        return unlisten
      })
      .catch(error => {
        embeddedBrowserOpenRequestUnlistenPromise = null
        console.error('[Wework] Failed to listen for embedded browser open requests', error)
        return () => {}
      })
  }

  void embeddedBrowserOpenRequestUnlistenPromise
    .then(() => invoke<EmbeddedBrowserOpenRequest[]>('embedded_browser_pending_open_requests'))
    .then(requests => {
      logEmbeddedBrowserOpenTransport('pending_snapshot_received', {
        handlerId,
        requests: requests.map(request => ({
          requestId: request.id,
          label: request.label,
        })),
      })
      requests.forEach(request => {
        logEmbeddedBrowserOpenTransport('pending_request_dispatched', {
          handlerId,
          requestId: request.id,
          label: request.label,
        })
        handler(request)
      })
    })
    .catch(error => {
      console.error('[Wework] Failed to recover embedded browser open requests', error)
    })

  return Promise.resolve(() => {
    embeddedBrowserOpenRequestHandlers.delete(handler)
    logEmbeddedBrowserOpenTransport('handler_unregistered', { handlerId })
    if (embeddedBrowserOpenRequestHandlers.size > 0) return
    if (embeddedBrowserOpenRequestReleaseTimer !== null) return

    logEmbeddedBrowserOpenTransport('native_listener_release_scheduled', { handlerId })
    embeddedBrowserOpenRequestReleaseTimer = setTimeout(() => {
      embeddedBrowserOpenRequestReleaseTimer = null
      if (embeddedBrowserOpenRequestHandlers.size > 0) {
        logEmbeddedBrowserOpenTransport('native_listener_release_skipped', { handlerId })
        return
      }

      const currentUnlisten = embeddedBrowserOpenRequestUnlisten
      const pendingUnlisten = embeddedBrowserOpenRequestUnlistenPromise
      embeddedBrowserOpenRequestUnlisten = null
      embeddedBrowserOpenRequestUnlistenPromise = null
      if (currentUnlisten) {
        disposeTauriListener(currentUnlisten, 'embedded browser open request')
        logEmbeddedBrowserOpenTransport('native_listener_released', { handlerId })
        return
      }
      if (pendingUnlisten) {
        void pendingUnlisten.then(unlisten => {
          disposeTauriListener(unlisten, 'embedded browser pending open request')
          logEmbeddedBrowserOpenTransport('pending_native_listener_released', { handlerId })
        })
      }
    }, 1000)
  })
}
