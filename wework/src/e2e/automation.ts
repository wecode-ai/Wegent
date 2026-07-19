import { getRuntimeConfig, joinAppPath, stripAppBasePath } from '@/config/runtime'
import { removeToken, setToken } from '@/api/auth'
import {
  testLocalModelConnection,
  type TestLocalModelConnectionInput,
  type TestLocalModelConnectionResult,
} from '@/features/model-settings/localModelConnectionTest'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { closeMainWindowToTray } from '@/tauri/runtimeTaskCloseGuard'
import {
  normalizeCloudBackendUrl,
  saveStoredCloudConnection,
} from '@/features/cloud-connection/cloudConnectionStorage'
import {
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { invoke } from '@tauri-apps/api/core'

const DEFAULT_WAIT_TIMEOUT_MS = 5000
const LOCAL_MODEL_SEND_CIRCUIT_BREAKER_ERROR = 'WEWORK_E2E_LOCAL_MODEL_SEND_CIRCUIT_OPEN'
const DESKTOP_CONTROL_RETRY_DELAY_MS = 250
const DESKTOP_CONTROL_IDLE_POLL_DELAY_MS = 50

type DesktopControlAction =
  | 'capture'
  | 'click'
  | 'clickWhenEnabled'
  | 'closeMainWindowToTray'
  | 'dispatchLocalModelSettingsChanged'
  | 'fill'
  | 'getText'
  | 'hover'
  | 'pointerMove'
  | 'snapshot'
  | 'waitFor'
  | 'press'
  | 'selectText'

interface DesktopControlCommand {
  id: string
  action: DesktopControlAction
  selector: string
  value?: string
  target?: string
  text?: string
  timeoutMs?: number
  enabled?: boolean
  visible?: boolean
  stableMs?: number
  key?: string
}

interface DesktopControlResult {
  id: string
  ok: boolean
  value?: string
  error?: string
}

export interface WeworkAutomationBridge {
  version: 1
  isEnabled: true
  isTauri: () => boolean
  getRuntimeConfig: () => ReturnType<typeof getRuntimeConfig>
  getRoute: () => string
  navigate: (path: string) => string
  waitForTestId: (testId: string, options?: { timeoutMs?: number }) => Promise<boolean>
  queryTestIds: (prefix?: string) => string[]
  setAuthToken: (token: string) => void
  clearAuthToken: () => void
  clearStorage: () => void
  testLocalModelConnection: (
    input: TestLocalModelConnectionInput
  ) => Promise<TestLocalModelConnectionResult>
  tripLocalModelConnectionCircuitBreaker: (
    input: TestLocalModelConnectionInput
  ) => Promise<TestLocalModelConnectionResult>
}

declare global {
  interface Window {
    __WEWORK_E2E__?: WeworkAutomationBridge
  }
}

export function isWeworkAutomationEnabled(): boolean {
  return import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
}

export function shouldUseNativeProjectDirectoryPicker(): boolean {
  return (
    !isWeworkAutomationEnabled() ||
    import.meta.env.VITE_WEWORK_E2E_NATIVE_DIRECTORY_PICKER === 'true'
  )
}

function desktopControlUrl(): string | null {
  const value = import.meta.env.VITE_WEWORK_DESKTOP_E2E_CONTROL_URL?.trim()
  return value ? value.replace(/\/+$/, '') : null
}

function desktopControlHeaders(): HeadersInit | undefined {
  const token = import.meta.env.VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN?.trim()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

function normalizeAppPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function dispatchNavigationEvents() {
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new CustomEvent('wework:e2e:navigation'))
}

function hasTestId(testId: string): boolean {
  return document.querySelector(`[data-testid="${CSS.escape(testId)}"]`) !== null
}

function waitForTestId(testId: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<boolean> {
  if (hasTestId(testId)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error(`Timed out waiting for data-testid="${testId}"`))
    }, timeoutMs)

    const observer = new MutationObserver(() => {
      if (!hasTestId(testId)) {
        return
      }

      window.clearTimeout(timeout)
      observer.disconnect()
      resolve(true)
    })

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
    })
  })
}

function queryTestIds(prefix?: string): string[] {
  const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
  const values = elements
    .map(element => element.dataset.testid)
    .filter((value): value is string => Boolean(value))

  return Array.from(
    new Set(prefix ? values.filter(value => value.startsWith(prefix)) : values)
  ).sort()
}

function createLocalModelCircuitBreakerFetcher(): typeof fetch {
  return (async () => {
    throw new Error(LOCAL_MODEL_SEND_CIRCUIT_BREAKER_ERROR)
  }) as typeof fetch
}

