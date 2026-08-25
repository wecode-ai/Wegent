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
    show(options: { readonly title: string; readonly body: string }): Promise<void>
  }
  readonly rendererHealth: {
    getState(): Promise<WeworkRendererHealthSnapshot>
  }
  readonly shell: {
    openExternal(url: string): Promise<void>
  }
  describe(): Promise<WeworkDesktopDescription>
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
