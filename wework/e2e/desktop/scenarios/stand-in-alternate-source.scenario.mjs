import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createBridgeScenario } from './stand-in-plugin-bridge.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForBundledMarketplaceRegistration } from '../modules/plugin-flows.mjs'

// Reuse the real plugin/MCP fixture and isolated runtime; no external DingTalk account is needed.
export function createDesktopScenario(options) {
  const base = createBridgeScenario(options)
  const { resultDir, electronUserDataDirectory, uiTimeoutMs, workbenchReadyTimeoutMs } = options
  const providerId = '@test/connection-source/records'
  let codexHome
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const codex = (control, method, params) =>
    rpc(control, 'runtime.codex.app_server.request', { method, params })
  return {
    ...base,
    async prepareApp(context) {
      await base.prepareApp(context)
      codexHome = context.codexHome
      const manifestPath = join(
        electronUserDataDirectory,
        'dsh-core/profiles/wework-core/node_modules/@test/connection-source/package.json'
      )
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const dependency = manifest.wework.connections.dependencies.source
      dependency.alternateSources = [dependency.source]
      dependency.source = {
        marketplaceId: 'preferred-fixture',
        pluginId: 'source@preferred-fixture',
      }
      await writeFile(manifestPath, JSON.stringify(manifest))
      await writeFile(join(resultDir, 'connection-adapter/package.json'), JSON.stringify(manifest))
    },
    async verify(control) {
      // Both startup paths can write config and restart the shared app-server.
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await waitForBundledMarketplaceRegistration(codexHome)
      await control.command('reconcileLocalPluginCatalog', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const root = join(resultDir, 'connection-marketplace')
      const marketplace = await codex(control, 'marketplace/add', { source: root })
      const installed = await codex(control, 'plugin/install', {
        pluginName: 'source',
        marketplacePath: join(root, '.agents/plugins/marketplace.json'),
      })
      const catalog = await rpc(control, 'runtime.connections.catalog', {})
      const dingtalk = catalog.items.find(
        item => item.id === '@wegent/dsh-connection-dingtalk/dingtalk'
      )
      assert.ok(dingtalk, 'The packaged DingTalk provider must be registered')
      assert.deepEqual(dingtalk.dependencies[0].source, {
        marketplaceId: 'wework',
        pluginId: 'dingtalk@wework',
      })
      const provider = catalog.items.find(item => item.id === providerId)
      await writeFile(
        join(resultDir, 'stand-in-alternate-source-dependency-evidence.json'),
        JSON.stringify({ marketplace, installed, provider }, null, 2)
      )
      assert.equal(provider.availability.status, 'ready')
      assert.deepEqual(provider.dependencies[0].source, {
        marketplaceId: 'preferred-fixture',
        pluginId: 'source@preferred-fixture',
      })
      assert.equal(provider.dependencies[0].resolved.pluginId, 'source@connection-fixture')
      // Installing dependencies again must reuse this installed alternate source.
      await rpc(control, 'runtime.connections.dependencies.install', {
        providerId,
        aliases: ['source'],
      })
      const page = await rpc(control, 'runtime.connections.resources', {
        providerId,
        kind: 'record',
        query: 'record-1',
      })
      assert.equal(page.items[0].name, 'existing-plugin-value')
      assert.equal(page.items[0].providerId, providerId)
      await assert.rejects(
        rpc(control, 'runtime.connections.mcp', {
          providerId,
          dependencyAlias: 'source',
          source: { marketplaceId: 'unrelated', pluginId: 'source@unrelated' },
          expectedVersion: '1.0.0',
          operation: 'listTools',
        }),
        /declared|dependency/i
      )
    },
  }
}
