import { app, dialog, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { HostCapabilityRouter } from './capability-router.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'
import type { SecureValueStore } from './secure-value-store.js'
import { ModelConfigurationStore } from './model-configuration-store.js'
import { protectedCredentialDirectory } from './credential-storage-paths.js'
import { probeModelConnection } from '../shared/model-connection-probe.js'
import { findLocalModelProviderProfile } from '../shared/model-provider-profiles.js'

/** Register native provider operations and publish revisions only after successful mutations. */
export function registerModelConfigurationCapabilities(
  router: HostCapabilityRouter,
  window: () => BrowserWindow | null,
  secrets: SecureValueStore,
  events: DesktopHostEventBroker,
  configuration?: ModelConfigurationStore,
  syncRuntime?: () => Promise<void>,
  requestRuntime?: (input: Record<string, unknown>) => Promise<unknown>
): void {
  let instance: ModelConfigurationStore | null = configuration ?? null
  /** Lazily share one serialized model configuration service across host capability requests. */
  const store = () =>
    (instance ??= new ModelConfigurationStore(
      join(protectedCredentialDirectory(app.getPath('userData')), 'model-connections'),
      secrets,
      join(app.getPath('userData'), 'model-connections')
    ))
  router.register('modelConfiguration.requestRuntime', params => {
    if (!requestRuntime) throw new Error('Native model execution is unavailable')
    return requestRuntime(params)
  })
  router.register('modelConfiguration.read', async () => {
    const result = await store().read()
    await syncRuntime?.()
    return result
  })
  router.register('modelConfiguration.runtime', async () => {
    const result = await store().runtime()
    return {
      ...result,
      models: result.models.map(({ provider, model }) => {
        const { api_key, ...metadata } = provider
        delete metadata.api_key_ref
        return {
          provider: {
            ...metadata,
            api_key_configured: Boolean(api_key),
            credential_revision: result.revision,
          },
          model,
        }
      }),
    }
  })
  router.register('modelConfiguration.test', async params => {
    const result = await store().runtime(params.provider)
    return Promise.all(
      result.models.map(async ({ provider, model }) => {
        const apiFormat = model.api_format ?? provider.api_format
        const path =
          model.request_path ??
          (model.api_format && model.api_format !== provider.api_format
            ? undefined
            : provider.request_path) ??
          (apiFormat === 'anthropic-messages'
            ? provider.base_url.endsWith('/v1')
              ? '/messages'
              : '/v1/messages'
            : apiFormat === 'openai-chat-completions'
              ? '/chat/completions'
              : '/responses')
        const profile = findLocalModelProviderProfile(model.provider_profile_id)
        const probe =
          profile.connectionTest &&
          provider.base_url === profile.baseUrl &&
          apiFormat === profile.apiFormat &&
          path === profile.requestPath
            ? profile.connectionTest
            : undefined
        try {
          await probeModelConnection(
            {
              requestUrl: probe
                ? `${probe.baseUrl}${probe.requestPath}`
                : `${provider.base_url}${path}`,
              apiFormat: probe?.apiFormat ?? apiFormat,
              modelId: model.model_id,
              toolProfile: probe ? 'function' : model.tool_profile,
              apiKey: provider.api_key,
            },
            { verifyExactProbePayload: false }
          )
          return { model: model.display_name || model.model_id }
        } catch {
          // Remote error bodies may echo credentials. Expose only a stable local failure.
          return { model: model.display_name || model.model_id, error: 'connection_test_failed' }
        }
      })
    )
  })
  router.register('modelConfiguration.save', async params => {
    if (typeof params.revision !== 'string') throw new Error('Configuration revision is required')
    const result = await store().save(params.revision, params.providers)
    await syncRuntime?.()
    events.publish('model-configuration.changed', { revision: result.revision })
    return result
  })
  router.register('modelConfiguration.choose', async () => {
    const options = {
      properties: ['openFile'] as ['openFile'],
      filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }],
    }
    const parent = window()
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (selected.canceled || !selected.filePaths[0]) return null
    const result = await store().bind(selected.filePaths[0])
    await syncRuntime?.()
    events.publish('model-configuration.changed', { revision: result.revision })
    return result
  })
  router.register('modelConfiguration.open', async () => {
    const error = await shell.openPath(await store().ensureFile())
    if (error) throw new Error('The model file could not be opened in an editor')
    return null
  })
  router.register('modelConfiguration.discover', async params => {
    if (typeof params.providerId !== 'string') throw new Error('Provider ID is required')
    return store().discover(params.providerId, params.provider)
  })
}
