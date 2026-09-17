import type { Context } from '@deepseek-ai/cordis'

export type WeworkPluginBackendMethod = (
  params: Readonly<Record<string, unknown>>
) => unknown | Promise<unknown>

export interface WeworkPluginBackendRegistration {
  readonly id: string
  readonly methods: Readonly<Record<string, WeworkPluginBackendMethod>>
}

export interface WeworkPluginRuntimeService {
  register(owner: Context, registration: WeworkPluginBackendRegistration): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    weworkPluginRuntime: WeworkPluginRuntimeService
  }
}

export declare const BASE_PATH: '/wework/plugins/v1/rpc'
export declare const inject: readonly ['webServer']
export declare const name: 'wework-plugin-runtime'
export declare function apply(ctx: Context): void
