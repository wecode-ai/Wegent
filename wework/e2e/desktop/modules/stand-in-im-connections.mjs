import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { commandOutputAsync, fetchJson, join, repoDir } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { finishStandInOnboarding } from './stand-in-instance-flows.mjs'

/** Reuse the real Backend/Redis/Executor; only the external IM input is synthetic. */
export function createStandInImConnectionsStory({ uiTimeoutMs, captureScreenshot }) {
  let cloud
  let backendEnv
  let userId
  let keys
  const request = (path, options = {}) =>
    fetchJson(`${cloud.backendUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    })
  const fixture = async payload => {
    const output = await commandOutputAsync(
      'uv',
      ['run', '--no-sync', 'python', 'tests/e2e/im_stand_in_fixture.py'],
      {
        cwd: join(repoDir, 'backend'),
        env: {
          ...backendEnv,
          PYTHONPATH: [repoDir, join(repoDir, 'backend')].join(delimiter),
          WEWORK_IM_STORY_REQUEST: JSON.stringify({ userId, ...payload }),
        },
      }
    )
    return JSON.parse(output.trim().split('\n').at(-1))
  }
  return {
    async prepareCloud(environment) {
      cloud = environment
      userId = (await request('/api/users/me')).id
    },
    setCloudEnvironment(environment) {
      backendEnv = environment.backendEnv
    },
    async verify(control) {
      const rpc = (method, payload) => requestExecutor(control, method, payload, uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      assert.equal((await rpc('runtime.stand_in.binding', { operation: 'get' })).status, 'unbound')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', {
        value: `/stand-in?${new URLSearchParams({
          deviceId: initial.executionDeviceId,
          profileId: '@primary',
        })}`,
      })
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      await finishStandInOnboarding(control)
      const binding = await rpc('runtime.stand_in.binding', { operation: 'get' })
      assert.equal(binding.status, 'unbound')
      const { assistant } = await request('/api/v1/personal-assistant')
      const primary = assistant.definitions.find(definition => definition.roleId === '@primary')
      assert.equal(primary.bot.spec.execution_policy.environment_id, initial.executionDeviceId)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-open"]')
      await openStandInSettings(control)
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-im-channels-toggle"]'),
        '0',
        'Manage assistant must not require a separate IM connection'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-profile-close"]')
      await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
      keys = (await fixture({ operation: 'seed', count: 2 })).keys
      const target = await fixture({ operation: 'target', deviceId: initial.executionDeviceId })
      const user = await request('/api/users/me')
      await request('/api/users/me', {
        method: 'PUT',
        body: JSON.stringify({ preferences: { default_execution_target: target.deviceId } }),
      })
      const primaryMessage = '请记住：我希望日报先列重点，再列待确认事项。'
      try {
        const entered = await fixture({
          operation: 'send',
          conversationId: `im-story-${userId}-0`,
          messageId: `default-standin-${Date.now()}`,
          message: '/standin',
        })
        assert.ok(entered.replies.some(reply => reply.includes('已进入 Wework 助理模式')))
        const sessions = await request('/api/im/private-sessions')
        const session = sessions.items.find(row => row.session_key === keys[0])
        assert.equal(session?.mode, 'stand_in')
        assert.equal(
          session.stand_in ?? null,
          null,
          'Default routing must not create a manual binding'
        )
        const sent = await fixture({
          operation: 'send',
          conversationId: `im-story-${userId}-0`,
          messageId: `primary-${Date.now()}`,
          message: primaryMessage,
        })
        assert.equal(sent.accepted, true)
        assert.deepEqual(sent.replies, [], 'The real IM route must dispatch without a setup error')
        const task = await rpc('runtime.tasks.get', { taskId: `stand-in-chat-${userId}-primary` })
        assert.ok(
          task.task,
          'The incoming IM message must create or continue the real primary identity conversation'
        )
        await control.command('waitFor', '[data-testid="stand-in-conversation"]', {
          text: primaryMessage,
        })
        await captureScreenshot(control, 'im-stand-in-03-im-message-in-primary.png')
      } finally {
        await request('/api/users/me', {
          method: 'PUT',
          body: JSON.stringify({
            preferences: {
              default_execution_target: user.preferences?.default_execution_target ?? null,
            },
          }),
        })
      }
      const savedPrimary = await rpc('runtime.stand_in.personal.get', { userId })
      const roleId = 'im-reviewer'
      const role = {
        id: roleId,
        name: 'IM 验证助理',
        enabled: false,
        prompt: '',
        version: 0,
        executionDeviceId: initial.executionDeviceId,
        model: savedPrimary.primary?.model,
        modelOptions: savedPrimary.primary?.modelOptions,
        workspace: savedPrimary.primary?.workspace,
        collaboration: {
          enabled: false,
          allProjects: true,
          projects: [],
          excludedProjects: [],
          tags: [],
        },
      }
      await rpc('runtime.stand_in.personal.save', {
        userId,
        settings: { ...savedPrimary, roles: [...savedPrimary.roles, role] },
      })
      await reloadMainWindow(control, 'The IM binding story must reconnect after reload')
      await control.command('waitFor', '[data-testid="stand-in-primary-open"]')
      await control.command('clickWhenEnabled', `[data-testid="stand-in-overview-role-${roleId}"]`)
      const explicitBinding = await request(`/api/im/private-sessions/${keys[0]}/stand-in`, {
        method: 'PUT',
        body: JSON.stringify({ deviceId: target.deviceId, roleId }),
      })
      assert.deepEqual(explicitBinding, { deviceId: target.deviceId, roleId })
      const chatMode = await fixture({
        operation: 'send',
        conversationId: `im-story-${userId}-0`,
        messageId: `chat-${Date.now()}`,
        message: '/chat',
      })
      assert.ok(chatMode.replies.some(reply => reply.includes('已返回 Wegent 聊天模式')))
      const chatSession = (await request('/api/im/private-sessions')).items.find(
        row => row.session_key === keys[0]
      )
      assert.equal(chatSession.mode, 'chat')
      assert.equal(
        chatSession.stand_in.roleId,
        roleId,
        'Leaving stand-in mode must retain the selected identity'
      )
      const standInMode = await fixture({
        operation: 'send',
        conversationId: `im-story-${userId}-0`,
        messageId: `standin-${Date.now()}`,
        message: '/standin',
      })
      assert.ok(standInMode.replies.some(reply => reply.includes('已进入 Wework 助理模式')))
      const roleMessage = '请按评审助理的职责，列出本次变更需要检查的三项内容。'
      const roleSent = await fixture({
        operation: 'send',
        conversationId: `im-story-${userId}-0`,
        messageId: `role-${Date.now()}`,
        message: roleMessage,
      })
      assert.equal(roleSent.accepted, true)
      assert.deepEqual(roleSent.replies, [])
      await control.command('waitFor', '[data-testid="stand-in-conversation"]', {
        text: roleMessage,
      })
      await captureScreenshot(control, 'im-stand-in-07-im-message-in-role.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-open"]')
      await control.command('waitFor', '[data-testid="stand-in-conversation"]', {
        text: primaryMessage,
      })
      assert.ok(
        !(await control.command('getText', '[data-testid="stand-in-conversation"]')).includes(
          roleMessage
        ),
        'Rebinding must preserve the primary history without copying role input into it'
      )
      const nonexistentDevice = await fetch(
        `${cloud.backendUrl}/api/im/private-sessions/${keys[0]}/stand-in`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deviceId: 'not-an-owned-device', roleId: null }),
        }
      )
      assert.equal(nonexistentDevice.status, 404, 'An unowned device must not replace the binding')
      const foreign = (await fixture({ operation: 'seed', userId: userId + 1000000, count: 1 }))
        .keys[0]
      const foreignBinding = await fetch(
        `${cloud.backendUrl}/api/im/private-sessions/${foreign}/stand-in`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deviceId: initial.executionDeviceId, roleId: null }),
        }
      )
      assert.equal(foreignBinding.status, 404, 'Another user’s IM address must never be bindable')
      assert.deepEqual(await fixture({ operation: 'protocol' }), { verified: true })
      const latest = await rpc('runtime.stand_in.personal.get', { userId })
      await rpc('runtime.stand_in.personal.save', {
        userId,
        settings: { ...savedPrimary, version: latest.version },
      })
    },
  }
}
