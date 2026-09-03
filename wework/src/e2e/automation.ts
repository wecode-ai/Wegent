import { getRuntimeConfig, joinAppPath, stripAppBasePath } from '@/config/runtime'
import { removeToken, setToken } from '@/api/auth'
import type { LocalPluginImportPreview } from '@/api/local/codexPlugins'
import {
  testLocalModelConnection,
  type TestLocalModelConnectionInput,
  type TestLocalModelConnectionResult,
} from '@/features/model-settings/localModelConnectionTest'
import {
  getDesktopWindowLabel,
  isDesktopRuntime,
  isElectronRuntime,
} from '@/lib/runtime-environment'
import {
  normalizeCloudBackendUrl,
  saveStoredCloudConnection,
} from '@/features/cloud-connection/cloudConnectionStorage'
import { EditorView } from '@codemirror/view'
import {
  LOCAL_MODEL_SETTINGS_CHANGED_EVENT,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import { saveLocalUserPreferences } from '@/api/local/localSession'
import { desktopControlExtension } from '@extensions/desktop-control'
import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { parseDesktopControlKey } from './desktop-control-keyboard'
import { getWorkbenchDebugSnapshot } from '@/lib/debugPanel'
import { getComposerDiagnosticsSnapshot } from '@/components/chat/composer/composerDiagnostics'
import {
  getRuntimeConversationCacheStats,
  getRuntimeConversationMessagesForLogicalAddress,
  reconcileRuntimeConversationSnapshot,
} from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskAddress } from '@/types/api'
import { getLocalExecutorStatus, readLocalExecutorLog } from '@/desktop/localExecutor'
import { executeVerificationControlCommand } from './verification-control'
import { captureEmbeddedBrowserSnapshot, evalEmbeddedBrowserJson } from '@/lib/embedded-browser'
import { selectDesktopControlOption } from './desktop-control-select'
import {
  getAppPreferences,
  updateAppPreferences,
  type AppPreferencesPatch,
} from '@/desktop/appPreferences'
import type { LocalHarnessId } from '@/lib/local-harness'
import { getDesktopE2ERuntimeConfig, loadDesktopE2ERuntimeConfig } from './runtime-config'
import { installDesktopE2EClipboard } from './clipboard'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { suspendDshTerminalEventDelivery } from '@/api/dsh/terminalTransport'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { flushDesktopLocalStoragePersistence } from '@/desktop/localStoragePersistence'
import { downloadPendingWeworkUpdate } from '@/lib/app-updater'
import { createTrayTaskMenuId } from '@/desktop/trayTaskMenuId'

const DEFAULT_WAIT_TIMEOUT_MS = 5000
const LOCAL_MODEL_SEND_CIRCUIT_BREAKER_ERROR = 'WEWORK_E2E_LOCAL_MODEL_SEND_CIRCUIT_OPEN'

interface DesktopControlResult {
  id: string
  clientId: string
  ok: boolean
  value?: string
  error?: string
}

interface ScrollStabilitySamplePoint {
  anchorTop: number
  clientHeight: number
  scrollHeight: number
  scrollOrigin: 'bottom' | 'top'
  scrollTop: number
  time: number
}

interface ScrollStabilitySample {
  done: boolean
  frames: ScrollStabilitySamplePoint[]
  missingFrames: number
  scrollEvents: ScrollStabilitySamplePoint[]
  stop: () => void
}

interface ElementMetricsSamplePoint {
  connected: boolean
  height: number
  label: string | null
  left: number
  testIds: string[]
  time: number
  top: number
  visibility: string
  width: number
}

interface ElementMetricsSample {
  done: boolean
  frames: ElementMetricsSamplePoint[]
  stop: () => void
}

let activeScrollStabilitySample: ScrollStabilitySample | null = null
let activeElementMetricsSample: ElementMetricsSample | null = null

export interface WeworkAutomationBridge {
  version: 1
  isEnabled: true
  isDesktop: () => boolean
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
  return (
    import.meta.env.MODE === 'e2e' ||
    import.meta.env.VITE_WEWORK_E2E === 'true' ||
    Boolean(getDesktopE2ERuntimeConfig().controlUrl)
  )
}

export function shouldUseNativeProjectDirectoryPicker(): boolean {
  return (
    !isWeworkAutomationEnabled() ||
    import.meta.env.VITE_WEWORK_E2E_NATIVE_DIRECTORY_PICKER === 'true'
  )
}

function desktopControlUrl(): string | null {
  const value =
    getDesktopE2ERuntimeConfig().controlUrl ??
    import.meta.env.VITE_WEWORK_DESKTOP_E2E_CONTROL_URL?.trim()
  return value ? value.replace(/\/+$/, '') : null
}

function desktopControlHeaders(): HeadersInit | undefined {
  const token =
    getDesktopE2ERuntimeConfig().controlToken ??
    import.meta.env.VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN?.trim()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

function normalizeAppPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function dispatchNavigationEvents() {
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new CustomEvent('wework:e2e:navigation'))
}

function embeddedBrowserStorageInput(command: DesktopControlCommand) {
  const input = JSON.parse(command.value ?? '{}') as {
    key?: string
    label?: string
    value?: string
  }
  if (!input.label?.trim() || !input.key) {
    throw new Error(`${command.action} requires label and key`)
  }
  return {
    key: input.key,
    label: input.label.trim(),
    value: input.value ?? '',
  }
}

function reloadMainWindowLocalStorageInput(
  command: DesktopControlCommand
): { key: string; value: string } | null {
  if (!command.value || command.value === 'capture') return null
  const input = JSON.parse(command.value) as {
    localStorage?: { key?: string; value?: string }
  }
  if (!input.localStorage) return null
  if (!input.localStorage.key) {
    throw new Error('reloadMainWindow localStorage requires a key')
  }
  return {
    key: input.localStorage.key,
    value: input.localStorage.value ?? '',
  }
}

async function setEmbeddedBrowserLocalStorageItem(command: DesktopControlCommand) {
  const input = embeddedBrowserStorageInput(command)
  return evalEmbeddedBrowserJson<string>(
    `(localStorage.setItem(${JSON.stringify(input.key)}, ${JSON.stringify(input.value)}), ` +
      `localStorage.getItem(${JSON.stringify(input.key)}))`,
    input.label
  )
}

async function getEmbeddedBrowserLocalStorageItem(command: DesktopControlCommand) {
  const input = embeddedBrowserStorageInput(command)
  return evalEmbeddedBrowserJson<string | null>(
    `localStorage.getItem(${JSON.stringify(input.key)})`,
    input.label
  )
}

async function setEmbeddedBrowserWindowValue(command: DesktopControlCommand) {
  const input = embeddedBrowserStorageInput(command)
  return evalEmbeddedBrowserWhenReady<string>(
    command,
    input.label,
    `(globalThis[${JSON.stringify(input.key)}] = ${JSON.stringify(input.value)})`
  )
}

async function getEmbeddedBrowserWindowValue(command: DesktopControlCommand) {
  const input = embeddedBrowserStorageInput(command)
  return evalEmbeddedBrowserWhenReady<string | null>(
    command,
    input.label,
    `globalThis[${JSON.stringify(input.key)}] ?? null`
  )
}

async function evalEmbeddedBrowserWhenReady<T>(
  command: DesktopControlCommand,
  label: string,
  expression: string
): Promise<T> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const startedAt = Date.now()
  let lastError = 'Embedded browser is not ready'
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await evalEmbeddedBrowserJson<T>(expression, label)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await waitForDesktopControlTick()
    }
  }
  throw new Error(`Timed out evaluating embedded browser "${label}": ${lastError}`)
}

