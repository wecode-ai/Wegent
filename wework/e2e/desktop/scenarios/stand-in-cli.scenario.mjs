import assert from 'node:assert/strict'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { createDingTalkReplyStory } from '../modules/stand-in-dingtalk-reply-story.mjs'
import { createDirectRecoveryVerification } from '../modules/stand-in-direct-recovery.mjs'

export function createDesktopScenario(options) {
  const { uiTimeoutMs, workbenchReadyTimeoutMs } = options
  const dingtalk = createStandInDingTalkFixture(options)
  const story = createDingTalkReplyStory(options)
  const recovery = createDirectRecoveryVerification(options)
  return {
    async prepareApp(context) {
      await story.prepareApp(context, dingtalk)
      await recovery.prepareApp(context)
    },
    async handleHttp(req, response, url) {
      if (await recovery.handleHttp(req, response, url)) return true
      return story.model.handleHttp(req, response, url)
    },
    reviewApproval: story.model.reviewApproval,
    diagnostics: () => ({ directRecovery: recovery.diagnostics() }),
    async verify(control) {
      await dingtalk.install(control)
      // The first catalog request initializes the connection dependency inventory.
      // Keep ordinary permission checks and the warm recovery request on the UI budget.
      const catalog = await requestExecutor(
        control,
        'runtime.connections.catalog',
        {},
        workbenchReadyTimeoutMs
      )
      const provider = catalog.items.find(
        item => item.id === '@wegent/dsh-connection-dingtalk/dingtalk'
      )
      assert.ok(provider)
      const declaration = provider.cliReadTools.dingtalk
      assert.deepEqual(Object.keys(declaration.operations).sort(), [
        'downloadImage',
        'listConversation',
        'listDirectConversation',
        'listMentions',
        'listProfiles',
        'listTopicReplies',
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
          expectedVersion: dependency.resolved.version,
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
        expectedVersion: dependency.resolved.version,
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
      await recovery.verify(control)
      await story.verify(control, (method, params) =>
        requestExecutor(control, method, params, uiTimeoutMs)
      )
    },
  }
}
