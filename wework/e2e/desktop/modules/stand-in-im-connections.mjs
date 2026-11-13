import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { commandOutputAsync, fetchJson, join, repoDir } from './shared.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { openStandInDetails } from './stand-in-profile-navigation.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { finishStandInOnboarding } from './stand-in-instance-flows.mjs'
import { selectWorkbenchTheme } from './appearance-theme.mjs'

/** Reuse the real Backend/Redis/Executor; only the external IM input is synthetic. */
export function createStandInImConnectionsStory({ uiTimeoutMs, captureScreenshot }) {
  let cloud
  let backendEnv
  let cloudHost
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
      cloudHost = environment
    },
    async verify(control) {
      const rpc = (method, payload) => requestExecutor(control, method, payload, uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId })
      assert.equal((await rpc('runtime.stand_in.binding', { operation: 'get' })).status, 'unbound')
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('navigate', 'body', {
        value: `/stand-in?deviceId=${encodeURIComponent(initial.executionDeviceId)}`,
      })
      await control.command('waitFor', '[data-testid="stand-in-overview"]')
      await finishStandInOnboarding(control)
      const binding = await rpc('runtime.stand_in.binding', { operation: 'get' })
      assert.equal(binding.status, 'active')
      assert.equal(binding.target.userId, userId)
      assert.equal(binding.target.deviceId, initial.executionDeviceId)
      await openStandInDetails(control)
      await captureScreenshot(control, 'im-stand-in-00-channel-popover.png')
      assert.equal(
        await control.command('getElementCount', '[data-testid="stand-in-profile-panel"]'),
        '0',
        'IM channels must open directly from the identity popover'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-channel-telegram"]')
      const closeConnections = async () => {
        await control.command('focusMainWindow')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-im-dialog-close"]')
        await control.command('waitFor', '[data-testid="stand-in-im-channel-telegram"]:focus')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-details-open"]')
        await control.command('waitFor', '[data-testid="stand-in-details-popover"]', {
          visible: false,
        })
      }
      const panel = '[data-testid="stand-in-im-dialog"]'
      const connections = `${panel} [data-testid="stand-in-im-connections"]`
      const refresh = `${panel} [data-testid="stand-in-im-refresh"]`
      const waitForPrimaryConnections = async count => {
        await control.command('waitFor', refresh, { enabled: true })
        await control.command('waitFor', `${connections} [data-testid="stand-in-im-loading"]`, {
          visible: false,
        })
        assert.equal(
          await control.command(
            'getElementCount',
            `${connections} button[data-testid^="stand-in-im-connect-"]`
          ),
          String(count)
        )
      }
      await control.command('waitFor', connections, { text: '还没有已登记的 Telegram 私聊' })
      await waitForPrimaryConnections(0)
      await captureScreenshot(control, 'im-stand-in-00-empty-conversations.png')
      keys = (await fixture({ operation: 'seed', count: 1 })).keys
      const first = `[data-testid="stand-in-im-connect-${keys[0]}"]`
      await control.command('clickWhenEnabled', refresh)
      await control.command('waitFor', `${panel} ${first}`)
      await waitForPrimaryConnections(1)
      await captureScreenshot(control, 'im-stand-in-00-single-conversation.png')
      await control.command('nativePress', '[data-testid="stand-in-im-mode-help"]', { key: 'Tab' })
      await control.command('waitFor', '[data-testid="stand-in-im-dialog-close"]:focus')
      await control.command('nativePress', '[data-testid="stand-in-im-dialog-close"]', {
        key: 'Escape',
      })
      await control.command('waitFor', '[data-testid="stand-in-im-channel-telegram"]:focus')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-channel-telegram"]')
      keys = (await fixture({ operation: 'seed', count: 2 })).keys
      await control.command('clickWhenEnabled', refresh)
      await control.command('waitFor', `${panel} [data-testid="stand-in-im-connect-${keys[1]}"]`)
      await control.command('waitFor', `${panel} ${first}`)
      await waitForPrimaryConnections(2)
      await captureScreenshot(control, 'im-stand-in-01-primary-conversations.png')
      await control.command('waitFor', `${panel} ${first}`, { enabled: true })
      await control.command('clickWhenEnabled', `${panel} ${first}`)
      await control.command('waitFor', `${panel} [data-testid="stand-in-im-submit"]`, {
        enabled: true,
      })
      await control.command('nativePress', `${panel} [data-testid="stand-in-im-submit"]`, {
        key: 'Enter',
      })
      await control.command('waitFor', `${panel} ${first}`, { text: '已连接当前助理' })
      const sessions = await request('/api/im/private-sessions')
      const target = await fixture({ operation: 'target', deviceId: initial.executionDeviceId })
      assert.equal(sessions.items.find(row => row.session_key === keys[0]).mode, 'stand_in')
      assert.deepEqual(sessions.items.find(row => row.session_key === keys[0]).stand_in, {
        deviceId: target.deviceId,
        roleId: null,
      })
      await captureScreenshot(control, 'im-stand-in-02-primary-connected.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-submit"]')
      await control.command('waitFor', '[data-testid="stand-in-im-channel-telegram"]:focus')
      await captureScreenshot(control, 'im-stand-in-02-connected-channel-popover.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-channel-telegram"]')
      const primaryMessage = '请记住：我希望日报先列重点，再列待确认事项。'
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
      await closeConnections()
      await control.command('waitFor', '[data-testid="stand-in-conversation"]', {
        text: primaryMessage,
      })
      await captureScreenshot(control, 'im-stand-in-03-im-message-in-primary.png')
      const savedPrimary = await rpc('runtime.stand_in.personal.get', { userId })
      const roleId = 'im-reviewer'
      const role = {
        id: roleId,
        name: 'IM 验证分身',
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
      await openStandInDetails(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-channel-telegram"]')
      const rolePanel = panel
      await control.command('waitFor', `${rolePanel} ${first}`)
      await captureScreenshot(control, 'im-stand-in-04-role-before-rebind.png')
      await control.command('clickWhenEnabled', `${rolePanel} ${first}`)
      await control.command('clickWhenEnabled', `${rolePanel} [data-testid="stand-in-im-submit"]`)
      await control.command('waitFor', `${rolePanel} ${first}`, { text: '已连接当前助理' })
      await captureScreenshot(control, 'im-stand-in-05-role-connected.png')
      const previousWindowSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1000, height: 760 }),
        })
      )
      await control.command('waitFor', `${rolePanel} ${first}`)
      await captureScreenshot(control, 'im-stand-in-06-role-narrow.png')
      const roleRefresh = `${rolePanel} [data-testid="stand-in-im-refresh"]`
      await control.command('scrollIntoView', roleRefresh)
      await control.command('clickWhenEnabled', roleRefresh)
      await control.command('waitFor', roleRefresh, { enabled: true })
      await control.command('waitFor', `${rolePanel} [data-testid="stand-in-im-loading"]`, {
        visible: false,
      })
      await captureScreenshot(control, 'im-stand-in-06-role-narrow-refreshed.png')
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify(previousWindowSize),
      })
      await closeConnections()
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
      assert.ok(standInMode.replies.some(reply => reply.includes('已进入 Wework 分身模式')))
      const roleMessage = '请按评审分身的职责，列出本次变更需要检查的三项内容。'
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
      await openStandInDetails(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-channel-telegram"]')
      await control.command('waitFor', `${panel} ${first}`)
      assert.ok(
        (
          await control.command('getText', `${panel} [data-testid="stand-in-im-connections"]`)
        ).includes('已连接其他助理')
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
      let backendStopped = false
      try {
        await cloudHost.stopBackend()
        backendStopped = true
        await control.command('clickWhenEnabled', `${panel} [data-testid="stand-in-im-refresh"]`)
        await control.command('waitFor', `${panel} [role="alert"]`, { text: '无法加载 IM 会话' })
        assert.equal(
          await control.command('getElementCount', `${panel} ${first}`),
          '1',
          'A failed refresh must retain the known conversations'
        )
        await captureScreenshot(control, 'im-stand-in-08-offline-preserves-conversations.png')
        await cloudHost.launchBackend()
        backendStopped = false
        await control.command('clickWhenEnabled', `${panel} [data-testid="stand-in-im-refresh"]`)
        await control.command('waitFor', `${panel} [data-testid="stand-in-im-refresh"]`, {
          enabled: true,
        })
        await control.command('waitFor', `${panel} [role="alert"]`, { visible: false })
        await control.command('waitFor', `${panel} ${first}`)
        await captureScreenshot(control, 'im-stand-in-09-recovered-conversations.png')
      } finally {
        if (backendStopped) await cloudHost.launchBackend()
      }
      await closeConnections()
      await selectWorkbenchTheme(control, { mode: 'dark', themeId: 'wework' })
      await openStandInDetails(control)
      await captureScreenshot(control, 'im-stand-in-10-channel-popover-dark.png')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-im-channel-telegram"]')
      await waitForPrimaryConnections(2)
      await captureScreenshot(control, 'im-stand-in-10-channel-dialog-dark.png')
      const desktopSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 375, height: 800 }),
        })
      )
      await control.command('waitFor', refresh, { enabled: true })
      const [mobileDialog] = JSON.parse(await control.command('getElementMetrics', panel))
      assert.equal(mobileDialog.viewportWidth, 375)
      assert.ok(mobileDialog.left >= 0 && mobileDialog.right <= 375)
      await captureScreenshot(control, 'im-stand-in-11-channel-dialog-mobile.png')
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify(desktopSize),
      })
      await closeConnections()
      await selectWorkbenchTheme(control, { mode: 'light', themeId: 'wework' })
      assert.deepEqual(await fixture({ operation: 'protocol' }), { verified: true })
      const latest = await rpc('runtime.stand_in.personal.get', { userId })
      await rpc('runtime.stand_in.personal.save', {
        userId,
        settings: { ...savedPrimary, version: latest.version },
      })
    },
  }
}
