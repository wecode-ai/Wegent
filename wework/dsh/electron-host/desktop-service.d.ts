export interface WeworkDesktopDescription {
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
}

export interface WeworkDesktopWindowState {
  readonly minimized: boolean
  readonly maximized: boolean
  readonly fullScreen: boolean
  readonly focused: boolean
}

export type WeworkRendererHealthState =
  | 'loading'
  | 'ready'
  | 'unresponsive'
  | 'crashed'
  | 'recreating'
  | 'failed'

export interface WeworkRendererHealthSnapshot {
  readonly state: WeworkRendererHealthState
  readonly generation: number
  readonly crashCount: number
  readonly reason: string | null
  readonly updatedAt: string
}

export interface WeworkDesktopService {
  readonly app: {
    getVersion(): Promise<{ readonly version: string }>
  }
  readonly window: {
    getState(): Promise<WeworkDesktopWindowState>
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
  }
  readonly dialog: {
    open(options?: Record<string, unknown>): Promise<unknown>
    save(options?: Record<string, unknown>): Promise<unknown>
    message(options: Record<string, unknown>): Promise<unknown>
  }
  readonly notification: {
    show(options: {
      readonly title: string
      readonly body: string
      readonly taskAddressId?: string
    }): Promise<void>
  }
  readonly browser: {
    setRequestHeaderRule(rule: Record<string, unknown>): Promise<void>
    removeRequestHeaderRule(id: string): Promise<void>
    createBackgroundPage(id: string): Promise<BrowserBackgroundPageState>
    navigateBackgroundPage(id: string, url: string): Promise<BrowserBackgroundPageState>
    setBackgroundPageUserAgent(id: string, userAgent: string): Promise<BrowserBackgroundPageState>
    backgroundPageState(id: string): Promise<BrowserBackgroundPageState>
    closeBackgroundPage(id: string): Promise<void>
  }
  readonly secureStorage: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  readonly rendererHealth: {
    getState(): Promise<WeworkRendererHealthSnapshot>
  }
  readonly shell: {
    openExternal(url: string): Promise<void>
  }
  describe(): Promise<WeworkDesktopDescription>
}

export interface BrowserBackgroundPageState {
  readonly id: string
  readonly title: string | null
  readonly url: string | null
  readonly userAgent: string
  readonly isLoading: boolean
  readonly httpResponseCode: number | null
  readonly httpStatusText: string | null
  readonly navigationError: {
    readonly code: number
    readonly message: string
    readonly url: string | null
  } | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Electron capabilities scoped to the current Wework DSH generation. */
    weworkDesktop: WeworkDesktopService
  }
}

export declare const WEWORK_DESKTOP_SERVICE_KEY: 'weworkDesktop'

export declare function createWeworkDesktopService(client: {
  describe(): WeworkDesktopDescription
  invoke(capability: string, params?: Record<string, unknown>): Promise<unknown>
}): {
  readonly service: WeworkDesktopService
  dispose(): void
}
