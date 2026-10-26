import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'

export function createDesktopScenario({ uiTimeoutMs }) {
  return {
    async verify(control) {
      const catalog = await requestExecutor(control, 'runtime.connections.catalog', {}, uiTimeoutMs)
      const provider = catalog.items.find(
        item => item.id === '@wegent/dsh-connection-dingtalk/dingtalk'
      )
      assert.ok(provider)
      const declaration = provider.cliReadTools.dingtalk
      assert.deepEqual(Object.keys(declaration.operations).sort(), [
        'listMentions',
        'listProfiles',
        'searchGroups',
        'searchMessages',
        'searchUsers',
      ])
      const dependency = provider.dependencies.find(item => item.alias === 'dingtalk')
      const origin = await control.command('getLocationOrigin', 'body')
      const invoke = async (method, params) => {
        const response = await fetchLocalRuntime(control, `${origin}/wework/executor/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `cli-boundary-${method}`, method, params }),
          timeoutMs: uiTimeoutMs,
        })
        return response.json()
      }
      for (const input of [
        { tool: 'reply', arguments: {} },
        { tool: 'searchGroups', arguments: { output: '/tmp/forbidden' } },
        { tool: 'searchGroups', arguments: { query: '--export' } },
      ]) {
        const result = await invoke('runtime.connections.cli', {
          providerId: provider.id,
          dependencyAlias: dependency.alias,
          source: dependency.source,
          expectedVersion: null,
          operation: 'callTool',
          ...input,
          // Caller-owned declarations and executable paths must never grant capability.
          cliReadTools: {
            operations: { reply: { command: ['chat', 'message', 'reply'], parameters: {} } },
          },
          command: ['sh'],
        })
        assert.equal(result.ok, false)
        assert.equal(result.error.code, 'connection_tool_denied')
      }
      const removed = await invoke('runtime.connections.command', {
        providerId: provider.id,
        args: ['profile', 'list'],
      })
      assert.equal(removed.ok, false)
      assert.equal(removed.error.code, 'unsupported_method')
      const wrongAlias = await invoke('runtime.connections.cli', {
        providerId: provider.id,
        dependencyAlias: 'undeclared',
        source: dependency.source,
        expectedVersion: null,
        operation: 'callTool',
        tool: 'searchGroups',
        arguments: { query: 'must not run' },
      })
      assert.equal(wrongAlias.ok, false)
      assert.equal(wrongAlias.error.code, 'connection_dependency_denied')
      const recovered = await requestExecutor(
        control,
        'runtime.connections.catalog',
        {},
        uiTimeoutMs
      )
      assert.ok(recovered.items.some(item => item.id === provider.id))
    },
  }
}
