import { expect, type Page } from '@playwright/test'

type BridgeRuntimeConfig = {
  appBasePath: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  runtimeMode: 'local-first' | 'backend'
  loginMode: 'password' | 'oidc' | 'all'
  oidcLoginText: string
  cloudDeviceScalingWikiUrl: string
}

type TestLocalModelConnectionInput = {
  baseUrl: string
  modelId: string
  apiKey?: string | null
}

type TestLocalModelConnectionResult = {
  status: number
}

declare global {
  interface Window {
    __WEWORK_E2E__?: {
      version: 1
      isEnabled: true
      isTauri: () => boolean
      getRuntimeConfig: () => BridgeRuntimeConfig
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
  }
}

export class WeworkApp {
  constructor(private readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path)
    await this.waitForBridge()
  }

  async waitForBridge() {
    await expect
      .poll(() => this.page.evaluate(() => Boolean(window.__WEWORK_E2E__?.isEnabled)))
      .toBe(true)
  }

  async route() {
    return this.page.evaluate(() => window.__WEWORK_E2E__?.getRoute() ?? window.location.pathname)
  }

  async runtimeConfig() {
    return this.page.evaluate(() => window.__WEWORK_E2E__?.getRuntimeConfig())
  }

  async navigate(path: string) {
    await this.page.evaluate(nextPath => window.__WEWORK_E2E__?.navigate(nextPath), path)
  }

  async waitForTestId(testId: string, timeoutMs = 5000) {
    await this.page.evaluate(
      ([id, timeout]) => window.__WEWORK_E2E__?.waitForTestId(id, { timeoutMs: timeout }),
      [testId, timeoutMs] as const
    )
  }

  async testIds(prefix?: string) {
    return this.page.evaluate(value => window.__WEWORK_E2E__?.queryTestIds(value) ?? [], prefix)
  }

  async testLocalModelConnection(input: TestLocalModelConnectionInput) {
    return this.page.evaluate(
      value => window.__WEWORK_E2E__?.testLocalModelConnection(value),
      input
    )
  }

  async tripLocalModelConnectionCircuitBreaker(input: TestLocalModelConnectionInput) {
    return this.page.evaluate(
      value => window.__WEWORK_E2E__?.tripLocalModelConnectionCircuitBreaker(value),
      input
    )
  }
}