function createBridge(): WeworkAutomationBridge {
  return {
    version: 1,
    isEnabled: true,
    isTauri: isTauriRuntime,
    getRuntimeConfig,
    getRoute: () => stripAppBasePath(window.location.pathname),
    navigate: path => {
      const appPath = normalizeAppPath(path)
      const nextPath = joinAppPath(getRuntimeConfig().appBasePath, appPath)
      window.history.pushState(null, '', nextPath)
      dispatchNavigationEvents()
      return stripAppBasePath(window.location.pathname)
    },
    waitForTestId: (testId, options) => waitForTestId(testId, options?.timeoutMs),
    queryTestIds,
    setAuthToken: setToken,
    clearAuthToken: removeToken,
    clearStorage: () => {
      removeToken()
      localStorage.clear()
      sessionStorage.clear()
    },
    testLocalModelConnection,
    tripLocalModelConnectionCircuitBreaker: input =>
      testLocalModelConnection(input, {
        fetcher: createLocalModelCircuitBreakerFetcher(),
        timeoutMs: 1000,
      }),
  }
}

function seedDesktopE2ECloudConnection() {
  const backendUrl = import.meta.env.VITE_WEWORK_E2E_CLOUD_BACKEND_URL?.trim()
  if (!backendUrl) return

  const config = normalizeCloudBackendUrl(backendUrl)
  saveStoredCloudConnection({
    ...config,
    token: 'wework-desktop-e2e-cloud-token',
    tokenExpiresAt: null,
    user: {
      id: 9001,
      user_name: 'wework-desktop-e2e-cloud-user',
      email: 'desktop-e2e@wework.local',
    },
    connectedAt: new Date().toISOString(),
  })
  saveLocalModelConfig({
    id: 'desktop-e2e-local',
    displayName: 'Desktop E2E Local',
    modelId: 'desktop-e2e-local-model',
    baseUrl: backendUrl,
    enabled: true,
  })
}

export function installWeworkAutomationBridge() {
  if (!isWeworkAutomationEnabled() || typeof window === 'undefined') {
    return
  }

  seedDesktopE2ECloudConnection()
  window.__WEWORK_E2E__ = createBridge()
  installDesktopControlClient()
}

function findDesktopControlElements(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
}

function desktopControlElementText(selector: string): string {
  return findDesktopControlElements(selector)
    .map(element => element.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('\n')
}

function desktopControlSnapshot(): string {
  const testIds = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'))
    .map(element => element.dataset.testid)
    .filter((testId): testId is string => Boolean(testId))

  return JSON.stringify({
    location: window.location.href,
    text: document.body.innerText,
    testIds: Array.from(new Set(testIds)).sort(),
  })
}

async function captureDesktopControlScreenshot(selector: string): Promise<string> {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)

  const snapshot = await invoke<string>('capture_main_webview')
  if (element === document.body) return snapshot
  return cropDesktopControlScreenshot(snapshot, element.getBoundingClientRect())
}

async function cropDesktopControlScreenshot(snapshot: string, rect: DOMRect): Promise<string> {
  const image = await loadDesktopControlScreenshot(snapshot)
  const scaleX = image.naturalWidth / window.innerWidth
  const scaleY = image.naturalHeight / window.innerHeight
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.width * scaleX))
  canvas.height = Math.max(1, Math.round(rect.height * scaleY))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to create screenshot canvas context')
  context.drawImage(
    image,
    Math.round(rect.left * scaleX),
    Math.round(rect.top * scaleY),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  return canvas.toDataURL('image/png')
}

function loadDesktopControlScreenshot(snapshot: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to decode main webview snapshot'))
    image.src = snapshot
  })
}

function desktopControlElementEnabled(element: HTMLElement): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return false
  return !('disabled' in element) || !(element as HTMLButtonElement).disabled
}

function desktopControlElementVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  )
}

function desktopControlEventOptions(element: HTMLElement): MouseEventInit & PointerEventInit {
  const rect = element.getBoundingClientRect()
  const clientX = Math.max(0, Math.floor(rect.left + rect.width / 2))
  const clientY = Math.max(0, Math.floor(rect.top + rect.height / 2))
  return {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  }
}

function dispatchDesktopControlPointerEvent(
  element: HTMLElement,
  type: string,
  options: MouseEventInit & PointerEventInit
) {
  if (typeof PointerEvent === 'function' && type.startsWith('pointer')) {
    element.dispatchEvent(new PointerEvent(type, options))
    return
  }
  element.dispatchEvent(new MouseEvent(type.replace(/^pointer/, 'mouse'), options))
}

function hoverDesktopControlElement(selector: string): string {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const options = desktopControlEventOptions(element)
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove']) {
    dispatchDesktopControlPointerEvent(element, type, options)
  }
  return element.textContent?.trim() ?? ''
}

function moveDesktopControlPointer(command: DesktopControlCommand): string {
  const selector = command.target ?? command.selector
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  const options = desktopControlEventOptions(element)
  dispatchDesktopControlPointerEvent(element, 'pointermove', options)
  element.dispatchEvent(new MouseEvent('mousemove', options))
  return element.textContent?.trim() ?? ''
}

