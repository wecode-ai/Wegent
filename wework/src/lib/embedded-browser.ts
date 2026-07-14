import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from './runtime-environment'

export const DEFAULT_EMBEDDED_BROWSER_LABEL = 'workspace-browser'
const transferredBrowserLabels = new Set<string>()
const embeddedBrowserOpenRequestHandlers = new Set<(request: EmbeddedBrowserOpenRequest) => void>()
let embeddedBrowserOpenRequestUnlistenPromise: Promise<UnlistenFn> | null = null
let embeddedBrowserOpenRequestUnlisten: UnlistenFn | null = null
let embeddedBrowserOpenRequestReleaseTimer: ReturnType<typeof setTimeout> | null = null
export const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT = 'wework:embedded-browser-open-request'
export const EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT = 'wework:debug-panel-visibility-change'
export const EMBEDDED_BROWSER_OCCLUSION_EVENT = 'wework:embedded-browser-occlusion-change'

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
  title: string | null
  url: string | null
}

export interface EmbeddedBrowserOpenRequest {
  url: string
  label: string
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
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<EmbeddedBrowserPageState> {
  return invoke<EmbeddedBrowserPageState>('embedded_browser_open', {
    ...browserArgs(label),
    url,
    bounds,
  })
}

export async function setEmbeddedBrowserBounds(
  bounds: EmbeddedBrowserBounds,
  visible: boolean,
  label = DEFAULT_EMBEDDED_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_set_bounds', {
    ...browserArgs(label),
    bounds,
    visible,
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

export async function closeEmbeddedBrowser(label = DEFAULT_EMBEDDED_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_close', browserArgs(label))
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
  }

  embeddedBrowserOpenRequestHandlers.add(handler)

  if (!embeddedBrowserOpenRequestUnlistenPromise) {
    embeddedBrowserOpenRequestUnlistenPromise = listen<EmbeddedBrowserOpenRequest>(
      EMBEDDED_BROWSER_OPEN_REQUEST_EVENT,
      event => {
        embeddedBrowserOpenRequestHandlers.forEach(currentHandler => currentHandler(event.payload))
      }
    )
      .then(unlisten => {
        embeddedBrowserOpenRequestUnlisten = unlisten
        if (
          embeddedBrowserOpenRequestHandlers.size === 0 &&
          embeddedBrowserOpenRequestReleaseTimer === null
        ) {
          embeddedBrowserOpenRequestUnlisten?.()
          embeddedBrowserOpenRequestUnlisten = null
          embeddedBrowserOpenRequestUnlistenPromise = null
        }
        return unlisten
      })
      .catch(error => {
        embeddedBrowserOpenRequestUnlistenPromise = null
        console.error('[Wework] Failed to listen for embedded browser open requests', error)
        return () => {}
      })
  }

  return Promise.resolve(() => {
    embeddedBrowserOpenRequestHandlers.delete(handler)
    if (embeddedBrowserOpenRequestHandlers.size > 0) return
    if (embeddedBrowserOpenRequestReleaseTimer !== null) return

    embeddedBrowserOpenRequestReleaseTimer = setTimeout(() => {
      embeddedBrowserOpenRequestReleaseTimer = null
      if (embeddedBrowserOpenRequestHandlers.size > 0) return

      const currentUnlisten = embeddedBrowserOpenRequestUnlisten
      const pendingUnlisten = embeddedBrowserOpenRequestUnlistenPromise
      embeddedBrowserOpenRequestUnlisten = null
      embeddedBrowserOpenRequestUnlistenPromise = null
      if (currentUnlisten) {
        currentUnlisten()
        return
      }
      if (pendingUnlisten) {
        void pendingUnlisten.then(unlisten => unlisten())
      }
    }, 1000)
  })
}
