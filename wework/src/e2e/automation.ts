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
import { invoke } from '@tauri-apps/api/core'
import {
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { saveLocalUserPreferences } from '@/api/local/localSession'
import { desktopControlExtension } from '@extensions/desktop-control'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { parseDesktopControlKey } from './desktop-control-keyboard'
import { getWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { getRuntimeConversationCacheStats } from '@/features/workbench/runtimeConversationCache'

const DEFAULT_WAIT_TIMEOUT_MS = 5000
const LOCAL_MODEL_SEND_CIRCUIT_BREAKER_ERROR = 'WEWORK_E2E_LOCAL_MODEL_SEND_CIRCUIT_OPEN'
const DESKTOP_CONTROL_RETRY_DELAY_MS = 250

interface DesktopControlResult {
  id: string
  clientId: string
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
  const token =
    import.meta.env.VITE_WEWORK_E2E_CLOUD_TOKEN?.trim() || 'wework-desktop-e2e-cloud-token'

  const config = normalizeCloudBackendUrl(backendUrl)
  saveStoredCloudConnection({
    ...config,
    webUrl: config.backendUrl,
    token,
    tokenExpiresAt: null,
    user: {
      id: 9001,
      user_name: 'wework-desktop-e2e-cloud-user',
      email: 'desktop-e2e@wework.local',
    },
    connectedAt: new Date().toISOString(),
  })
  const localModels =
    import.meta.env.VITE_WEWORK_E2E_SEED_LOCAL_MODELS === 'true'
      ? [
          {
            id: 'desktop-e2e-responses',
            displayName: 'Desktop E2E Responses',
            modelId: 'desktop-e2e-responses-model',
            apiFormat: 'openai-responses' as const,
            toolProfile: 'function' as const,
            requestPath: '/v1/responses',
          },
          {
            id: 'desktop-e2e-chat',
            displayName: 'Desktop E2E Chat',
            modelId: 'desktop-e2e-chat-model',
            apiFormat: 'openai-chat-completions' as const,
            toolProfile: 'function' as const,
            requestPath: '/v1/chat/completions',
          },
          {
            id: 'desktop-e2e-anthropic',
            displayName: 'Desktop E2E Anthropic',
            modelId: 'desktop-e2e-anthropic-model',
            apiFormat: 'anthropic-messages' as const,
            toolProfile: 'function' as const,
            requestPath: '/v1/messages',
          },
        ]
      : []
  for (const model of localModels) {
    saveLocalModelConfig({
      ...model,
      baseUrl: backendUrl,
      apiKey: 'wework-e2e-test-key',
      catalogReady: false,
      enabled: true,
    })
  }
  saveLocalUserPreferences({
    wework_new_chat_model_selection: {
      modelName: 'gpt-5.4',
      modelType: 'runtime',
      options: {},
    },
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

function desktopControlElementMetrics(selector: string): string {
  const elements = findDesktopControlElements(selector)
  if (elements.length === 0) throw new Error(`Unable to find selector "${selector}"`)

  return JSON.stringify(
    elements.map(element => {
      const rect = element.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        scrollHeight: element.scrollHeight,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        scrollWidth: element.scrollWidth,
        top: rect.top,
        width: rect.width,
      }
    })
  )
}

function desktopControlSnapshot(selector = 'body'): string {
  const root = findDesktopControlElements(selector)[0]
  if (!root) throw new Error(`Unable to find selector "${selector}"`)
  const testIdElements = [
    ...(root.dataset.testid ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('[data-testid]')),
  ]
  const testIds = testIdElements
    .map(element => element.dataset.testid)
    .filter((testId): testId is string => Boolean(testId))

  return JSON.stringify({
    location: window.location.href,
    text: root.innerText,
    testIds: Array.from(new Set(testIds)).sort(),
  })
}

async function captureDesktopControlScreenshot(selector: string): Promise<string> {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  if (element === document.body) return invoke<string>('capture_main_webview')
  const rect = element.getBoundingClientRect()
  if (selector !== '[data-testid="model-selector-menu"]') {
    const snapshot = await invoke<string>('capture_main_webview')
    return cropDesktopControlScreenshot(snapshot, rect)
  }
  // NSView snapshots can omit WebKit's separately composited fixed-position popovers.
  // Mirror the target into the document layer so element evidence captures what is visible.
  const captureClone = element.cloneNode(true) as HTMLElement
  Object.assign(captureClone.style, {
    animation: 'none',
    height: `${rect.height}px`,
    left: `${rect.left + window.scrollX}px`,
    maxHeight: 'none',
    position: 'absolute',
    top: `${rect.top + window.scrollY}px`,
    transform: 'none',
    width: `${rect.width}px`,
    zIndex: '2147483647',
  })
  document.body.appendChild(captureClone)
  try {
    await new Promise<void>(resolve => window.setTimeout(resolve, 50))
    const snapshot = await invoke<string>('capture_main_webview')
    return cropDesktopControlScreenshot(snapshot, rect)
  } finally {
    captureClone.remove()
  }
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

async function waitForDesktopControlTick(): Promise<void> {
  const url = desktopControlUrl()
  if (!url) throw new Error('Desktop E2E control URL is not configured')
  const response = await fetch(`${url}/control-tick`, { headers: desktopControlHeaders() })
  if (response.status !== 204) {
    throw new Error(`Desktop E2E control tick failed with ${response.status}`)
  }
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
  element: EventTarget,
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

function pressDesktopControlPointer(selector: string): string {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  const options = desktopControlEventOptions(element)
  dispatchDesktopControlPointerEvent(element, 'pointerdown', options)
  dispatchDesktopControlPointerEvent(element, 'pointerup', options)
  return element.textContent?.trim() ?? ''
}

function dragDesktopControlElement(command: DesktopControlCommand): string {
  const element = findDesktopControlElements(command.selector)[0]
  if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
  if (!command.target) throw new Error('Drag requires a target selector')
  const target = findDesktopControlElements(command.target)[0]
  if (!target) throw new Error(`Unable to find target selector "${command.target}"`)

  const startOptions = { ...desktopControlEventOptions(element), buttons: 1 }
  const endOptions = { ...desktopControlEventOptions(target), buttons: 1 }
  dispatchDesktopControlPointerEvent(element, 'pointerdown', startOptions)
  dispatchDesktopControlPointerEvent(document, 'pointermove', endOptions)
  dispatchDesktopControlPointerEvent(document, 'pointerup', { ...endOptions, buttons: 0 })
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
    await waitForDesktopControlTick()
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
    } else {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.execCommand('selectAll', false)
      document.execCommand('insertText', false, value)
    }
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

function dropDesktopControlFile(command: DesktopControlCommand): string {
  const element = findDesktopControlElements(command.selector)[0]
  if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
  const filename = command.filename?.trim()
  if (!filename) throw new Error('dropFile requires a filename')
  const binary = window.atob(command.value ?? '')
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const file = new File([bytes], filename, { type: command.mimeType ?? '' })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const event = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    composed: true,
  })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  element.dispatchEvent(event)
  return filename
}

async function executeDesktopControlCommand(command: DesktopControlCommand): Promise<string> {
  switch (command.action) {
    case 'capture':
      return captureDesktopControlScreenshot(command.selector)
    case 'closeMainWindowToTray':
      return ''
    case 'dispatchLocalModelSettingsChanged':
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      return ''
    case 'performanceSnapshot': {
      const processMemory = navigator.platform.toLowerCase().includes('mac')
        ? await invoke('get_wework_process_snapshot')
        : null
      return JSON.stringify({
        timestamp: Date.now(),
        domNodeCount: document.getElementsByTagName('*').length,
        runtimeConversationCache: getRuntimeConversationCacheStats(),
        processMemory,
      })
    }
    case 'focusMainWindow':
      await getCurrentWindow().show()
      await getCurrentWindow().unminimize()
      await getCurrentWindow().setFocus()
      return ''
    case 'drag':
      return dragDesktopControlElement(command)
    case 'dropFile':
      return dropDesktopControlFile(command)
    case 'waitFor':
      return waitForDesktopControlElement(command)
    case 'getText':
      return desktopControlElementText(command.selector)
    case 'getElementMetrics':
      return desktopControlElementMetrics(command.selector)
    case 'getStyle': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const property = command.value?.trim()
      if (!property) throw new Error('getStyle requires a CSS property name')
      return window.getComputedStyle(element).getPropertyValue(property)
    }
    case 'getInlineStyle': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const property = command.value?.trim()
      if (!property) throw new Error('getInlineStyle requires a CSS property name')
      return element.style.getPropertyValue(property)
    }
    case 'getValue': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        return element.value
      }
      return element.textContent?.trim() ?? ''
    }
    case 'getSelectionOffset': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const selection = window.getSelection()
      if (!selection?.anchorNode || !element.contains(selection.anchorNode)) return '-1'
      const range = document.createRange()
      range.selectNodeContents(element)
      range.setEnd(selection.anchorNode, selection.anchorOffset)
      return String(range.toString().length)
    }
    case 'snapshot':
      return desktopControlSnapshot(command.selector)
    case 'scrollIntoView': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      return element.textContent?.trim() ?? ''
    }
    case 'scrollIntoViewAsUser': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          deltaY: -120,
        })
      )
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      return element.textContent?.trim() ?? ''
    }
    case 'click': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      if (!desktopControlElementEnabled(element)) {
        throw new Error(`Selector "${command.selector}" is disabled`)
      }
      element.click()
      return element.textContent?.trim() ?? ''
    }
    case 'clickIfPresent': {
      const element = findDesktopControlElements(command.selector).find(
        desktopControlElementEnabled
      )
      if (!element) return 'missing'
      element.click()
      return 'clicked'
    }
    case 'deferredClick': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      if (!desktopControlElementEnabled(element)) {
        throw new Error(`Selector "${command.selector}" is disabled`)
      }
      window.setTimeout(() => element.click(), 100)
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
    case 'getWorkbenchDebugSnapshot':
      return JSON.stringify(getWorkbenchDebugSnapshot())
    case 'hover':
      return hoverDesktopControlElement(command.selector)
    case 'pointerDown':
      return pressDesktopControlPointer(command.selector)
    case 'navigate': {
      const appPath = normalizeAppPath(command.value ?? '/')
      window.history.pushState(null, '', joinAppPath(getRuntimeConfig().appBasePath, appPath))
      dispatchNavigationEvents()
      return stripAppBasePath(window.location.pathname)
    }
    case 'pointerMove':
      return moveDesktopControlPointer(command)
    case 'press': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      element.focus()
      const keyboardEvent = parseDesktopControlKey(command.key ?? '')
      for (const type of ['keydown', 'keyup']) {
        element.dispatchEvent(
          new KeyboardEvent(type, { ...keyboardEvent, bubbles: true, cancelable: true })
        )
      }
      return element.textContent?.trim() ?? ''
    }
    case 'selectText':
      return selectDesktopControlText(command.selector, command.value ?? '')
  }

  const extensionResult = await desktopControlExtension.execute(command)
  if (extensionResult.handled) return extensionResult.value
  throw new Error(`Unsupported desktop control action: ${command.action}`)
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
  const clientId = crypto.randomUUID()
  const readyResponse = await fetch(`${url}/ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...desktopControlHeaders() },
    body: JSON.stringify({ clientId, location: window.location.href }),
  })
  if (!readyResponse.ok) {
    throw new Error(`Desktop E2E control registration failed with ${readyResponse.status}`)
  }

  while (true) {
    try {
      const response = await fetch(`${url}/commands?clientId=${encodeURIComponent(clientId)}`, {
        headers: desktopControlHeaders(),
      })
      if (response.status === 204) {
        await new Promise(resolve => window.setTimeout(resolve, DESKTOP_CONTROL_RETRY_DELAY_MS))
        continue
      }
      if (!response.ok) {
        throw new Error(`Desktop E2E control command failed with ${response.status}`)
      }
      const command = (await response.json()) as DesktopControlCommand
      try {
        const value = await executeDesktopControlCommand(command)
        await postDesktopControlResult(url, { id: command.id, clientId, ok: true, value })
        if (command.action === 'closeMainWindowToTray') {
          await closeMainWindowToTray()
        }
      } catch (error) {
        await postDesktopControlResult(url, {
          id: command.id,
          clientId,
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
  if (!url || window.location.pathname.startsWith('/system-drag')) return
  void runDesktopControlClient(url)
}
