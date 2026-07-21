import type { Connect, Plugin } from 'vite'

export interface VncAssetDefinition {
  readonly fileName: string
  readonly mime: string
}

export const VNC_ASSETS: readonly VncAssetDefinition[]

export function matchVncAsset(
  requestUrl: string | undefined,
  base: string
): VncAssetDefinition | null

export function createVncAssetsMiddleware(
  base: string,
  assetsDirectory?: string
): Connect.NextHandleFunction

export function createVncAssetsPlugin(assetsDirectory?: string, pluginModulePath?: string): Plugin
