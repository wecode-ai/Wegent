import { getRuntimeConfig, joinAppPath, stripAppBasePath } from '@/config/runtime'
import { removeToken, setToken } from '@/api/auth'
import {
  testLocalModelConnection,
  type TestLocalModelConnectionInput,
  type TestLocalModelConnectionResult,
} from '@/features/model-settings/localModelConnectionTest'
import { isTauriRuntime } from '@/lib/runtime-environment'

const DEFAULT_WAIT_TIMEOUT_MS = 5000
const LOCAL_MODEL_SEND_CIRCUIT_BREAKER_ERROR =
  'WEWORK_E2E_LOCAL_MODEL_SEND_CIRCUIT_OPEN'

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

function isAutomationEnabled(): boolean {
  return import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true'
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
  if (!isAutomationEnabled() || typeof window === 'undefined') {
    return
  }

  window.__WEWORK_E2E__ = createBridge()
}