async function captureEmbeddedBrowserWhenReady(command: DesktopControlCommand): Promise<string> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const startedAt = Date.now()
  const configuredLabel = command.value?.trim()
  let lastError = 'Embedded browser host is not ready'
  while (Date.now() - startedAt < timeoutMs) {
    const label =
      configuredLabel ||
      document.querySelector<HTMLElement>(command.selector)?.dataset.embeddedBrowserLabel?.trim()
    if (!label) {
      await waitForDesktopControlTick()
      continue
    }
    try {
      const page = await evalEmbeddedBrowserJson<{
        readyState: string
        textLength: number
      }>(
        `({
          readyState: document.readyState,
          textLength: (document.body?.innerText ?? '').trim().length
        })`,
        label
      )
      if (page.readyState === 'complete' && page.textLength > 0) {
        return captureEmbeddedBrowserSnapshot(label)
      }
      lastError = `page state is ${page.readyState} with ${page.textLength} visible text characters`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await waitForDesktopControlTick()
  }
  throw new Error(`Timed out capturing embedded browser for "${command.selector}": ${lastError}`)
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
    isDesktop: isElectronRuntime,
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

async function seedDesktopE2ECloudConnection(): Promise<void> {
  const runtimeConfig = getDesktopE2ERuntimeConfig()
  const backendUrl =
    runtimeConfig.cloudBackendUrl ?? import.meta.env.VITE_WEWORK_E2E_CLOUD_BACKEND_URL?.trim()
  if (!backendUrl) return
  const modelServerUrl =
    runtimeConfig.modelServerUrl ??
    import.meta.env.VITE_WEWORK_E2E_MODEL_SERVER_URL?.trim() ??
    backendUrl
  const localModelsCatalogReady =
    runtimeConfig.localModelsCatalogReady ??
    import.meta.env.VITE_WEWORK_E2E_LOCAL_MODELS_CATALOG_READY === 'true'
  const config = normalizeCloudBackendUrl(backendUrl)
  saveStoredCloudConnection({
    ...config,
    webUrl: config.backendUrl,
    user: {
      id: 9001,
      user_name: 'wework-desktop-e2e-cloud-user',
      email: 'desktop-e2e@wework.local',
    },
    connectedAt: new Date().toISOString(),
  })
  const localModels =
    (runtimeConfig.seedLocalModels ?? import.meta.env.VITE_WEWORK_E2E_SEED_LOCAL_MODELS === 'true')
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
          {
            id: 'desktop-e2e-luna-overseas',
            displayName: 'GPT 5.6 Luna (海外)',
            modelId: 'gpt-5.6-luna',
            apiFormat: 'openai-responses' as const,
            toolProfile: 'custom' as const,
            requestPath: '/v1/responses',
          },
          // The vision proxy must be saved before the primary model that references it.
          {
            id: 'desktop-e2e-vision',
            providerProfileId: 'kimi' as const,
            displayName: 'Desktop E2E Vision',
            modelId: 'kimi-k3',
            apiFormat: 'openai-chat-completions' as const,
            toolProfile: 'function' as const,
            requestPath: '/v1/chat/completions',
            catalogReady: true,
          },
          {
            id: 'desktop-e2e-vision-main',
            providerProfileId: 'deepseek' as const,
            displayName: 'Desktop E2E DeepSeek Pro Vision Main',
            modelId: 'deepseek-v4-pro',
            apiFormat: 'openai-responses' as const,
            toolProfile: 'custom' as const,
            requestPath: '/v1/responses',
            contextWindow: 1_048_576,
            webSearchMode: 'live' as const,
            codexCatalogModelId: 'wework-deepseek-v4-pro',
            visionModelConfigId: 'desktop-e2e-vision',
            catalogReady: true,
          },
        ]
      : []
  for (const model of localModels) {
    saveLocalModelConfig({
      catalogReady: localModelsCatalogReady,
      ...model,
      baseUrl: modelServerUrl,
      apiKey: 'wework-e2e-test-key',
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

export async function installWeworkAutomationBridge(
  beforeSeed: Promise<void> = Promise.resolve()
): Promise<void> {
  if (!isWeworkAutomationEnabled() || typeof window === 'undefined') {
    return
  }

  if (isDesktopRuntime()) {
    await loadDesktopE2ERuntimeConfig()
  }
  installDesktopE2EClipboard()
  window.__WEWORK_E2E__ = createBridge()
  installDesktopControlClient()
  await beforeSeed.catch(() => undefined)
  await seedDesktopE2ECloudConnection()
}

function findDesktopControlElements(selector: string): HTMLElement[] {
  const elements: HTMLElement[] = []
  const visit = (root: Document | ShadowRoot) => {
    elements.push(...root.querySelectorAll<HTMLElement>(selector))
    root.querySelectorAll<HTMLElement>('*').forEach(element => {
      if (element.shadowRoot) {
        visit(element.shadowRoot)
      }
    })
  }
  visit(document)
  return elements
}

function desktopControlElementText(selector: string, visible = false): string {
  const elements = findDesktopControlElements(selector)
  return (visible ? elements.filter(desktopControlElementVisible) : elements)
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
        scrollOrigin: element.dataset.scrollOrigin === 'bottom' ? 'bottom' : 'top',
        scrollTop: element.scrollTop,
        scrollWidth: element.scrollWidth,
        top: rect.top,
        width: rect.width,
      }
    })
  )
}

function desktopControlContentScrollTop(element: HTMLElement): number {
  if (element.dataset.scrollOrigin !== 'bottom') return element.scrollTop
  return Math.max(0, element.scrollHeight - element.clientHeight + element.scrollTop)
}

function desktopControlDomScrollTop(element: HTMLElement, contentScrollTop: number): number {
  if (element.dataset.scrollOrigin !== 'bottom') return contentScrollTop
  return contentScrollTop - Math.max(0, element.scrollHeight - element.clientHeight)
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
    browserPanels: Array.from(
      root.querySelectorAll<HTMLElement>('[data-testid="workspace-browser-panel"]')
    ).map(panel => ({
      label: panel.dataset.embeddedBrowserLabel ?? null,
      hidden: panel.classList.contains('hidden'),
      parentHidden: panel.parentElement?.classList.contains('hidden') ?? null,
      address:
        panel.querySelector<HTMLInputElement>('[data-testid="workspace-browser-url-input"]')
          ?.value ?? null,
    })),
    selectedRightWorkspaceTabs: Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-testid="right-workspace-tabbar"] [role="tab"][aria-selected="true"]'
      )
    ).map(tab => tab.dataset.testid ?? null),
  })
}

function desktopControlTestIdOrder(selector = 'body'): string {
  const root = findDesktopControlElements(selector)[0]
  if (!root) throw new Error(`Unable to find selector "${selector}"`)
  const testIdElements = [
    ...(root.dataset.testid ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('[data-testid]')),
  ]
  const testIds = testIdElements
    .map(element => element.dataset.testid)
    .filter((testId): testId is string => Boolean(testId))

  return JSON.stringify(Array.from(new Set(testIds)))
}

function quiesceElectronTerminalCaptureSurfaces(): () => void {
  const restores: Array<() => void> = []
  document.querySelectorAll<HTMLElement>('.xterm-screen').forEach(screen => {
    const accessibilityTree = screen.parentElement?.querySelector<HTMLElement>(
      '.xterm-accessibility-tree'
    )
    const accessibleRows = accessibilityTree
      ? Array.from(accessibilityTree.querySelectorAll<HTMLElement>('[role="listitem"]'))
          .map(row => row.textContent ?? '')
          .filter(row => row.trim().length > 0)
      : []
    const renderedRows = Array.from(screen.querySelectorAll<HTMLElement>('.xterm-rows > div')).map(
      row => row.textContent ?? ''
    )
    const rows = (accessibleRows.length > 0 ? accessibleRows : renderedRows).join('\n')
    const mirror = document.createElement('pre')
    const rowContainer = screen.querySelector<HTMLElement>('.xterm-rows')
    const style = window.getComputedStyle(rowContainer ?? screen)
    mirror.textContent = rows
    mirror.setAttribute('aria-hidden', 'true')
    Object.assign(mirror.style, {
      background: style.backgroundColor,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      inset: '0',
      lineHeight: style.lineHeight,
      margin: '0',
      overflow: 'hidden',
      padding: '0',
      pointerEvents: 'none',
      position: 'absolute',
      whiteSpace: 'pre',
      zIndex: '2147483647',
    })
    screen.parentElement?.appendChild(mirror)
    const previousVisibility = screen.style.visibility
    screen.style.visibility = 'hidden'
    restores.push(() => {
      screen.style.visibility = previousVisibility
      mirror.remove()
    })
  })
  return () => restores.toReversed().forEach(restore => restore())
}

