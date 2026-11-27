import assert from 'node:assert/strict'
import { createStandInDingTalkFixture } from '../modules/stand-in-dingtalk-fixture.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { createDingTalkReplyStory } from '../modules/stand-in-dingtalk-reply-story.mjs'
import { createDirectRecoveryVerification } from '../modules/stand-in-direct-recovery.mjs'
import { createSourceOwnerTaskStory } from '../modules/stand-in-source-owner-task.mjs'

async function authorizeDingTalk(control, authTarget, timeoutMs) {
  let status = await requestExecutor(
    control,
    'runtime.local_connector_auth.start',
    { pluginKey: authTarget.pluginKey, connectorSlug: authTarget.connectorSlug },
    timeoutMs
  )
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (status.status === 'ok') return status
    assert.notEqual(status.status, 'error', status.hint ?? 'DingTalk authorization failed')
    await new Promise(resolve => setTimeout(resolve, 50))
    status = await requestExecutor(
      control,
      'runtime.local_connector_auth.poll',
      {
        pluginKey: authTarget.pluginKey,
        connectorSlug: authTarget.connectorSlug,
        sessionId: status.sessionId,
      },
      timeoutMs
    )
  }
  assert.fail('DingTalk authorization did not complete')
}

export function createDesktopScenario(options) {
  const { uiTimeoutMs, workbenchReadyTimeoutMs } = options
  const dingtalk = createStandInDingTalkFixture(options)
  const story = createDingTalkReplyStory(options)
  const recovery = createDirectRecoveryVerification(options)
  const ownerTask = createSourceOwnerTaskStory(options)
  return {
    async prepareApp(context) {
      await story.prepareApp(context, dingtalk)
      await recovery.prepareApp(context)
      await ownerTask.prepareApp(context)
    },
    async handleHttp(req, response, url) {
      if (await ownerTask.handleHttp(req, response, url)) return true
      if (await recovery.handleHttp(req, response, url)) return true
      return story.model.handleHttp(req, response, url)
    },
    reviewApproval: (...args) =>
      ownerTask.state.active
        ? ownerTask.reviewApproval(...args)
        : story.model.reviewApproval(...args),
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
        'authStatus',
        'componentInfo',
        'conversationInfo',
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
      const providerId = provider.id
      const authTarget = provider.authTarget
      // Exercise the real CLI, provider and catalog boundaries with the profile
      // still present while its token is no longer refreshable.
      await dingtalk.setAuthState('expired')
      const expiredProfile = await invoke('runtime.connections.cli', {
        providerId,
        dependencyAlias: dependency.alias,
        source: dependency.source,
        expectedVersion: dependency.resolved.version,
        operation: 'callTool',
        tool: 'listProfiles',
        arguments: {},
      })
      assert.equal(expiredProfile.ok, true)
      assert.equal(expiredProfile.result.currentProfile, 'connection-test-account')
      const expiredCatalog = await invoke('runtime.connections.catalog', {})
      assert.equal(expiredCatalog.ok, true)
      assert.equal(
        expiredCatalog.result.items.find(item => item.id === providerId).availability.status,
        'auth_required'
      )
      const expiredSearch = await invoke('runtime.connections.resources', {
        providerId,
        kind: 'direct',
        query: 'qindi',
      })
      assert.equal(expiredSearch.ok, false)
      assert.equal(expiredSearch.error.code, 'connector_auth_required')

      // The preflight passes, then the search expires the token before its result.
      await dingtalk.setAuthState('expire-on-search')
      const expiredDuringSearch = await invoke('runtime.connections.resources', {
        providerId,
        kind: 'direct',
        query: 'qindi',
      })
      assert.equal(expiredDuringSearch.ok, false)
      assert.equal(expiredDuringSearch.error.code, 'connector_auth_required')
      assert.equal(await dingtalk.authState(), 'expired')

      await authorizeDingTalk(control, authTarget, uiTimeoutMs)
      assert.equal(await dingtalk.authState(), 'ready')
      const recoveredCatalogAfterAuth = await invoke('runtime.connections.catalog', {})
      assert.equal(recoveredCatalogAfterAuth.ok, true)
      assert.equal(
        recoveredCatalogAfterAuth.result.items.find(item => item.id === providerId).availability
          .status,
        'ready'
      )
      const recoveredSearch = await invoke('runtime.connections.resources', {
        providerId,
        kind: 'direct',
        query: 'qindi',
      })
      assert.equal(recoveredSearch.ok, true)
      assert.ok(recoveredSearch.result.items.some(item => item.id === 'fixture-user'))

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
      await ownerTask.verify(control, (method, params) =>
        requestExecutor(control, method, params, uiTimeoutMs)
      )
    },
  }
}