async function waitForDesktopControlElement(command: DesktopControlCommand): Promise<string> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const startedAt = Date.now()
  let matchedAt: number | null = null

  while (Date.now() - startedAt < timeoutMs) {
    const elements = findDesktopControlElements(command.selector)
    const matchingElements = command.visible
      ? elements.filter(desktopControlElementVisible)
      : elements
    const text = matchingElements.map(element => element.textContent?.trim() ?? '').join('\n')
    const hasExpectedText = !command.text || text.includes(command.text)
    const isEnabled = !command.enabled || matchingElements.some(desktopControlElementEnabled)
    if (matchingElements.length > 0 && hasExpectedText && isEnabled) {
      matchedAt ??= Date.now()
      if (Date.now() - matchedAt >= (command.stableMs ?? 0)) {
        return text
      }
    } else {
      matchedAt = null
    }
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }

  throw new Error(
    `Timed out waiting for selector "${command.selector}"${
      command.text ? ` containing "${command.text}"` : ''
    }`
  )
}

function fillDesktopControlElement(element: HTMLElement, value: string) {
  element.focus()

  if (element instanceof HTMLSelectElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, value)
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(element, value)
  } else {
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set
    if (valueSetter) {
      valueSetter.call(element, value)
      return
    }

    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.execCommand('selectAll', false)
    document.execCommand('insertText', false, value)
  }

  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: value,
      inputType: 'insertText',
    })
  )
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function selectDesktopControlText(selector: string, value: string): string {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node && !node.textContent?.includes(value)) node = walker.nextNode()
  if (!node) throw new Error(`Unable to find text "${value}" inside selector "${selector}"`)

  const start = node.textContent?.indexOf(value) ?? -1
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + value.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  return value
}

async function executeDesktopControlCommand(command: DesktopControlCommand): Promise<string> {
  switch (command.action) {
    case 'capture':
      return captureDesktopControlScreenshot(command.selector)
    case 'closeMainWindowToTray':
      window.setTimeout(() => {
        void closeMainWindowToTray().catch(error => {
          console.error('[Wework] Failed to close the main window during E2E verification:', error)
        })
      }, 100)
      return ''
    case 'dispatchLocalModelSettingsChanged':
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      return ''
    case 'waitFor':
      return waitForDesktopControlElement(command)
    case 'getText':
      return desktopControlElementText(command.selector)
    case 'snapshot':
      return desktopControlSnapshot()
    case 'click': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      if (!desktopControlElementEnabled(element)) {
        throw new Error(`Selector "${command.selector}" is disabled`)
      }
      element.click()
      return element.textContent?.trim() ?? ''
    }
    case 'clickWhenEnabled': {
      await waitForDesktopControlElement({ ...command, enabled: true })
      const element = findDesktopControlElements(command.selector).find(
        desktopControlElementEnabled
      )
      if (!element) {
        throw new Error(`Selector "${command.selector}" became disabled before click`)
      }
      element.click()
      return element.textContent?.trim() ?? ''
    }
    case 'fill': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      fillDesktopControlElement(element, command.value ?? '')
      return element.textContent?.trim() ?? ''
    }
    case 'hover':
      return hoverDesktopControlElement(command.selector)
    case 'pointerMove':
      return moveDesktopControlPointer(command)
    case 'press': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      element.focus()
      const key = command.key ?? ''
      for (const type of ['keydown', 'keyup']) {
        element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
      }
      return element.textContent?.trim() ?? ''
    }
    case 'selectText':
      return selectDesktopControlText(command.selector, command.value ?? '')
  }
}

async function postDesktopControlResult(url: string, result: DesktopControlResult): Promise<void> {
  const response = await fetch(`${url}/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...desktopControlHeaders() },
    body: JSON.stringify(result),
  })
  if (!response.ok) {
    throw new Error(`Desktop E2E control result failed with ${response.status}`)
  }
}

async function runDesktopControlClient(url: string): Promise<void> {
  await fetch(`${url}/ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...desktopControlHeaders() },
    body: JSON.stringify({ location: window.location.href }),
  })

  while (true) {
    try {
      const response = await fetch(`${url}/commands`, { headers: desktopControlHeaders() })
      if (response.status === 204) {
        await new Promise(resolve => window.setTimeout(resolve, DESKTOP_CONTROL_IDLE_POLL_DELAY_MS))
        continue
      }
      if (!response.ok) {
        throw new Error(`Desktop E2E control command failed with ${response.status}`)
      }
      const command = (await response.json()) as DesktopControlCommand
      try {
        const value = await executeDesktopControlCommand(command)
        await postDesktopControlResult(url, { id: command.id, ok: true, value })
      } catch (error) {
        await postDesktopControlResult(url, {
          id: command.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } catch (error) {
      console.error('[Wework] Desktop E2E control client failed:', error)
      await new Promise(resolve => window.setTimeout(resolve, DESKTOP_CONTROL_RETRY_DELAY_MS))
    }
  }
}

function installDesktopControlClient() {
  const url = desktopControlUrl()
  if (!url) return
  void runDesktopControlClient(url)
}