async function captureDesktopControlScreenshot(selector: string): Promise<string> {
  const resumeTerminalEvents = suspendDshTerminalEventDelivery()
  const restoreTerminalSurfaces = quiesceElectronTerminalCaptureSurfaces()
  try {
    await new Promise<void>(resolve => window.setTimeout(resolve, 100))
    const snapshot = await invokeDesktopHost<string>('e2e.capturePrimaryView', {
      windowLabel: getDesktopWindowLabel(),
    })
    const element = findDesktopControlElements(selector)[0]
    if (!element) throw new Error(`Unable to find selector "${selector}"`)
    return element === document.body
      ? snapshot
      : cropDesktopControlScreenshot(snapshot, element.getBoundingClientRect())
  } finally {
    restoreTerminalSurfaces()
    resumeTerminalEvents()
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

function desktopControlElementRendered(element: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current) {
    const style = window.getComputedStyle(current)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return false
    }
    current = current.parentElement
  }

  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function desktopControlElementVisible(element: HTMLElement): boolean {
  if (!desktopControlElementRendered(element)) return false

  const rect = element.getBoundingClientRect()
  return !(
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  )
}

async function expandDesktopProcessingSummaries(): Promise<string> {
  const clickCollapsed = (selector: string) => {
    const buttons = findDesktopControlElements(selector).filter(desktopControlElementEnabled)
    buttons.forEach(button => button.click())
    return buttons.length
  }

  const finalCount = clickCollapsed(
    '[data-testid="final-processing-toggle"][aria-expanded="false"]'
  )
  await waitForDesktopControlTick()
  const summaryCount = clickCollapsed(
    '[data-testid="processing-summary-toggle"][aria-expanded="false"]'
  )
  await waitForDesktopControlTick()
  return JSON.stringify({ finalCount, summaryCount })
}

async function waitForDesktopControlTick(): Promise<void> {
  await new Promise<void>(resolve => window.setTimeout(resolve, 16))
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

function leaveDesktopControlElement(selector: string): string {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  const options = desktopControlEventOptions(element)
  for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
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

async function pressDesktopControlKey(selector: string, key: string): Promise<string> {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  element.focus()
  const keyboardEvent = parseDesktopControlKey(key)
  for (const type of ['keydown', 'keyup']) {
    element.dispatchEvent(
      new KeyboardEvent(type, { ...keyboardEvent, bubbles: true, cancelable: true })
    )
  }
  await waitForDesktopControlTick()
  return element.textContent?.trim() ?? ''
}

let activeDesktopControlPointer: {
  element: HTMLElement
  options: MouseEventInit & PointerEventInit
} | null = null

function startDesktopControlPointer(selector: string): string {
  if (activeDesktopControlPointer) throw new Error('A desktop control pointer is already active')
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  element.scrollIntoView({ block: 'center', inline: 'center' })
  element.focus()
  const options = { ...desktopControlEventOptions(element), buttons: 1 }
  dispatchDesktopControlPointerEvent(element, 'pointerdown', options)
  activeDesktopControlPointer = { element, options }
  return element.textContent?.trim() ?? ''
}

function endDesktopControlPointer(): string {
  const activePointer = activeDesktopControlPointer
  if (!activePointer) throw new Error('No desktop control pointer is active')
  try {
    dispatchDesktopControlPointerEvent(activePointer.element, 'pointerup', {
      ...activePointer.options,
      buttons: 0,
    })
    return activePointer.element.textContent?.trim() ?? ''
  } finally {
    activeDesktopControlPointer = null
  }
}

let activeDesktopControlDrag: {
  endOptions: MouseEventInit & PointerEventInit
  sourceElement: HTMLElement
  sourceText: string
  targetSelector: string
} | null = null

function desktopControlDeepActiveElement(): HTMLElement | null {
  let activeElement: Element | null = document.activeElement
  while (activeElement instanceof HTMLElement) {
    const shadowActiveElement = activeElement.shadowRoot?.activeElement
    if (!(shadowActiveElement instanceof HTMLElement)) return activeElement
    activeElement = shadowActiveElement
  }
  return null
}

async function startDesktopControlDrag(command: DesktopControlCommand): Promise<string> {
  if (activeDesktopControlDrag) throw new Error('A desktop control drag is already active')
  const element = findDesktopControlElements(command.selector)[0]
  if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
  if (!command.target) throw new Error('Drag requires a target selector')
  const target = findDesktopControlElements(command.target)[0]
  if (!target) throw new Error(`Unable to find target selector "${command.target}"`)

  const activeElement = desktopControlDeepActiveElement()
  if (activeElement && activeElement !== element) {
    activeElement.blur()
    await waitForDesktopControlTick()
  }
  const startOptions = { ...desktopControlEventOptions(element), buttons: 1 }
  const endOptions = { ...desktopControlEventOptions(target), buttons: 1 }
  dispatchDesktopControlPointerEvent(element, 'pointerdown', startOptions)
  await waitForDesktopControlTick()
  dispatchDesktopControlPointerEvent(document, 'pointermove', endOptions)
  dispatchDesktopControlPointerEvent(element, 'pointermove', endOptions)
  await waitForDesktopControlTick()
  dispatchDesktopControlPointerEvent(target, 'pointermove', endOptions)
  await waitForDesktopControlTick()
  activeDesktopControlDrag = {
    endOptions,
    sourceElement: element,
    sourceText: element.textContent?.trim() ?? '',
    targetSelector: command.target,
  }
  return activeDesktopControlDrag.sourceText
}

async function endDesktopControlDrag(command: DesktopControlCommand): Promise<string> {
  const activeDrag = activeDesktopControlDrag
  if (!activeDrag) throw new Error('No desktop control drag is active')
  const startedAt = performance.now()
  const targetSelector = command.target ?? activeDrag.targetSelector
  const target = findDesktopControlElements(targetSelector)[0]
  if (!target) throw new Error(`Unable to find target selector "${targetSelector}"`)
  const endOptions =
    targetSelector === activeDrag.targetSelector
      ? activeDrag.endOptions
      : { ...desktopControlEventOptions(target), buttons: 1 }
  try {
    dispatchDesktopControlPointerEvent(document, 'pointermove', endOptions)
    dispatchDesktopControlPointerEvent(activeDrag.sourceElement, 'pointermove', endOptions)
    dispatchDesktopControlPointerEvent(target, 'pointermove', endOptions)
    await waitForDesktopControlTick()
    dispatchDesktopControlPointerEvent(document, 'pointerup', { ...endOptions, buttons: 0 })
    dispatchDesktopControlPointerEvent(activeDrag.sourceElement, 'pointerup', {
      ...endOptions,
      buttons: 0,
    })
    if (command.waitForSelector) {
      await waitForDesktopControlElement({
        ...command,
        selector: command.waitForSelector,
        visible: true,
      })
      return JSON.stringify({
        durationMs: Math.round(performance.now() - startedAt),
        sourceText: activeDrag.sourceText,
      })
    }
    return activeDrag.sourceText
  } finally {
    activeDesktopControlDrag = null
  }
}

async function dragDesktopControlElement(command: DesktopControlCommand): Promise<string> {
  await startDesktopControlDrag(command)
  return endDesktopControlDrag(command)
}

let activeDesktopControlDataTransfer: {
  source: HTMLElement
  transfer: DataTransfer
} | null = null

function dispatchDesktopControlDragEvent(
  element: HTMLElement,
  type: string,
  transfer: DataTransfer
) {
  const rect = element.getBoundingClientRect()
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    composed: true,
  })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  element.dispatchEvent(event)
}

function startDesktopControlDataTransfer(command: DesktopControlCommand): string {
  if (activeDesktopControlDataTransfer) {
    throw new Error('A data-transfer drag is already active')
  }
  const source = findDesktopControlElements(command.selector)[0]
  if (!source) throw new Error(`Unable to find selector "${command.selector}"`)
  const transfer = new DataTransfer()
  dispatchDesktopControlDragEvent(source, 'dragstart', transfer)
  activeDesktopControlDataTransfer = { source, transfer }
  return source.textContent?.trim() ?? ''
}

function endDesktopControlDataTransfer(command: DesktopControlCommand): string {
  const activeDrag = activeDesktopControlDataTransfer
  if (!activeDrag) throw new Error('No data-transfer drag is active')

  try {
    if (!command.target) throw new Error('Data-transfer drag requires a target selector')
    const target = findDesktopControlElements(command.target)[0]
    if (!target) throw new Error(`Unable to find target selector "${command.target}"`)
    dispatchDesktopControlDragEvent(target, 'dragenter', activeDrag.transfer)
    dispatchDesktopControlDragEvent(target, 'dragover', activeDrag.transfer)
    dispatchDesktopControlDragEvent(target, 'drop', activeDrag.transfer)
    return activeDrag.source.textContent?.trim() ?? ''
  } finally {
    dispatchDesktopControlDragEvent(activeDrag.source, 'dragend', activeDrag.transfer)
    activeDesktopControlDataTransfer = null
  }
}

function dragDesktopControlDataTransfer(command: DesktopControlCommand): string {
  startDesktopControlDataTransfer(command)
  return endDesktopControlDataTransfer(command)
}

function contextMenuDesktopControlElement(selector: string): string {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      ...desktopControlEventOptions(element),
      button: 2,
      buttons: 0,
    })
  )
  return element.textContent?.trim() ?? ''
}

