import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from './runtime-environment'

const DEFAULT_BROWSER_LABEL = 'workspace-browser'
const transferredBrowserLabels = new Set<string>()
export const EMBEDDED_BROWSER_OPEN_REQUEST_EVENT = 'wework:embedded-browser-open-request'
export const EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT = 'wework:debug-panel-visibility-change'

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

function browserArgs(label = DEFAULT_BROWSER_LABEL) {
  return { label }
}

export function markEmbeddedBrowserLabelTransferred(label = DEFAULT_BROWSER_LABEL): void {
  transferredBrowserLabels.add(label)
}

export function consumeEmbeddedBrowserLabelTransfer(label = DEFAULT_BROWSER_LABEL): boolean {
  if (!transferredBrowserLabels.has(label)) return false
  transferredBrowserLabels.delete(label)
  return true
}

export async function openEmbeddedBrowser(
  url: string,
  bounds: EmbeddedBrowserBounds,
  label = DEFAULT_BROWSER_LABEL
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
  label = DEFAULT_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_set_bounds', {
    ...browserArgs(label),
    bounds,
    visible,
  })
}

export async function navigateEmbeddedBrowser(
  url: string,
  label = DEFAULT_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_navigate', {
    ...browserArgs(label),
    url,
  })
}

export async function reloadEmbeddedBrowser(label = DEFAULT_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_reload', browserArgs(label))
}

export async function goBackEmbeddedBrowser(label = DEFAULT_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_go_back', browserArgs(label))
}

export async function goForwardEmbeddedBrowser(label = DEFAULT_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_go_forward', browserArgs(label))
}

export async function evalEmbeddedBrowser(
  script: string,
  label = DEFAULT_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_eval', {
    ...browserArgs(label),
    script,
  })
}

export async function evalEmbeddedBrowserJson<T = unknown>(
  expression: string,
  label = DEFAULT_BROWSER_LABEL
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
  label = DEFAULT_BROWSER_LABEL
): Promise<EmbeddedBrowserPageState> {
  return invoke<EmbeddedBrowserPageState>('embedded_browser_page_state', browserArgs(label))
}

export async function relabelEmbeddedBrowser(
  fromLabel: string,
  toLabel = DEFAULT_BROWSER_LABEL
): Promise<void> {
  await invoke('embedded_browser_relabel', {
    fromLabel,
    toLabel,
  })
}

export async function closeEmbeddedBrowser(label = DEFAULT_BROWSER_LABEL): Promise<void> {
  await invoke('embedded_browser_close', browserArgs(label))
}

export function listenEmbeddedBrowserOpenRequests(
  handler: (request: EmbeddedBrowserOpenRequest) => void
): Promise<UnlistenFn> | null {
  if (!canUseEmbeddedBrowser()) {
    return null
  }

  return listen<EmbeddedBrowserOpenRequest>(EMBEDDED_BROWSER_OPEN_REQUEST_EVENT, event => {
    handler(event.payload)
  }).catch(error => {
    console.error('[Wework] Failed to listen for embedded browser open requests', error)
    return () => {}
  })
}
