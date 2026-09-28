import { getLocalProxyConfig } from '@/features/model-settings/localProxySettings'

export type LocalCodexProxySource = 'direct' | 'system' | 'wework'

export interface EffectiveLocalCodexProxy {
  proxyUrl: string | null
  source: LocalCodexProxySource
}

export const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex'

declare global {
  interface Window {
    weworkElectronNetwork?: {
      resolveProxy(targetUrl: string): Promise<string | null>
    }
  }
}

export async function resolveEffectiveLocalCodexProxy(
  targetUrl: string = CODEX_API_URL
): Promise<EffectiveLocalCodexProxy> {
  const config = getLocalProxyConfig()
  if (config.mode === 'custom') {
    return {
      proxyUrl: config.proxyUrl,
      source: 'wework',
    }
  }
  if (config.mode === 'direct') {
    return {
      proxyUrl: null,
      source: 'direct',
    }
  }

  const systemProxy = await window.weworkElectronNetwork?.resolveProxy(targetUrl)
  const proxyUrl = systemProxy?.trim() || null
  return {
    proxyUrl,
    source: proxyUrl ? 'system' : 'direct',
  }
}

export async function resolveLocalCodexProxyUrl(
  targetUrl: string = CODEX_API_URL
): Promise<string | null> {
  return (await resolveEffectiveLocalCodexProxy(targetUrl)).proxyUrl
}