async function doubleClickDesktopControlElement(selector: string): Promise<string> {
  const dispatchClick = (element: HTMLElement, detail: number) => {
    const pressedOptions = {
      ...desktopControlEventOptions(element),
      button: 0,
      buttons: 1,
      detail,
    }
    const releasedOptions = { ...pressedOptions, buttons: 0 }
    dispatchDesktopControlPointerEvent(element, 'pointerdown', pressedOptions)
    element.dispatchEvent(new MouseEvent('mousedown', pressedOptions))
    dispatchDesktopControlPointerEvent(element, 'pointerup', releasedOptions)
    element.dispatchEvent(new MouseEvent('mouseup', releasedOptions))
    element.dispatchEvent(new MouseEvent('click', releasedOptions))
  }

  const firstElement = findDesktopControlElements(selector)[0]
  if (!firstElement) throw new Error(`Unable to find selector "${selector}"`)
  if (!desktopControlElementEnabled(firstElement)) {
    throw new Error(`Selector "${selector}" is disabled`)
  }
  dispatchClick(firstElement, 1)
  await waitForDesktopControlTick()

  const secondElement = findDesktopControlElements(selector)[0]
  if (!secondElement) throw new Error(`Unable to find selector "${selector}" after first click`)
  if (!desktopControlElementEnabled(secondElement)) {
    throw new Error(`Selector "${selector}" became disabled after first click`)
  }
  dispatchClick(secondElement, 2)
  secondElement.dispatchEvent(
    new MouseEvent('dblclick', {
      ...desktopControlEventOptions(secondElement),
      button: 0,
      buttons: 0,
      detail: 2,
    })
  )
  return secondElement.textContent?.trim() ?? ''
}

async function waitForDesktopControlElement(command: DesktopControlCommand): Promise<string> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const startedAt = Date.now()
  let matchedAt: number | null = null

  while (Date.now() - startedAt < timeoutMs) {
    const elements = findDesktopControlElements(command.selector)
    if (command.visible === false) {
      const visibleElements = elements.filter(desktopControlElementVisible)
      if (visibleElements.length === 0) {
        matchedAt ??= Date.now()
        if (Date.now() - matchedAt >= (command.stableMs ?? 0)) return ''
      } else {
        matchedAt = null
      }
      await waitForDesktopControlTick()
      continue
    }

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

  const diagnostics = findDesktopControlElements(command.selector).map(element => ({
    className: element.className,
    dataPresentation: element.dataset.presentation ?? null,
    hidden: element.hidden,
    ariaHidden: element.getAttribute('aria-hidden'),
    rendered: desktopControlElementRendered(element),
    visible: desktopControlElementVisible(element),
    rect: element.getBoundingClientRect().toJSON(),
  }))
  throw new Error(
    `Timed out waiting for selector "${command.selector}"${
      command.text ? ` containing "${command.text}"` : ''
    }; matches=${JSON.stringify(diagnostics)}`
  )
}

function fillDesktopControlElement(element: HTMLElement, value: string) {
  element.focus()

  const codeMirrorRoot = element.closest<HTMLElement>('.cm-editor')
  const codeMirrorView = codeMirrorRoot ? EditorView.findFromDOM(codeMirrorRoot) : null
  if (codeMirrorView) {
    codeMirrorView.dispatch({
      changes: { from: 0, to: codeMirrorView.state.doc.length, insert: value },
      selection: { anchor: value.length },
      scrollIntoView: true,
    })
    codeMirrorView.focus()
    return
  }

  if (element instanceof HTMLSelectElement) {
    selectDesktopControlOption(element, value)
    return
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
  const elements = findDesktopControlElements(selector)
  const wholeElement = value
    ? elements.find(element => element.textContent?.trim() === value)
    : undefined
  if (wholeElement) {
    const range = document.createRange()
    range.selectNodeContents(wholeElement)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    return value
  }
  let selectedNode: Node | null = null
  let selectedValue = value
  let fallbackNode: Node | null = null
  for (const element of elements) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const text = node.textContent ?? ''
      if (value && text.trim() === value) {
        selectedNode = node
        break
      }
      if (value && !fallbackNode && text.includes(value)) fallbackNode = node
      if (!value && text.trim()) {
        selectedNode = node
        selectedValue = text.trim()
        break
      }
      node = walker.nextNode()
    }
    if (selectedNode) break
  }
  selectedNode ??= fallbackNode
  if (!selectedNode) {
    throw new Error(
      value
        ? `Unable to find text "${value}" inside selector "${selector}"`
        : `Unable to find non-empty text inside selector "${selector}"`
    )
  }

  const start = selectedNode.textContent?.indexOf(selectedValue) ?? -1
  const range = document.createRange()
  range.setStart(selectedNode, start)
  range.setEnd(selectedNode, start + selectedValue.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  return selectedValue
}

type XtermAutomationTarget = HTMLElement & {
  __weworkInputForE2E?: (value: string) => void
  __weworkTextForE2E?: () => string
  __weworkSelectTextForE2E?: (value: string) => string
}

function findXtermAutomationTarget(root: HTMLElement | null): XtermAutomationTarget | null {
  if (!root) return null
  const candidates = [root, ...root.querySelectorAll<HTMLElement>('*')]
  return (
    candidates.find(candidate => {
      const target = candidate as XtermAutomationTarget
      return Boolean(
        target.__weworkInputForE2E || target.__weworkTextForE2E || target.__weworkSelectTextForE2E
      )
    }) ?? null
  )
}

function getDesktopControlTerminalText(selector: string): string {
  const terminalRoot = findDesktopControlElements(selector)[0]
  const target = findXtermAutomationTarget(terminalRoot ?? null)
  if (!target?.__weworkTextForE2E) {
    throw new Error(`Unable to locate the xterm text bridge inside "${selector}"`)
  }
  return target.__weworkTextForE2E()
}

function selectDesktopControlTerminalText(selector: string, value: string): string {
  const lines = findDesktopControlElements(selector)
  let line: HTMLElement | undefined
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.textContent?.includes(value)) {
      line = lines[index]
      break
    }
  }
  if (!line) throw new Error(`Unable to find terminal text "${value}" inside "${selector}"`)
  const terminalRoot = line.closest<HTMLElement>(
    '[data-testid="embedded-local-terminal"], [data-testid="remote-terminal"]'
  )
  const selectedText =
    findXtermAutomationTarget(terminalRoot)?.__weworkSelectTextForE2E?.(value) ?? ''
  if (selectedText !== value) {
    throw new Error(`Unable to select terminal text "${value}" from the xterm buffer`)
  }
  return selectedText
}

function inputDesktopControlTerminal(selector: string, value: string): string {
  const terminalRoot = findDesktopControlElements(selector)[0]
  const target = findXtermAutomationTarget(terminalRoot ?? null)
  if (!target?.__weworkInputForE2E) {
    throw new Error(`Unable to locate the xterm input bridge inside "${selector}"`)
  }
  target.__weworkInputForE2E(value)
  return value
}

function setDesktopControlSelectionOffset(selector: string, value: string): string {
  const element = findDesktopControlElements(selector)[0]
  if (!element) throw new Error(`Unable to find selector "${selector}"`)
  const trimmedValue = value.trim()
  const offset = Number(trimmedValue)
  if (trimmedValue === '' || !Number.isInteger(offset) || offset < 0) {
    throw new Error('setSelectionOffset requires a non-negative integer')
  }

  element.focus()
  const range = document.createRange()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) {
      range.setStart(node, remaining)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return String(offset)
    }
    remaining -= length
    node = walker.nextNode()
  }

  if (offset === 0) {
    range.selectNodeContents(element)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return '0'
  }
  throw new Error(`Selection offset ${offset} exceeds the text length`)
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

function pasteDesktopControlFile(command: DesktopControlCommand): string {
  const element = findDesktopControlElements(command.selector)[0]
  if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
  const filename = command.filename?.trim()
  if (!filename) throw new Error('pasteFile requires a filename')
  const binary = window.atob(command.value ?? '')
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const file = new File([bytes], filename, { type: command.mimeType ?? '' })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    composed: true,
  })
  Object.defineProperty(event, 'clipboardData', { value: transfer })
  element.dispatchEvent(event)
  return filename
}

function pasteDesktopControlText(command: DesktopControlCommand): string {
  const element = findDesktopControlElements(command.selector)[0]
  if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
  const text = command.value ?? ''
  const transfer = new DataTransfer()
  transfer.setData('text/plain', text)
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    composed: true,
  })
  Object.defineProperty(event, 'clipboardData', { value: transfer })
  element.focus()
  element.dispatchEvent(event)
  return text
}

