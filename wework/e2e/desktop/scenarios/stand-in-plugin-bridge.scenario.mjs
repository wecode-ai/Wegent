import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { withTimeout } from '../modules/shared.mjs'
import { waitForBundledMarketplaceRegistration } from '../modules/plugin-flows.mjs'

const PACKAGE = '@test/connection-source'
const PROVIDER = `${PACKAGE}/records`
const MARKET = 'connection-fixture'
const PLUGIN = `source@${MARKET}`

export function createDesktopScenario({
  resultDir,
  electronUserDataDirectory,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
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
    const response = await fetchLocalRuntime(control, `${origin}/wework/electron-host/v1/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, params }),
      timeoutMs: workbenchReadyTimeoutMs,
    })
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.result
  }
  return {
    async handleHttp(req, _response, url) {
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
                  resourceLabels: { record: 'Records' },
                  eventTypes: ['record.received'],
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
    },
  }
}
