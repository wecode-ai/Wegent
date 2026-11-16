import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { selectE2EModel } from './shared.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const USER = 9001
const ROLE = 'identity-reviewer'
const CHAT = '[data-testid="stand-in-conversation"]'
const INPUT = `${CHAT} [data-testid="chat-message-input"]`
const MARKER = 'PROPOSAL_ADD_SECOND_GROUP'
const PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'

/** Reproduce a primary conversation changing an existing role, not primary sources. */
export function createStandInProposalRegression({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  captureScreenshot,
}) {
  let draft
  let generation = 1
  const rpc = (control, method, args) => requestExecutor(control, method, args, uiTimeoutMs)
  return {
    async handleHttp(req, response, url) {
      if (!draft) return false
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (!JSON.stringify(body.input ?? []).includes(MARKER)) return false
      const toolCallId = `add-group-proposal-${generation}`
      const events = requestContainsToolOutput(body, toolCallId)
        ? [assistantMessage('已提交新增群草案，保留原群，请确认。')]
        : mcpToolRequestEvents(body, {
            toolName: 'propose_profile',
            directToolName: 'mcp__wework_stand_in__propose_profile',
            argumentsValue: { summary: '新增平台管理组，保留原群', settings: draft },
            searchCallId: 'add-group-search',
            toolCallId,
          }).events
      const id = `add-group-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await control.command('click', '[data-testid="stand-in-primary-open"]')
      const previous = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const source = (id, name) => ({
        id,
        name,
        providerId: PROVIDER,
        profile: 'connection-test-account',
        kind: 'group',
        policy: { automatic: true, askBeforeAct: true, immediate: true },
      })
      const base = await rpc(control, 'runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...previous,
          roles: previous.roles.map(role =>
            role.id === ROLE
              ? { ...role, enabled: true, connections: [source('original-group', '原群')] }
              : role
          ),
        },
      })
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command(
        'waitFor',
        `[data-testid="stand-in-overview-role-${ROLE}"][title="原群"]`
      )
      draft = {
        ...base,
        roles: base.roles.map(role =>
          role.id === ROLE
            ? {
                ...role,
                connections: [...role.connections, source('platform-group', '平台管理组')],
              }
            : role
        ),
      }
      await selectE2EModel(control, undefined, undefined, CHAT)
      await control.command('fill', INPUT, { value: MARKER })
      await control.command('press', INPUT, { key: 'Enter' })
      await control.command('waitFor', `${CHAT} [data-testid="stand-in-proposal"]`, {
        text: '平台管理组',
        timeoutMs: modelResponseTimeoutMs,
      })
      await captureScreenshot(control, '10-inline-group-confirmation.png')
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="stand-in-proposal-accept"]`)
      await control.command('waitFor', `${CHAT} [data-testid="stand-in-proposal-result"]`, {
        text: '配置已应用',
      })
      const saved = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      assert.deepEqual(
        saved.roles.find(role => role.id === ROLE).connections.map(row => row.id),
        ['original-group', 'platform-group']
      )
      assert.deepEqual(saved.primary, base.primary, 'Changing a role must not widen primary scope')
      const connections = saved.roles.find(role => role.id === ROLE).connections
      assert.equal(
        connections[0].enabledAfter,
        base.roles.find(role => role.id === ROLE).connections[0].enabledAfter
      )
      assert.ok(connections[1].enabledAfter, 'Confirmation must activate the new source boundary')
      await control.command('click', `[data-testid="stand-in-overview-role-${ROLE}"]`)
      await openStandInSettings(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
      await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
        text: '平台管理组',
      })
      await control.command('click', '[data-testid="stand-in-cancel"]')
      await control.command('click', '[data-testid="stand-in-primary-open"]')
      // The original conversation must show the actual application result.
      await control.command('waitFor', `${CHAT} [data-testid="stand-in-proposal-result"]`, {
        text: '平台管理组',
      })
      await captureScreenshot(control, '11-group-application-result.png')
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('navigate', 'body', { value: '/stand-in' })
      await control.command('waitFor', `${CHAT} [data-testid="stand-in-proposal-result"]`)
      await captureScreenshot(control, '12-group-application-result-dark.png')
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-light"]')
      await control.command('navigate', 'body', { value: '/stand-in' })
      generation += 1
      draft = {
        ...saved,
        roles: saved.roles.map(role =>
          role.id === ROLE
            ? {
                ...role,
                connections: [...role.connections, source('discarded-group', '不应用的群')],
              }
            : role
        ),
      }
      await control.command('fill', INPUT, { value: `${MARKER} reject` })
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
      await control.command('waitFor', `${CHAT} [data-testid="stand-in-proposal"]`, {
        text: '不应用的群',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('clickWhenEnabled', `${CHAT} [data-testid="stand-in-proposal-reject"]`)
      await control.command('waitFor', `${CHAT} [data-testid="stand-in-proposal-result"]`, {
        text: '配置未应用',
      })
      assert.deepEqual(await rpc(control, 'runtime.stand_in.personal.get', { userId: USER }), saved)
      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
      await control.command('waitFor', `[data-testid="stand-in-overview-role-${ROLE}"]`)
      assert.deepEqual(await rpc(control, 'runtime.stand_in.personal.get', { userId: USER }), saved)
    },
  }
}