function dispatchDesktopControlPaths(
  command: DesktopControlCommand,
  eventType: 'drop' | 'paste'
): string {
  const element = findDesktopControlElements(command.selector)[0]
  if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
  const descriptors = JSON.parse(command.value ?? '[]') as Array<{
    uri: string
    name: string
    mimeType?: string
    isDirectory?: boolean
  }>
  if (descriptors.length === 0) {
    throw new Error(
      `${eventType === 'drop' ? 'dropPaths' : 'pastePaths'} requires at least one path`
    )
  }

  const transfer = new DataTransfer()
  for (const descriptor of descriptors) {
    const file = new File(descriptor.isDirectory ? [] : ['path-reference'], descriptor.name, {
      type: descriptor.mimeType ?? '',
    })
    transfer.items.add(file)
    const item = transfer.items[transfer.items.length - 1]
    if (item && descriptor.isDirectory) {
      Object.defineProperty(item, 'webkitGetAsEntry', {
        value: () => ({ isDirectory: true }),
      })
    }
  }
  transfer.setData('text/uri-list', descriptors.map(descriptor => descriptor.uri).join('\r\n'))
  const event =
    eventType === 'drop'
      ? new DragEvent('drop', { bubbles: true, cancelable: true, composed: true })
      : new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, eventType === 'drop' ? 'dataTransfer' : 'clipboardData', {
    value: transfer,
  })
  element.dispatchEvent(event)
  return descriptors.map(descriptor => descriptor.name).join(',')
}

