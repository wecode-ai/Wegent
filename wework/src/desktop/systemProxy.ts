import { getLocalProxyUrl } from '@/features/model-settings/localProxySettings'

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
  const configuredProxy = getLocalProxyUrl().trim()
  if (configuredProxy) {
    return {
      proxyUrl: configuredProxy,
      source: 'wework',
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
