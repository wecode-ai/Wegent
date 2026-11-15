import assert from 'node:assert/strict'

import { createDesktopScenario as createCoordinateScenario } from './collaboration-remote-group-coordinate.scenario.mjs'
import { waitForTestIdByText } from '../modules/workspace-flows.mjs'
import { REMOTE_DOCKER_DEVICE_ID } from '../modules/shared.mjs'

export async function createDesktopScenario(options) {
  return createCoordinateScenario({
    ...options,
    async verifyManagerPlanning(control, { groupRules, leader }) {
      const eventTestId = await waitForTestIdByText(
        control,
        'body',
        'cloud-task-manager-event-',
        leader,
        options.uiTimeoutMs
      )
      await control.command('waitFor', `[data-testid="${eventTestId}"]`, {
        text: '正在规划任务',
      })
      const executionTestId = eventTestId.replace(
        'cloud-task-manager-event-',
        'cloud-task-manager-execution-'
      )
      const panel = '[data-testid="work-item-task-chat-panel"]'
      const close = '[data-testid="ai-chat-modal"] [data-testid="ai-chat-modal-close"]'
      const before = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const lastLogId = before.logs.at(-1)?.id ?? 0
      await control.command('click', `[data-testid="${executionTestId}"]`)
      await control.command('waitFor', panel, { text: groupRules, visible: true })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${panel} [data-testid="temporary-conversation-retry"]`
          )
        ),
        0,
        '远程负责人规划详情加载失败，显示了会话重试入口'
      )
      await control.command('waitFor', `${panel} [data-testid="pause-response-button"]`, {
        visible: true,
      })
      await options.captureScreenshot(
        control,
        'remote-group-planning-details-01-loaded.png',
        'body'
      )
      await control.command('waitFor', close, { visible: true })
      await control.command('click', close, { visible: true })
      await control.command('waitFor', panel, { visible: false })
      const after = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const redundantIdentityRequests = after.logs.filter(
        entry =>
          entry.id > lastLogId &&
          entry.args.some(value => String(value).includes('runtime.stand_in.device_identity')) &&
          entry.args.some(value => String(value).includes(REMOTE_DOCKER_DEVICE_ID))
      )
      assert.equal(
        redundantIdentityRequests.length,
        0,
        'A persisted remote task binding must not require a desktop alias identity RPC'
      )
      await control.command('click', `[data-testid="${executionTestId}"]`)
      await control.command('waitFor', panel, { text: groupRules, visible: true })
      await control.command('waitFor', close, { visible: true })
      await control.command('click', close, { visible: true })
      await control.command('waitFor', panel, { visible: false })
    },
  })
}