async function executeDesktopControlCommand(command: DesktopControlCommand): Promise<string> {
  const getWindowFocusSnapshot = () =>
    invokeDesktopHost<Record<string, unknown>>('e2e.getWindowFocusSnapshot').then(snapshot =>
      JSON.stringify(snapshot)
    )

  const verificationResult = await executeVerificationControlCommand(command, {
    elementEnabled: desktopControlElementEnabled,
  })
  if (verificationResult.handled) return verificationResult.value

  switch (command.action) {
    case 'getRoute':
      return stripAppBasePath(window.location.pathname)
    case 'getNativeWindowState':
      return JSON.stringify(await invokeDesktopHost('window.getState'))
    case 'getStartupSplashSnapshot':
      return JSON.stringify(await invokeDesktopHost('e2e.getStartupSplashSnapshot'))
    case 'getTraySnapshot':
      return JSON.stringify(await invokeDesktopHost('e2e.getTraySnapshot'))
    case 'activateTray':
      return JSON.stringify(
        await invokeDesktopHost('e2e.activateTray', {
          activation: JSON.parse(command.value ?? '{}'),
        })
      )
    case 'restoreMainWindow':
      await invokeDesktopHost('e2e.focusMainWindow')
      return ''
    case 'getComputedStyleValue': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const property = command.value?.trim()
      if (!property) throw new Error('getComputedStyleValue requires a CSS property')
      return getComputedStyle(element).getPropertyValue(property).trim()
    }
    case 'capture':
      return captureDesktopControlScreenshot(command.selector)
    case 'capturePopoutWindow':
      return invokeDesktopHost<string>('e2e.capturePopoutWindow')
    case 'captureWorkspaceWindow':
      return invokeDesktopHost<string>('e2e.captureWorkspaceWindow')
    case 'captureEmbeddedBrowser':
      return captureEmbeddedBrowserWhenReady(command)
    case 'getEmbeddedBrowserPageState':
      return JSON.stringify(
        await invokeDesktopHost('browser.pageState', {
          label: command.value,
        })
      )
    case 'setEmbeddedBrowserAgentControlPaused': {
      const input = JSON.parse(command.value ?? '{}') as {
        label?: string
        paused?: boolean
      }
      if (!input.label?.trim()) {
        throw new Error('setEmbeddedBrowserAgentControlPaused requires label')
      }
      await invokeDesktopHost('browser.setAgentControlPaused', {
        label: input.label,
        paused: input.paused ?? false,
      })
      return ''
    }
    case 'verifyEmbeddedBrowserDetachedInspector':
      return JSON.stringify(
        await invokeDesktopHost('e2e.verifyEmbeddedBrowserDetachedInspector', {
          label: command.value || undefined,
        })
      )
    case 'closeMainWindowToTray':
      return ''
    case 'requestMainWindowClose':
      return ''
    case 'reloadMainWindow': {
      if (command.value === 'capture') return captureDesktopControlScreenshot(command.selector)
      const storageInput = reloadMainWindowLocalStorageInput(command)
      if (storageInput) {
        window.localStorage.setItem(storageInput.key, storageInput.value)
      }
      await flushDesktopLocalStoragePersistence()
      return ''
    }
    case 'getTestIdOrder':
      return desktopControlTestIdOrder(command.selector)
    case 'reorderRuntimeProjectTasks':
      return JSON.stringify(
        await requestLocalExecutor(
          'runtime.sidebar.tasks.reorder',
          JSON.parse(command.value ?? '{}')
        )
      )
    case 'getLocalRuntimeWork':
      return JSON.stringify(await requestLocalExecutor('runtime.tasks.list', {}))
    case 'dispatchLocalModelSettingsChanged':
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      return ''
    case 'dispatchRuntimeLifecycleEvent':
      window.dispatchEvent(
        new CustomEvent('wework:e2e:runtime-task-lifecycle', {
          detail: JSON.parse(command.value ?? '{}'),
        })
      )
      if (command.key) {
        await waitForDesktopControlTick()
        return pressDesktopControlKey(command.target ?? command.selector, command.key)
      }
      return ''
    case 'activateRuntimeTaskCompletionNotification': {
      const address = JSON.parse(command.value ?? '{}') as RuntimeTaskAddress
      await invokeDesktopHost('e2e.activateRuntimeTaskNotification', {
        taskAddressId: createTrayTaskMenuId(address),
      })
      return ''
    }
    case 'getSystemNotifications':
      return JSON.stringify(
        (
          globalThis as typeof globalThis & {
            __WEWORK_E2E_SYSTEM_NOTIFICATIONS__?: {
              notifications: Array<{
                title: string
                body: string
                address?: RuntimeTaskAddress
              }>
            }
          }
        ).__WEWORK_E2E_SYSTEM_NOTIFICATIONS__?.notifications ?? []
      )
    case 'clearSystemNotifications': {
      const root = globalThis as typeof globalThis & {
        __WEWORK_E2E_SYSTEM_NOTIFICATIONS__?: {
          notifications: Array<{
            title: string
            body: string
            address?: RuntimeTaskAddress
          }>
        }
      }
      root.__WEWORK_E2E_SYSTEM_NOTIFICATIONS__ = { notifications: [] }
      return ''
    }
    case 'reconcileLegacyRuntimeAssistantSnapshot': {
      const payload = JSON.parse(command.value ?? '{}') as {
        address: RuntimeTaskAddress
        content: string
        itemId: string
      }
      const targetMessage = getRuntimeConversationMessagesForLogicalAddress(payload.address)
        .toReversed()
        .find(
          message =>
            message.role === 'assistant' &&
            (message.content === payload.content ||
              message.blocks?.some(
                block => block.type === 'text' && block.content === payload.content
              ))
        )
      const turnId = targetMessage?.turnId ?? targetMessage?.subtaskId
      if (!turnId) {
        throw new Error('Unable to find the runtime turn for the legacy assistant snapshot')
      }
      reconcileRuntimeConversationSnapshot(payload.address, [
        {
          id: turnId,
          items: [
            {
              id: payload.itemId,
              type: 'assistant_text',
              content: payload.content,
              createdAt: new Date().toISOString(),
            },
          ],
          status: 'done',
        },
      ])
      return turnId
    }
    case 'getRuntimeConversationMessages': {
      const address = JSON.parse(command.value ?? '{}') as RuntimeTaskAddress
      return JSON.stringify(getRuntimeConversationMessagesForLogicalAddress(address))
    }
    case 'storeLocalProxyUrl':
      return JSON.stringify(saveLocalProxyUrl(command.value?.trim() ?? ''))
    case 'getLocalStorageItem':
      return localStorage.getItem(command.value ?? '') ?? ''
    case 'setLocalStorageItem': {
      const input = JSON.parse(command.value ?? '{}') as { key?: string; value?: string }
      if (!input.key) throw new Error('setLocalStorageItem requires a key')
      localStorage.setItem(input.key, input.value ?? '')
      return localStorage.getItem(input.key) ?? ''
    }
    case 'removeLocalStorageItem':
      localStorage.removeItem(command.value ?? '')
      return ''
    case 'getLocationOrigin':
      return window.location.origin
    case 'restartCoreDsh':
      await flushDesktopLocalStoragePersistence()
      await invokeDesktopHost('runtime.restartCoreDsh')
      return ''
    case 'setEmbeddedBrowserLocalStorageItem':
      return (await setEmbeddedBrowserLocalStorageItem(command)) ?? ''
    case 'getEmbeddedBrowserLocalStorageItem':
      return (await getEmbeddedBrowserLocalStorageItem(command)) ?? ''
    case 'setEmbeddedBrowserWindowValue':
      return (await setEmbeddedBrowserWindowValue(command)) ?? ''
    case 'getEmbeddedBrowserWindowValue':
      return (await getEmbeddedBrowserWindowValue(command)) ?? ''
    case 'setLocalProxyUrl': {
      const proxyUrl = command.value?.trim() ?? ''
      const config = saveLocalProxyUrl(proxyUrl)
      await requestLocalExecutor('runtime.codex.runtime_config.update', {
        proxyUrl: proxyUrl || null,
      })
      return JSON.stringify(config)
    }
    case 'setLocalHarnessExecutablePaths': {
      const executablePaths = JSON.parse(command.value ?? '{}') as Partial<
        Record<LocalHarnessId, string>
      >
      const preferences = await getAppPreferences()
      const updated = await updateAppPreferences({
        localHarnesses: preferences.localHarnesses.map(preference => ({
          ...preference,
          executablePath: executablePaths[preference.id]?.trim() || null,
        })),
      })
      return JSON.stringify(updated.localHarnesses)
    }
    case 'setAppPreferences': {
      const patch = JSON.parse(command.value ?? '{}') as AppPreferencesPatch
      const preferences = await updateAppPreferences(patch)
      return JSON.stringify(preferences)
    }
    case 'toggleSidebar': {
      const event = new Event('wework:desktop-sidebar-toggle-request', { cancelable: true })
      window.dispatchEvent(event)
      if (!event.defaultPrevented) {
        throw new Error('No desktop sidebar handled the toggle request')
      }
      return ''
    }
    case 'performanceSnapshot': {
      const processMemory = navigator.platform.toLowerCase().includes('mac')
        ? await invokeDesktopHost('e2e.getProcessSnapshot')
        : null
      return JSON.stringify({
        timestamp: Date.now(),
        domNodeCount: document.getElementsByTagName('*').length,
        runtimeConversationCache: getRuntimeConversationCacheStats(),
        processMemory,
      })
    }
    case 'focusMainWindow':
      await invokeDesktopHost('e2e.focusMainWindow')
      return ''
    case 'setMainWindowSize': {
      const nextSize = JSON.parse(command.value ?? '{}') as {
        width?: number
        height?: number
      }
      if (
        !Number.isFinite(nextSize.width) ||
        !Number.isFinite(nextSize.height) ||
        Number(nextSize.width) <= 0 ||
        Number(nextSize.height) <= 0
      ) {
        throw new Error('setMainWindowSize requires positive width and height')
      }
      return JSON.stringify(
        await invokeDesktopHost('e2e.setMainWindowSize', {
          width: Number(nextSize.width),
          height: Number(nextSize.height),
        })
      )
    }
    case 'getWindowFocusSnapshot':
      return getWindowFocusSnapshot()
    case 'getDesktopRuntimeDiagnostics':
      return JSON.stringify(await invokeDesktopHost('e2e.getRuntimeDiagnostics'))
    case 'showSystemDragPanel': {
      await invokeDesktopHost<void>('systemDrag.showPanel')
      return ''
    }
    case 'getSystemDragPanelVisibility':
      return String(await invokeDesktopHost<boolean>('systemDrag.panelVisible'))
    case 'completeSystemDragDrop':
      await invokeDesktopHost('systemDrag.complete', {
        payload: JSON.parse(command.value ?? '{}'),
      })
      await new Promise(resolve => window.setTimeout(resolve, 250))
      return getWindowFocusSnapshot()
    case 'dismissPopoutWindow':
      await invokeDesktopHost('window.dismissPopout')
      return ''
    case 'showPopoutWindow':
      await invokeDesktopHost('window.showPopout')
      return ''
    case 'drag':
      return dragDesktopControlElement(command)
    case 'dragDataTransfer':
      return dragDesktopControlDataTransfer(command)
    case 'dragDataTransferStart':
      return startDesktopControlDataTransfer(command)
    case 'dragDataTransferEnd':
      return endDesktopControlDataTransfer(command)
    case 'contextMenu':
      return contextMenuDesktopControlElement(command.selector)
    case 'doubleClick':
      return doubleClickDesktopControlElement(command.selector)
    case 'dragStart':
      return startDesktopControlDrag(command)
    case 'dragEnd':
      return endDesktopControlDrag(command)
    case 'dropFile':
      return dropDesktopControlFile(command)
    case 'dropPaths':
      return dispatchDesktopControlPaths(command, 'drop')
    case 'pasteFile':
      return pasteDesktopControlFile(command)
    case 'pastePaths':
      return dispatchDesktopControlPaths(command, 'paste')
    case 'pasteText':
      return pasteDesktopControlText(command)
    case 'waitFor':
      return waitForDesktopControlElement(command)
    case 'getText':
      return desktopControlElementText(command.selector, command.visible)
    case 'getTerminalText':
      return getDesktopControlTerminalText(command.selector)
    case 'getElementCount':
      return String(
        command.visible
          ? findDesktopControlElements(command.selector).filter(desktopControlElementVisible).length
          : findDesktopControlElements(command.selector).length
      )
    case 'sampleElementPresence': {
      const durationMs = Number(command.value)
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('sampleElementPresence requires a finite positive durationMs')
      }
      const startedAt = performance.now()
      let maxCount = 0
      let samples = 0
      while (performance.now() - startedAt < durationMs) {
        maxCount = Math.max(maxCount, findDesktopControlElements(command.selector).length)
        samples += 1
        await waitForDesktopControlTick()
      }
      return JSON.stringify({ observed: maxCount > 0, maxCount, samples })
    }
    case 'getElementMetrics':
      return desktopControlElementMetrics(command.selector)
    case 'startElementMetricsSampling': {
      const durationMs = Number(command.value)
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('startElementMetricsSampling requires a finite positive durationMs')
      }
      const initialElements = findDesktopControlElements(command.selector)
      const initialElement = command.visible
        ? initialElements.find(desktopControlElementVisible)
        : initialElements[0]
      if (!initialElement) throw new Error(`Unable to find selector "${command.selector}"`)
      activeElementMetricsSample?.stop()
      const startedAt = performance.now()
      let animationFrame = 0
      const sample: ElementMetricsSample = {
        done: false,
        frames: [],
        stop: () => {},
      }
      const finish = () => {
        if (sample.done) return
        sample.done = true
        if (animationFrame) window.cancelAnimationFrame(animationFrame)
      }
      const captureFrame = (time: number) => {
        const element = initialElement
        const rect = element?.getBoundingClientRect()
        const testIds = element
          ? [element, ...element.querySelectorAll<HTMLElement>('[data-testid]')]
              .map(candidate => candidate.dataset.testid)
              .filter((testId): testId is string => Boolean(testId))
          : []
        sample.frames.push({
          connected: element?.isConnected ?? false,
          height: rect?.height ?? 0,
          label: element?.dataset.weworkBrowserWebview ?? null,
          left: rect?.left ?? 0,
          testIds,
          time: time - startedAt,
          top: rect?.top ?? 0,
          visibility: element ? window.getComputedStyle(element).visibility : '',
          width: rect?.width ?? 0,
        })
        if (time - startedAt >= durationMs) {
          finish()
          return
        }
        animationFrame = window.requestAnimationFrame(captureFrame)
      }
      sample.stop = finish
      activeElementMetricsSample = sample
      animationFrame = window.requestAnimationFrame(captureFrame)
      return ''
    }
    case 'getElementMetricsSample': {
      const sample = activeElementMetricsSample
      if (!sample) throw new Error('Element metrics sampling has not started')
      return JSON.stringify({
        done: sample.done,
        frames: sample.frames,
      })
    }
    case 'startScrollStabilitySampling': {
      const options = JSON.parse(command.value ?? '{}') as {
        anchorText?: string
        durationMs?: number
        scrollerSelector?: string
      }
      const durationMs = options.durationMs ?? 1_000
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('sampleScrollStability requires a finite positive durationMs')
      }
      const scrollerSelector = options.scrollerSelector?.trim()
      if (!scrollerSelector) {
        throw new Error('sampleScrollStability requires scrollerSelector')
      }
      const scroller = findDesktopControlElements(scrollerSelector)[0]
      if (!scroller) throw new Error(`Unable to find selector "${scrollerSelector}"`)
      activeScrollStabilitySample?.stop()
      const startedAt = performance.now()
      let sampleTimer = 0
      let mutationObserver: MutationObserver | null = null
      const sample: ScrollStabilitySample = {
        done: false,
        frames: [],
        missingFrames: 0,
        scrollEvents: [],
        stop: () => {},
      }
      const capture = (time: number): ScrollStabilitySamplePoint | null => {
        const anchors = findDesktopControlElements(command.selector)
        const anchor = options.anchorText
          ? anchors.find(candidate => candidate.textContent?.includes(options.anchorText ?? ''))
          : anchors[0]
        if (!anchor) return null
        return {
          anchorTop: anchor.getBoundingClientRect().top,
          clientHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
          scrollOrigin: scroller.dataset.scrollOrigin === 'bottom' ? 'bottom' : 'top',
          scrollTop: scroller.scrollTop,
          time: time - startedAt,
        }
      }
      const handleScroll = () => {
        const point = capture(performance.now())
        if (point) sample.scrollEvents.push(point)
      }
      const finish = () => {
        if (sample.done) return
        sample.done = true
        scroller.removeEventListener('scroll', handleScroll)
        mutationObserver?.disconnect()
      }
      sample.stop = () => {
        window.clearInterval(sampleTimer)
        finish()
      }
      scroller.addEventListener('scroll', handleScroll)
      mutationObserver = new MutationObserver(() => {
        const point = capture(performance.now())
        if (point) sample.frames.push(point)
        else sample.missingFrames += 1
      })
      mutationObserver.observe(scroller, {
        characterData: true,
        childList: true,
        subtree: true,
      })
      const captureFrame = () => {
        const time = performance.now()
        const point = capture(time)
        if (point) sample.frames.push(point)
        else sample.missingFrames += 1
        if (time - startedAt >= durationMs) {
          window.clearInterval(sampleTimer)
          finish()
        }
      }
      captureFrame()
      sampleTimer = window.setInterval(captureFrame, 16)
      activeScrollStabilitySample = sample
      return ''
    }
    case 'getScrollStabilitySample': {
      const sample = activeScrollStabilitySample
      if (!sample) throw new Error('Scroll stability sampling has not started')
      return JSON.stringify({
        done: sample.done,
        frames: sample.frames,
        missingFrames: sample.missingFrames,
        scrollEvents: sample.scrollEvents,
      })
    }
    case 'getAttribute': {
      const elements = findDesktopControlElements(command.selector)
      const candidates = command.visible ? elements.filter(desktopControlElementVisible) : elements
      const element = command.text
        ? candidates.find(candidate => candidate.textContent?.includes(command.text ?? ''))
        : candidates[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const attribute = command.value?.trim()
      if (!attribute) throw new Error('getAttribute requires an attribute name')
      return element.getAttribute(attribute) ?? ''
    }
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
      const declaredValue =
        element.getAttribute('data-value') ?? element.firstElementChild?.getAttribute('data-value')
      if (declaredValue !== null && declaredValue !== undefined) return declaredValue
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
    case 'getClipboardText':
      return invokeDesktopHost<string>('e2e.getClipboardText')
    case 'downloadPendingAppUpdate':
      await downloadPendingWeworkUpdate()
      return 'downloaded'
    case 'scrollIntoView': {
      const elements = findDesktopControlElements(command.selector)
      const element = command.visible ? elements.find(desktopControlElementRendered) : elements[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      return element.textContent?.trim() ?? ''
    }
    case 'expandProcessingSummaries':
      return expandDesktopProcessingSummaries()
    case 'scrollIntoViewAsUser': {
      const elements = findDesktopControlElements(command.selector)
      const element = command.text
        ? elements.find(candidate => candidate.textContent?.includes(command.text ?? ''))
        : elements[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const text = element.textContent?.trim() ?? ''
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          deltaY: -120,
        })
      )
      element.scrollIntoView({
        block: command.value === 'start' ? 'start' : 'center',
        inline: 'nearest',
      })
      return text
    }
    case 'scrollToBottomAsUser': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          deltaY: 120,
        })
      )
      element.scrollTop =
        element.dataset.scrollOrigin === 'bottom'
          ? 0
          : Math.max(0, element.scrollHeight - element.clientHeight)
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      return String(element.scrollTop)
    }
    case 'scrollFromBottomAsUser': {
      const scroller = findDesktopControlElements(command.selector)[0]
      if (!scroller) throw new Error(`Unable to find selector "${command.selector}"`)
      const distance = Number(command.value)
      if (!Number.isFinite(distance) || distance < 0) {
        throw new Error('scrollFromBottomAsUser requires a non-negative distance')
      }

      scroller.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          deltaY: -Math.max(120, distance),
        })
      )
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop =
        scroller.dataset.scrollOrigin === 'bottom'
          ? -Math.min(distance, maxScrollTop)
          : Math.max(0, maxScrollTop - distance)
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      return String(scroller.scrollTop)
    }
    case 'scrollToRatioAsUser': {
      const scroller = findDesktopControlElements(command.selector)[0]
      if (!scroller) throw new Error(`Unable to find selector "${command.selector}"`)
      const ratio = Number(command.value)
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        throw new Error('scrollToRatioAsUser requires a value between 0 and 1')
      }

      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const nextContentScrollTop = maxScrollTop * ratio
      const currentContentScrollTop = desktopControlContentScrollTop(scroller)
      scroller.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          deltaY: nextContentScrollTop < currentContentScrollTop ? -120 : 120,
        })
      )
      scroller.scrollTop = desktopControlDomScrollTop(scroller, nextContentScrollTop)
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      return String(scroller.scrollTop)
    }
    case 'sampleRapidScrollContent': {
      const scroller = findDesktopControlElements(command.selector)[0]
      if (!scroller) throw new Error(`Unable to find selector "${command.selector}"`)
      const options = JSON.parse(command.value ?? '{}') as {
        contentSelector?: string
        ratios?: number[]
      }
      const contentSelector = options.contentSelector?.trim()
      if (!contentSelector) {
        throw new Error('sampleRapidScrollContent requires contentSelector')
      }
      const ratios = options.ratios ?? []
      if (
        ratios.length === 0 ||
        ratios.some(ratio => !Number.isFinite(ratio) || ratio < 0 || ratio > 1)
      ) {
        throw new Error('sampleRapidScrollContent requires ratios between 0 and 1')
      }

      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const viewport = scroller.getBoundingClientRect()
      const samples = ratios.map(ratio => {
        const nextContentScrollTop = maxScrollTop * ratio
        const currentContentScrollTop = desktopControlContentScrollTop(scroller)
        scroller.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            composed: true,
            deltaY: nextContentScrollTop < currentContentScrollTop ? -120 : 120,
          })
        )
        scroller.scrollTop = desktopControlDomScrollTop(scroller, nextContentScrollTop)
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }))

        const hasVisibleContent = Array.from(
          scroller.querySelectorAll<HTMLElement>(contentSelector)
        ).some(element => {
          if (!element.textContent?.trim()) return false
          const bounds = element.getBoundingClientRect()
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom
        })
        return { hasVisibleContent, ratio, scrollTop: scroller.scrollTop }
      })
      return JSON.stringify(samples)
    }
    case 'click': {
      const elements = findDesktopControlElements(command.selector)
      const element = command.visible ? elements.find(desktopControlElementVisible) : elements[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      if (!desktopControlElementEnabled(element)) {
        throw new Error(`Selector "${command.selector}" is disabled`)
      }
      element.click()
      return element.textContent?.trim() ?? ''
    }
    case 'clickThenMacrotask': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      if (!desktopControlElementEnabled(element)) {
        throw new Error(`Selector "${command.selector}" is disabled`)
      }
      const targetSelector = command.target?.trim()
      if (!targetSelector) throw new Error('clickThenMacrotask requires target')

      element.click()
      await new Promise(resolve => window.setTimeout(resolve, 0))

      const target = findDesktopControlElements(targetSelector)[0]
      if (!target) throw new Error(`Unable to find target selector "${targetSelector}"`)
      if (!desktopControlElementEnabled(target)) {
        throw new Error(`Target selector "${targetSelector}" is disabled`)
      }
      target.click()
      return target.textContent?.trim() ?? ''
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
    case 'clickDescendantInElementWithText': {
      const text = command.text ?? ''
      const targetSelector = command.target?.trim()
      if (!text) throw new Error('clickDescendantInElementWithText requires text')
      if (!targetSelector) throw new Error('clickDescendantInElementWithText requires target')
      const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      const startedAt = Date.now()
      let lastFailure = `Unable to find selector "${command.selector}" containing "${text}"`
      while (Date.now() - startedAt < timeoutMs) {
        const container = findDesktopControlElements(command.selector).find(
          element =>
            (!command.visible || desktopControlElementVisible(element)) &&
            (element.textContent ?? '').includes(text)
        )
        const target = container?.querySelector<HTMLElement>(targetSelector)
        if (
          target &&
          (!command.visible || desktopControlElementVisible(target)) &&
          desktopControlElementEnabled(target)
        ) {
          target.scrollIntoView({ block: 'center', inline: 'nearest' })
          target.click()
          return target.textContent?.trim() ?? ''
        }
        if (container && !target) {
          lastFailure = `Unable to find descendant "${targetSelector}" inside "${command.selector}"`
        } else if (target && command.visible && !desktopControlElementVisible(target)) {
          lastFailure = `Descendant "${targetSelector}" inside "${command.selector}" is hidden`
        } else if (target && !desktopControlElementEnabled(target)) {
          lastFailure = `Descendant "${targetSelector}" inside "${command.selector}" is disabled`
        }
        await waitForDesktopControlTick()
      }
      throw new Error(lastFailure)
    }
    case 'markElementWithText': {
      const text = command.text ?? ''
      const value = command.value?.trim()
      if (!text) throw new Error('markElementWithText requires text')
      if (!value) throw new Error('markElementWithText requires value')
      const timeoutMs = command.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const element = findDesktopControlElements(command.selector).find(candidate =>
          (candidate.textContent ?? '').includes(text)
        )
        if (element) {
          element.dataset.e2eAnchorId = value
          return element.textContent?.trim() ?? ''
        }
        await waitForDesktopControlTick()
      }
      const candidates = findDesktopControlElements(command.selector)
        .slice(0, 20)
        .map(candidate => ({
          tagName: candidate.tagName.toLowerCase(),
          testId: candidate.dataset.testid ?? null,
        }))
      throw new Error(
        `Unable to find selector "${command.selector}" containing the requested text; candidateCount=${findDesktopControlElements(command.selector).length}; candidates=${JSON.stringify(candidates)}`
      )
    }
    case 'fill': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      fillDesktopControlElement(element, command.value ?? '')
      return element.textContent?.trim() ?? ''
    }
    case 'finishAnimations': {
      let finishedCount = 0
      for (const animation of document.getAnimations()) {
        try {
          animation.finish()
          finishedCount += 1
        } catch {
          // Infinite animations cannot be finished and are unrelated to layout settling.
        }
      }
      return String(finishedCount)
    }
    case 'getWorkbenchDebugSnapshot':
      return JSON.stringify(getWorkbenchDebugSnapshot())
    case 'getComposerDiagnosticsSnapshot':
      return JSON.stringify(getComposerDiagnosticsSnapshot())
    case 'getComposerFocusSnapshot': {
      const activeElement = document.activeElement
      const inputs = findDesktopControlElements('[data-testid="chat-message-input"]').map(input => {
        const rect = input.getBoundingClientRect()
        return {
          active: input === activeElement,
          contentEditable: input.getAttribute('contenteditable'),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          visible: desktopControlElementVisible(input),
        }
      })
      return JSON.stringify({
        activeElement: activeElement
          ? {
              tagName: activeElement.tagName.toLowerCase(),
              testId: activeElement.getAttribute('data-testid'),
            }
          : null,
        inputs,
      })
    }
    case 'getActiveElementTestId':
      return document.activeElement?.getAttribute('data-testid') ?? ''
    case 'getLocalExecutorStatus':
      return JSON.stringify(await getLocalExecutorStatus())
    case 'getLocalExecutorLog':
      return JSON.stringify(await readLocalExecutorLog())
    case 'previewPluginImport': {
      const input = JSON.parse(command.value ?? '{}') as {
        archivePath?: string
        marketplacePath?: string
      }
      if (!input.archivePath || !input.marketplacePath) {
        throw new Error('previewPluginImport requires archivePath and marketplacePath')
      }
      return JSON.stringify(
        await requestLocalExecutor('executor.plugins.import_package.preview', {
          archivePath: input.archivePath,
          marketplacePath: input.marketplacePath,
        })
      )
    }
    case 'importPluginPackage': {
      const input = JSON.parse(command.value ?? '{}') as {
        preview?: LocalPluginImportPreview
        overwrite?: boolean
      }
      if (!input.preview?.valid) {
        throw new Error('importPluginPackage requires a valid import preview')
      }
      const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
      return JSON.stringify(
        await createLocalCodexPluginApi().importPluginPackage(
          input.preview,
          input.overwrite === true
        )
      )
    }
    case 'deleteLocalPluginPackage': {
      const input = JSON.parse(command.value ?? '{}') as {
        pluginId?: string
        pluginName?: string
      }
      if (!input.pluginId || !input.pluginName) {
        throw new Error('deleteLocalPluginPackage requires pluginId and pluginName')
      }
      const { createLocalCodexPluginApi } = await import('@/api/local/codexPlugins')
      const api = createLocalCodexPluginApi()
      await api.uninstallInstalledPlugin(input.pluginId)
      await api.deletePersonalPlugin(input.pluginName)
      return ''
    }
    case 'hover':
      return hoverDesktopControlElement(command.selector)
    case 'pointerLeave':
      return leaveDesktopControlElement(command.selector)
    case 'pointerDown':
      return pressDesktopControlPointer(command.selector)
    case 'pointerDownOnly': {
      await invokeDesktopHost('e2e.focusMainWindow')
      const result = startDesktopControlPointer(command.selector)
      await waitForDesktopControlTick()
      return result
    }
    case 'pointerUp': {
      const result = endDesktopControlPointer()
      await waitForDesktopControlTick()
      return result
    }
    case 'navigate': {
      const appPath = normalizeAppPath(command.value ?? '/')
      window.history.pushState(null, '', joinAppPath(getRuntimeConfig().appBasePath, appPath))
      dispatchNavigationEvents()
      return stripAppBasePath(window.location.pathname)
    }
    case 'pointerMove':
      return moveDesktopControlPointer(command)
    case 'press': {
      return pressDesktopControlKey(command.selector, command.key ?? '')
    }
    case 'select': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!(element instanceof HTMLSelectElement)) {
        throw new Error(`Selector "${command.selector}" is not a select element`)
      }
      return selectDesktopControlOption(element, command.value ?? '', command.by)
    }
    case 'submit': {
      const element = findDesktopControlElements(command.selector)[0]
      if (!element) throw new Error(`Unable to find selector "${command.selector}"`)
      const form = element instanceof HTMLFormElement ? element : element.closest('form')
      if (!form) throw new Error(`Selector "${command.selector}" is not associated with a form`)
      if (command.value !== undefined) {
        fillDesktopControlElement(element, command.value)
      }
      form.requestSubmit()
      return ''
    }
    case 'selectText':
      return selectDesktopControlText(command.selector, command.value ?? '')
    case 'selectTerminalText':
      return selectDesktopControlTerminalText(command.selector, command.value ?? '')
    case 'terminalInput':
      return inputDesktopControlTerminal(command.selector, command.value ?? '')
    case 'setSelectionOffset':
      return setDesktopControlSelectionOffset(command.selector, command.value ?? '')
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

