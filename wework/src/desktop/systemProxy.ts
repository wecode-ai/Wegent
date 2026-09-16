import { getLocalProxyUrl } from '@/features/model-settings/localProxySettings'

export type LocalCodexProxySource = 'direct' | 'system' | 'wework'

export interface EffectiveLocalCodexProxy {
  proxyUrl: string | null
  source: LocalCodexProxySource
}

let resolvedSystemProxyUrl: string | null = null

declare global {
  interface Window {
    weworkElectronNetwork?: {
      resolveCodexProxy(): Promise<string | null>
    }
  }
}

export async function resolveEffectiveLocalCodexProxy(): Promise<EffectiveLocalCodexProxy> {
  const configuredProxy = getLocalProxyUrl().trim()
  if (configuredProxy) {
    return {
      proxyUrl: configuredProxy,
      source: 'wework',
    }
  }

  const systemProxy = await window.weworkElectronNetwork?.resolveCodexProxy()
  const proxyUrl = systemProxy?.trim() || null
  resolvedSystemProxyUrl = proxyUrl
  return {
    proxyUrl,
    source: proxyUrl ? 'system' : 'direct',
  }
}

export function getEffectiveLocalCodexProxyUrl(): string {
  return getLocalProxyUrl().trim() || resolvedSystemProxyUrl || ''
}

export async function resolveLocalCodexProxyUrl(): Promise<string | null> {
  return (await resolveEffectiveLocalCodexProxy()).proxyUrl
}

export function resetSystemProxyStateForTests(): void {
  resolvedSystemProxyUrl = null
}
