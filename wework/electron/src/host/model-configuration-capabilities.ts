import { dialog, shell, type BrowserWindow } from 'electron'
import type { HostCapabilityRouter } from './capability-router.js'
import type { DesktopHostEventBroker } from './desktop-host-events.js'
import type { ModelConfigurationStore } from './model-configuration-store.js'
import { ModelRuntimeCredentials } from './model-runtime-credentials.js'
import { resolveSystemProxy } from './system-proxy.js'
import { net, session } from 'electron'

/** Register native provider operations and publish revisions only after successful mutations. */
export function registerModelConfigurationCapabilities(
  router: HostCapabilityRouter,
  window: () => BrowserWindow | null,
  configuration: ModelConfigurationStore,
  events: DesktopHostEventBroker,
  publishCredentials: (entries: unknown[]) => Promise<void>
): void {
  let operation: Promise<unknown> = Promise.resolve()
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = operation.then(work)
    operation = result.catch(() => {})
    return result
  }
  const runtimeCredentials = new ModelRuntimeCredentials(
    publishCredentials,
    url => resolveSystemProxy(session.defaultSession, url),
    (input, init) => net.fetch(input instanceof URL ? input.href : input, init)
  )
  const synchronize = async () => {
    const runtime = await configuration.runtime()
    await runtimeCredentials.publish(runtime.models)
  }
  const read = async () => {
    try {
      return await configuration.read()
    } catch (error) {
      await runtimeCredentials.revokeAll()
      throw error
    }
  }
  router.register('modelConfiguration.read', () =>
    serialized(async () => {
      const snapshot = await read()
      await synchronize()
      return snapshot
    })
  )
  router.register('modelConfiguration.runtime', params =>
    serialized(async () => {
      await read()
      const runtime = await configuration.runtime(params.provider)
      return {
        revision: runtime.revision,
        models: await runtimeCredentials.publish(runtime.models, params.provider !== undefined),
      }
    })
  )
  router.register('modelConfiguration.save', params =>
    serialized(async () => {
      if (typeof params.revision !== 'string') throw new Error('Configuration revision is required')
      await runtimeCredentials.revokeAll()
      const result = await configuration.save(params.revision, params.providers)
      await synchronize()
      events.publish('model-configuration.changed', { revision: result.revision })
      return result
    })
  )
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
    return serialized(async () => {
      await runtimeCredentials.revokeAll()
      const result = await configuration.bind(selected.filePaths[0])
      await synchronize()
      events.publish('model-configuration.changed', { revision: result.revision })
      return result
    })
  })
  router.register('modelConfiguration.open', async () => {
    const error = await shell.openPath(await configuration.ensureFile())
    if (error) throw new Error('The model file could not be opened in an editor')
    return null
  })
  router.register('modelConfiguration.discover', params =>
    serialized(() => {
      if (typeof params.providerId !== 'string') throw new Error('Provider ID is required')
      return configuration.discover(params.providerId, params.provider)
    })
  )
  router.register('modelConfiguration.probe', params => runtimeCredentials.probe(params))
  router.register('modelConfiguration.recovery', () => serialized(() => configuration.recovery()))
  router.register('modelConfiguration.restoreRecovery', params =>
    serialized(async () => {
      if (
        typeof params.id !== 'string' ||
        typeof params.revision !== 'string' ||
        typeof params.configurationRevision !== 'string'
      )
        throw new Error('Recovery identity and revisions are required')
      await runtimeCredentials.revokeAll()
      const result = await configuration.restoreRecovery(
        params.id,
        params.revision,
        params.configurationRevision
      )
      await synchronize()
      events.publish('model-configuration.changed', { revision: result.revision })
      return result
    })
  )
}
