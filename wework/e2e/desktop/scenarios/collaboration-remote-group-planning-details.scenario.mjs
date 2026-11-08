import assert from 'node:assert/strict'

import { createDesktopScenario as createCoordinateScenario } from './collaboration-remote-group-coordinate.scenario.mjs'
import { waitForTestIdByText } from '../modules/workspace-flows.mjs'

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
      await control.command('click', `[data-testid="${executionTestId}"]`)
      await control.command('waitFor', panel, { text: groupRules, visible: true })
      await control.command('waitFor', close, { visible: true })
      await control.command('click', close, { visible: true })
      await control.command('waitFor', panel, { visible: false })
    },
  })
}