async function postDesktopControlStarted(
  url: string,
  command: DesktopControlCommand,
  clientId: string
): Promise<void> {
  const response = await fetch(`${url}/started`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...desktopControlHeaders() },
    body: JSON.stringify({ id: command.id, clientId }),
  })
  if (!response.ok) {
    throw new Error(`Desktop E2E control start acknowledgement failed with ${response.status}`)
  }
}

async function runDesktopControlClient(url: string, windowLabel: string): Promise<void> {
  const clientId = crypto.randomUUID()
  const pollForCommand = () =>
    fetch(`${url}/commands?clientId=${encodeURIComponent(clientId)}&wait=1`, {
      headers: desktopControlHeaders(),
    })
  let commandRequest = pollForCommand()
  await waitForDesktopControlTick()
  const readyResponse = await fetch(`${url}/ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...desktopControlHeaders() },
    body: JSON.stringify({ clientId, location: window.location.href, windowLabel }),
  })
  if (!readyResponse.ok) {
    throw new Error(`Desktop E2E control registration failed with ${readyResponse.status}`)
  }

  while (true) {
    try {
      const response = await commandRequest
      if (response.status === 204) {
        commandRequest = pollForCommand()
        continue
      }
      if (!response.ok) {
        throw new Error(`Desktop E2E control command failed with ${response.status}`)
      }
      const command = (await response.json()) as DesktopControlCommand
      await postDesktopControlStarted(url, command, clientId)
      commandRequest = pollForCommand()
      try {
        const value = await executeDesktopControlCommand(command)
        await postDesktopControlResult(url, { id: command.id, clientId, ok: true, value })
        if (command.action === 'closeMainWindowToTray') {
          await invokeDesktopHost('e2e.hideMainWindow')
        } else if (command.action === 'requestMainWindowClose') {
          await invokeDesktopHost('e2e.closeMainWindow')
        } else if (command.action === 'reloadMainWindow') {
          window.location.reload()
          return
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
      await waitForDesktopControlTick()
      commandRequest = pollForCommand()
    }
  }
}

function installDesktopControlClient() {
  if (!isDesktopRuntime()) return
  const url = desktopControlUrl()
  const windowLabel = getDesktopWindowLabel()
  if (
    !url ||
    (windowLabel !== 'main' && !windowLabel.startsWith('workspace-')) ||
    window.location.pathname.startsWith('/system-drag')
  ) {
    return
  }
  void runDesktopControlClient(url, windowLabel)
}
