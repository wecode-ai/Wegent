import { cp, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createBridgeScenario } from '../scenarios/stand-in-plugin-bridge.scenario.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForBundledMarketplaceRegistration } from './plugin-flows.mjs'

export const CONVERSATION_EVENT_PROVIDER = '@test/connection-source/records'

/** Publish test-owned records through the real installed DSH connection and MCP dependency. */
export function createConversationEventSource(options) {
  const bridge = createBridgeScenario(options, { versionedEventTypes: ['git.event'] })
  const { resultDir, electronUserDataDirectory, uiTimeoutMs } = options
  const recordsPath = join(resultDir, 'records.json')
  let codexHome

  async function publishEvents(events, preexistingChecks = []) {
    // A collection must read either the previous complete snapshot or the new one.
    const pendingPath = `${recordsPath}.pending`
    await writeFile(
      pendingPath,
      JSON.stringify([
        ...['archive-record', 'long-archive-record'].map(id => ({
          id,
          value: JSON.stringify(events),
        })),
        { id: 'preexisting-checks-record', value: JSON.stringify(preexistingChecks) },
      ])
    )
    await rename(pendingPath, recordsPath)
  }

  return {
    appEnvironment: bridge.appEnvironment,
    async prepareApp(context, preexistingChecks = []) {
      await bridge.prepareApp(context)
      codexHome = context.codexHome
      await publishEvents([], preexistingChecks)
      for (const adapter of [
        join(resultDir, 'connection-adapter'),
        join(
          electronUserDataDirectory,
          'dsh-core/profiles/wework-core/node_modules/@test/connection-source'
        ),
      ]) {
        await cp(
          new URL('../fixtures/conversation-events-provider.mjs', import.meta.url),
          join(adapter, 'index.js')
        )
      }
    },
    async install(control) {
      await waitForBundledMarketplaceRegistration(codexHome)
      await requestExecutor(
        control,
        'runtime.codex.app_server.request',
        {
          method: 'marketplace/add',
          params: { source: join(resultDir, 'connection-marketplace') },
        },
        uiTimeoutMs
      )
      await requestExecutor(
        control,
        'runtime.connections.dependencies.install',
        { providerId: CONVERSATION_EVENT_PROVIDER, aliases: ['source'] },
        uiTimeoutMs
      )
    },
    publishEvents,
  }
}
