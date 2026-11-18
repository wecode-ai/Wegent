import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { withNativePluginDecision } from '../modules/native-plugin-approval.mjs'
import { withTimeout } from '../modules/shared.mjs'
import { waitForBundledMarketplaceRegistration } from '../modules/plugin-flows.mjs'
import { verifyStandInEventVersions } from '../modules/stand-in-event-versions.mjs'
import { createProjectVersionStory } from '../modules/stand-in-project-version-story.mjs'
import { createSourceArchiveRegression } from '../modules/stand-in-source-archive.mjs'
import {
  verifyStandInResourceScopes,
  verifyStandInCalendarPolicy,
} from '../modules/stand-in-resource-scope-flows.mjs'

const PACKAGE = '@test/connection-source'
const PROVIDER = `${PACKAGE}/records`
const MARKET = 'connection-fixture'
const PLUGIN = `source@${MARKET}`
const ASSISTANCE = {
  observe: ['New authorized record versions'],
  prepare: ['Read the selected record and identify the material change'],
  notifyWhen: ['A personally relevant record change requires a user decision'],
  confirmBefore: ['Changing a record requires native authorization'],
}

export function createDesktopScenario(options) {
  const {
    resultDir,
    electronUserDataDirectory,
    executorHome,
    uiTimeoutMs,
    workbenchReadyTimeoutMs,
  } = options
  const story = createProjectVersionStory(options, PROVIDER)
  const archiveRegression = createSourceArchiveRegression(options, PROVIDER)
  const root = join(resultDir, 'connection-marketplace')
  const source = join(root, 'source')
  const records = join(resultDir, 'records.json')
  const audit = join(resultDir, 'calls.jsonl')
  let modelRequests = 0
  let codexHome
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const codex = (control, method, params) =>
    rpc(control, 'runtime.codex.app_server.request', { method, params })
  async function host(control, capability, params) {
    const origin = await control.command('getLocationOrigin', 'body')
    const invoke = () =>
      fetchLocalRuntime(control, `${origin}/wework/electron-host/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, params }),
        timeoutMs: workbenchReadyTimeoutMs,
      })
    const response =
      capability === 'runtime.installCoreDshPlugin'
        ? await withNativePluginDecision(control, invoke)
        : await invoke()
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.result
  }
  return {
    reviewApproval: story.model.reviewApproval,
    async handleHttp(req, _response, url) {
      if (archiveRegression.active) return archiveRegression.handleHttp(req, _response, url)
      if (story.model.active) return story.model.handleHttp(req, _response, url)
      if (req.method === 'POST' && ['/responses', '/v1/responses'].includes(url.pathname))
        modelRequests++
      return false
    },
    async prepareApp({ codexHome: isolatedCodexHome }) {
      codexHome = isolatedCodexHome
      await mkdir(join(root, '.agents/plugins'), { recursive: true })
      await mkdir(join(source, '.codex-plugin'), { recursive: true })
      await writeFile(records, JSON.stringify([{ id: 'record-1', value: 'existing-plugin-value' }]))
      await writeFile(audit, '')
      await cp(
        new URL('../fixtures/connection-source/mcp.mjs', import.meta.url),
        join(source, 'mcp.mjs')
      )
      await writeFile(
        join(source, '.codex-plugin/plugin.json'),
        JSON.stringify({
          name: 'source',
          version: '1.0.0',
          mcpServers: {
            records: { command: process.execPath, args: [join(source, 'mcp.mjs'), records, audit] },
          },
        })
      )
      await writeFile(
        join(root, '.agents/plugins/marketplace.json'),
        JSON.stringify({
          name: MARKET,
          plugins: [{ name: 'source', source: { source: 'local', path: './source' } }],
        })
      )
      const profile = join(electronUserDataDirectory, 'dsh-core/profiles/wework-core')
      const adapter = join(resultDir, 'connection-adapter')
      await mkdir(adapter, { recursive: true })
      await cp(
        new URL('../fixtures/connection-source/provider.mjs', import.meta.url),
        join(adapter, 'index.js')
      )
      await writeFile(
        join(adapter, 'cordis.patch.yml'),
        `- insert:\n    - id: connection-source\n      name: '${PACKAGE}'\n      inject:\n        - weworkConnections\n`
      )
      await writeFile(
        join(adapter, 'package.json'),
        JSON.stringify({
          name: PACKAGE,
          version: '1.0.0',
          type: 'module',
          main: 'index.js',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
          wework: {
            connections: {
              apiVersion: 1,
              dependencies: {
                source: {
                  kind: 'codexPlugin',
                  source: { marketplaceId: MARKET, pluginId: PLUGIN },
                  version: '*',
                },
              },
              providers: [
                {
                  id: 'records',
                  displayName: 'Connection source',
                  uses: ['source'],
                  collectionModes: ['poll'],
                  resourceKinds: ['record'],
                  allResourceKinds: ['record'],
                  resourceLabels: { record: 'Records' },
                  eventTypes: ['record.received', 'message.received'],
                  versionedEventTypes: ['record.received'],
                  assistance: ASSISTANCE,
                },
              ],
            },
          },
        })
      )
      await mkdir(join(profile, 'node_modules', ...PACKAGE.split('/')), { recursive: true })
      await cp(adapter, join(profile, 'node_modules', ...PACKAGE.split('/')), { recursive: true })
      await writeFile(
        join(profile, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: { [PACKAGE]: `file:${adapter}` },
          dsh: { profile: { bundles: [PACKAGE] } },
        })
      )
    },
    async verify(control) {
      // Startup restarts Codex before registering the bundled marketplace.
      // Wait before adding a marketplace held by that app-server process.
      await waitForBundledMarketplaceRegistration(codexHome)
      const initial = await rpc(control, 'runtime.connections.catalog', {})
      assert.equal(
        initial.items.find(item => item.id === PROVIDER)?.availability.status,
        'dependency_missing'
      )
      const marketplace = await codex(control, 'marketplace/add', { source: root })
      assert.equal(marketplace.marketplaceName, MARKET)
      await rpc(control, 'runtime.connections.dependencies.install', {
        providerId: PROVIDER,
        aliases: ['source'],
      })
      const ready = await rpc(control, 'runtime.connections.catalog', {})
      const provider = ready.items.find(item => item.id === PROVIDER)
      assert.equal(provider.availability.status, 'ready')
      assert.deepEqual(provider.assistance, ASSISTANCE)
      const page = await rpc(control, 'runtime.connections.resources', {
        providerId: PROVIDER,
        kind: 'record',
        query: 'record-1',
      })
      assert.equal(page.items[0].name, 'existing-plugin-value')
      assert.equal(page.items[0].providerId, PROVIDER)
      const dependency = provider.dependencies[0]
      await assert.rejects(
        rpc(control, 'runtime.connections.mcp', {
          providerId: PROVIDER,
          dependencyAlias: 'source',
          source: dependency.source,
          expectedVersion: dependency.resolved.version,
          operation: 'callTool',
          server: page.items[0].server,
          tool: 'write_record',
          arguments: {},
        }),
        /unique read-only tool/
      )
      const calls = (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      assert.deepEqual(
        calls.map(call => call.name),
        ['read_record']
      )
      await verifyStandInEventVersions(control, rpc, PROVIDER, executorHome, records)
      await writeFile(
        records,
        JSON.stringify([
          { id: 'record-1', value: 'existing-plugin-value' },
          { id: 'record-2', value: 'second-record' },
        ])
      )
      await verifyStandInResourceScopes(control, rpc, PROVIDER)
      await verifyStandInCalendarPolicy(control, rpc)
      await assert.rejects(
        codex(control, 'plugin/uninstall', { pluginId: PLUGIN }),
        /Disable connection plugin/
      )
      await host(control, 'runtime.setCoreDshPluginEnabled', { name: PACKAGE, enabled: false })
      const readyCount = control.readyCount
      await host(control, 'runtime.restartCoreDsh', {})
      await withTimeout(
        control.awaitReadyAfter(readyCount),
        workbenchReadyTimeoutMs,
        'Connection plugin restart did not reconnect the workbench'
      )
      await control.command('waitFor', '[data-testid="plugins-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const stopped = await rpc(control, 'runtime.connections.catalog', {})
      assert.equal(
        stopped.items.find(item => item.id === PROVIDER)?.availability.status,
        'plugin_disabled'
      )
      await codex(control, 'plugin/uninstall', { pluginId: PLUGIN })
      await codex(control, 'marketplace/remove', { marketplaceName: MARKET })
      await host(control, 'runtime.uninstallCoreDshPlugin', { name: PACKAGE })
      assert.equal(modelRequests, 0, 'Background discovery and reads must not start a model turn')
      // Independent business phase begins only after every original lifecycle assertion.
      // Reinstall through the public host API; never rewrite native plugin state or grants.
      await host(control, 'runtime.installCoreDshPlugin', {
        spec: `file:${join(resultDir, 'connection-adapter')}`,
      })
      await host(control, 'runtime.setCoreDshPluginEnabled', { name: PACKAGE, enabled: true })
      const storyReadyCount = control.readyCount
      await host(control, 'runtime.restartCoreDsh', {})
      await withTimeout(
        control.awaitReadyAfter(storyReadyCount),
        workbenchReadyTimeoutMs,
        'Project story plugin did not reconnect the workbench'
      )
      await codex(control, 'marketplace/add', { source: root })
      await rpc(control, 'runtime.connections.dependencies.install', {
        providerId: PROVIDER,
        aliases: ['source'],
      })
      let storyFailure
      try {
        await story.verify(control, (method, params) => rpc(control, method, params), records)
        await archiveRegression.verify(
          control,
          (method, params) => rpc(control, method, params),
          records
        )
      } catch (error) {
        storyFailure = error
        throw error
      } finally {
        try {
          await host(control, 'runtime.setCoreDshPluginEnabled', { name: PACKAGE, enabled: false })
          const cleanupReadyCount = control.readyCount
          await host(control, 'runtime.restartCoreDsh', {})
          await withTimeout(
            control.awaitReadyAfter(cleanupReadyCount),
            workbenchReadyTimeoutMs,
            'Project story cleanup did not reconnect the workbench'
          )
          await control.command('waitFor', '[data-testid="plugins-button"]', {
            timeoutMs: workbenchReadyTimeoutMs,
          })
          const stopped = await rpc(control, 'runtime.connections.catalog', {})
          assert.equal(
            stopped.items.find(item => item.id === PROVIDER)?.availability.status,
            'plugin_disabled'
          )
          await codex(control, 'plugin/uninstall', { pluginId: PLUGIN })
          await codex(control, 'marketplace/remove', { marketplaceName: MARKET })
          await host(control, 'runtime.uninstallCoreDshPlugin', { name: PACKAGE })
        } catch (cleanupError) {
          if (storyFailure)
            throw new AggregateError(
              [storyFailure, cleanupError],
              'Project source verification and cleanup failed'
            )
          throw cleanupError
        }
      }
    },
  }
}
