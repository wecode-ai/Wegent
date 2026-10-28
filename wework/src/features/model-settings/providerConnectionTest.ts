import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type {
  ModelProvider,
  PublicModelProvider,
  ResolvedProviderModel,
} from '../../../electron/src/host/model-configuration-contract'
import { resolveProviderModel } from './providerModelConfiguration'
import { findLocalModelProviderProfile } from './localModelProviders'
import { buildLocalModelRequestUrl } from './localModelSettings'
import { testLocalModelConnection } from './localModelConnectionTest'

export interface ProviderConnectionTestResult {
  model: string
  error?: string
}

/** Probe each selected model using native credential resolution without saving the draft. */
export async function testProviderConnection(
  provider: ModelProvider | PublicModelProvider
): Promise<ProviderConnectionTestResult[]> {
  const draft = { ...provider } as ModelProvider & { api_key_configured?: boolean }
  delete draft.api_key_configured
  delete draft.api_key_ref
  if (!draft.api_key) delete draft.api_key
  const runtime = await invokeDesktopHost<{ models: ResolvedProviderModel[] }>(
    'modelConfiguration.runtime',
    { provider: draft }
  )
  if (!provider.models.length) throw new Error('Select at least one model to test')
  if (
    runtime.models.length !== provider.models.length ||
    runtime.models.some(
      entry =>
        entry.provider.id !== provider.id ||
        !provider.models.some(model => model.id === entry.model.id)
    )
  )
    throw new Error('The saved API Key is unavailable. Enter a replacement key.')
  return Promise.all(
    runtime.models.map(async entry => {
      const config = resolveProviderModel(entry)
      const profile = findLocalModelProviderProfile(config.providerProfileId)
      const probe =
        profile.connectionTest &&
        config.apiFormat === profile.apiFormat &&
        buildLocalModelRequestUrl(config.baseUrl, config.requestPath, config.apiFormat) ===
          buildLocalModelRequestUrl(profile.baseUrl, profile.requestPath, profile.apiFormat)
          ? profile.connectionTest
          : undefined
      try {
        await testLocalModelConnection(
          {
            baseUrl: probe?.baseUrl ?? config.baseUrl,
            requestPath: probe?.requestPath ?? config.requestPath,
            apiFormat: probe?.apiFormat ?? config.apiFormat,
            modelId: config.modelId,
            toolProfile: probe ? 'function' : config.toolProfile,
            apiKey: config.apiKey,
          },
          {
            verifyExactProbePayload: false,
            fetcher: async (_url, options) => {
              const result = await invokeDesktopHost<{ status: number; body: string }>(
                'modelConfiguration.probe',
                {
                  reference: entry.provider.api_key,
                  preset: Boolean(probe),
                  body: options?.body,
                }
              )
              return new Response(result.body, {
                status: result.status,
                headers: { 'Content-Type': 'application/json' },
              })
            },
          }
        )
        return { model: config.displayName }
      } catch (error) {
        return {
          model: config.displayName,
          error: error instanceof Error ? error.message : 'Connection test failed',
        }
      }
    })
  )
}
