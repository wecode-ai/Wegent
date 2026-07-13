import { getRuntimeConfig, joinAppPath, stripAppBasePath } from '@/config/runtime'
import { removeToken, setToken } from '@/api/auth'
import {
  testLocalModelConnection,
  type TestLocalModelConnectionInput,
  type TestLocalModelConnectionResult,
} from '@/features/model-settings/localModelConnectionTest'
import { isTauriRuntime } from '@/lib/runtime-environment'

const DEFAULT_WAIT_TIMEOUT_MS = 5000
const LOCAL_MODEL_SEND_CIRCUIT_BREAKER_ERROR = 'WEWORK_E2E_LOCAL_MODEL_SEND_CIRCUIT_OPEN'
const DESKTOP_CONTROL_RETRY_DELAY_MS = 250
const DESKTOP_CONTROL_IDLE_POLL_DELAY_MS = 50

type DesktopControlAction =
  | 'capture'
  | 'click'
  | 'fill'
  | 'getText'
  | 'snapshot'
  | 'waitFor'
  | 'press'

interface DesktopControlCommand {
  id: string
  action: DesktopControlAction
  selector: string
  value?: string
  text?: string
  timeoutMs?: number
  enabled?: boolean
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

export function installWeworkAutomationBridge() {
  if (!isWeworkAutomationEnabled() || typeof window === 'undefined') {
    return
  }

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

  const { default: html2canvas } = await import('html2canvas')
  const canvas = await html2canvas(element, {
    allowTaint: false,
    backgroundColor: getComputedStyle(document.documentElement).backgroundColor,
    height: element === document.body ? window.innerHeight : undefined,
    logging: false,
    scale: Math.min(window.devicePixelRatio, 2),
    useCORS: true,
    width: element === document.body ? window.innerWidth : undefined,
    windowHeight: window.innerHeight,
    windowWidth: window.innerWidth,
  })
  return canvas.toDataURL('image/png')
}

function desktopControlElementEnabled(element: HTMLElement): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return false
  return !('disabled' in element) || !(element as HTMLButtonElement).disabled
}

async function waitForDesktopControlElement(command: DesktopControlCommand): Promise<string> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const elements = findDesktopControlElements(command.selector)
    const text = elements.map(element => element.textContent?.trim() ?? '').join('\n')
    const hasExpectedText = !command.text || text.includes(command.text)
    const isEnabled = !command.enabled || elements.some(desktopControlElementEnabled)
    if (elements.length > 0 && hasExpectedText && isEnabled) {
      return text
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

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
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

async function executeDesktopControlCommand(command: DesktopControlCommand): Promise<string> {
  switch (command.action) {
    case 'capture':
      return captureDesktopControlScreenshot(command.selector)
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
    case 'fill': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      fillDesktopControlElement(element, command.value ?? '')
      return element.textContent?.trim() ?? ''
    }
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
