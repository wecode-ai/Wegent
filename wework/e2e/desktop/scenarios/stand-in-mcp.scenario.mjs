import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async verify(control) {
      // Catalog bootstrap can initialize the connection dependency inventory.
      const catalog = await requestExecutor(
        control,
        'runtime.connections.catalog',
        {},
        workbenchReadyTimeoutMs
      )
      assert.ok(catalog.items.some(item => item.id === '@wegent/dsh-connection-dingtalk/dingtalk'))
      const origin = await control.command('getLocationOrigin', 'body')
      // Use the actual Executor and DSH host. No business service or model is invoked.
      for (const providerId of [
        '@wegent/dsh-connection-dingtalk/dingtalk',
        '@test/unknown/source',
      ]) {
        const response = await fetch(`${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: `mcp-denied-${providerId}`,
            method: 'runtime.connections.mcp',
            params: {
              providerId,
              source: { marketplaceId: 'unrelated', pluginId: 'mail@unrelated' },
              expectedVersion: null,
              operation: 'callTool',
              server: 'mail',
              tool: 'read',
              arguments: {},
              // A caller cannot grant itself legacy read capabilities.
              readTools: [{ server: 'mail', tool: 'read' }],
            },
          }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        const payload = await response.json()
        assert.equal(payload.ok, false)
        assert.equal(payload.error.code, 'connection_dependency_denied')
      }
      const recovered = await requestExecutor(
        control,
        'runtime.connections.catalog',
        {},
        uiTimeoutMs
      )
      assert.deepEqual(
        recovered.items.map(item => item.id).sort(),
        catalog.items.map(item => item.id).sort()
      )
    },
  }
}
