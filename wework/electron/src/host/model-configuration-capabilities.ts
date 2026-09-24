import { app, dialog, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { HostCapabilityRouter } from './capability-router.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'
import type { SecureValueStore } from './secure-value-store.js'
import { ModelConfigurationStore } from './model-configuration-store.js'

/** Register native provider operations and publish revisions only after successful mutations. */
export function registerModelConfigurationCapabilities(
  router: HostCapabilityRouter,
  window: () => BrowserWindow | null,
  secrets: SecureValueStore,
  events: DesktopHostEventBroker
): void {
  let instance: ModelConfigurationStore | null = null
  /** Lazily share one serialized model configuration service across host capability requests. */
  const store = () =>
    (instance ??= new ModelConfigurationStore(
      join(app.getPath('userData'), 'model-connections'),
      secrets
    ))
  router.register('modelConfiguration.read', () => store().read())
  router.register('modelConfiguration.runtime', () => store().runtime())
  router.register('modelConfiguration.save', async params => {
    if (typeof params.revision !== 'string') throw new Error('Configuration revision is required')
    const result = await store().save(params.revision, params.providers)
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
