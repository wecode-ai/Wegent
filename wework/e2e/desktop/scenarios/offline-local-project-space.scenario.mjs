import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { captureVerificationScreenshot } from '../modules/workspace-flows.mjs'

const PROJECT_NAME = '离线本地项目空间'
const TASK_NAME = '离线本地任务'
const UPDATED_TASK_NAME = '离线本地任务（已更新）'

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export function createDesktopScenario({ uiTimeoutMs }) {
  let cloudProjectListFailures = 0
  const cloudDetailRequests = []

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        cloudProjectListFailures += 1
        json(response, 503, { detail: 'Desktop E2E cloud project service is unavailable' })
        return true
      }
      if (url.pathname.startsWith('/api/v1/cloud-projects/')) {
        cloudDetailRequests.push(`${request.method} ${url.pathname}`)
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-board"]')
      await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-add"]', {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="cloud-project-add"]')
      await control.command('waitFor', '[data-testid="cloud-project-name"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-name"]', {
        value: PROJECT_NAME,
      })
      await control.command('click', '[data-testid="cloud-project-location-local"]')
      await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-name"]', {
        visible: false,
        stableMs: 250,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-header-title"]', {
        text: PROJECT_NAME,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })

      await control.command('waitFor', '[data-testid="cloud-todo-column-empty-add-inbox"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-board-quick-start"]', {
        text: '快速上手',
        timeoutMs: uiTimeoutMs,
      })
      const emptyGuideSnapshot = JSON.parse(
        await control.command('snapshot', '[data-testid="cloud-board-quick-start"]')
      )
      assert.ok(
        emptyGuideSnapshot.text.includes('创建第一个 Issue'),
        'The empty board guide did not explain the first creation step'
      )
      await captureVerificationScreenshot(
        control,
        'board-quick-start-01-empty-board.png',
        '[data-testid="cloud-todo-workspace"]'
      )
      await control.command('click', '[data-testid="cloud-board-quick-start-create-action"]')
      await control.command('waitFor', '[data-testid="workspace-issue-composer"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="workspace-issue-templates"]', {
        text: '从模板开始',
        timeoutMs: uiTimeoutMs,
      })
      await captureVerificationScreenshot(
        control,
        'board-quick-start-02-creation-templates.png',
        '[data-testid="workspace-issue-composer"]'
      )
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('click', '[data-testid="cloud-todo-column-empty-add-inbox"]')
      await control.command('waitFor', '[data-testid="cloud-todo-column-quick-create-inbox"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-todo-column-quick-create-input-inbox"]', {
        value: '需要补充详情的任务',
      })
      await control.command('click', '[data-testid="cloud-todo-column-quick-create-full-inbox"]')
      await control.command('waitFor', '[data-testid="workspace-issue-composer"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('press', 'body', { key: 'Escape' })
      await control.command('waitFor', '[data-testid="cloud-todo-column-empty-add-inbox"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-todo-column-empty-add-inbox"]')
      await control.command('waitFor', '[data-testid="cloud-todo-column-quick-create-inbox"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-todo-column-quick-create-input-inbox"]', {
        value: TASK_NAME,
      })
      await control.command(
        'clickWhenEnabled',
        '[data-testid="cloud-todo-column-quick-create-confirm-inbox"]',
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid^="cloud-todo-card-"]', {
        text: TASK_NAME,
        timeoutMs: uiTimeoutMs,
      })
      const boardSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      const taskCardTestId = boardSnapshot.testIds.find(
        testId =>
          testId.startsWith('cloud-todo-card-') &&
          ![
            'cloud-todo-card-add-child-',
            'cloud-todo-card-assignee-',
            'cloud-todo-card-archive-',
            'cloud-todo-card-drop-',
            'cloud-todo-card-menu-',
            'cloud-todo-card-more-',
          ].some(prefix => testId.startsWith(prefix))
      )
      assert.ok(taskCardTestId, 'The newly created local task card was not present in the board')
      await control.command('waitFor', '[data-testid="cloud-board-quick-start-create"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', '[data-testid="cloud-board-quick-start-create"]', {
          value: 'data-complete',
        }),
        'true',
        'Creating the first board item did not complete the guide creation step'
      )
      await control.command('click', `[data-testid="${taskCardTestId}"]`)
      await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-board-quick-start-open"]', {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', '[data-testid="cloud-board-quick-start-open"]', {
          value: 'data-complete',
        }),
        'true',
        'Opening the first board item did not complete the guide detail step'
      )
      await captureVerificationScreenshot(
        control,
        'board-quick-start-03-item-details.png',
        '[data-testid="cloud-todo-workspace"]'
      )
      await control.command('fill', '[data-testid="cloud-todo-detail-title"]', {
        value: UPDATED_TASK_NAME,
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-todo-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-todo-detail-close"]')
      await control.command('waitFor', `[data-testid="${taskCardTestId}"]`, {
        text: UPDATED_TASK_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('drag', `[data-testid="${taskCardTestId}"]`, {
        target: '[data-testid="cloud-todo-column-dropzone-pending"]',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-board-quick-start-complete"]', {
        text: '快速上手已完成',
        timeoutMs: uiTimeoutMs,
      })
      await captureVerificationScreenshot(
        control,
        'board-quick-start-04-advanced.png',
        '[data-testid="cloud-todo-workspace"]'
      )
      let advancedSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      if (advancedSnapshot.testIds.includes('ai-chat-modal-close')) {
        await control.command('click', '[data-testid="ai-chat-modal-close"]')
        advancedSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      }
      if (advancedSnapshot.testIds.includes('cloud-todo-detail-close')) {
        await control.command('click', '[data-testid="cloud-todo-detail-close"]')
      }
      await control.command(
        'waitFor',
        '[data-testid="cloud-todo-column-pending"] [data-testid^="cloud-todo-card-"]',
        {
          text: UPDATED_TASK_NAME,
          timeoutMs: uiTimeoutMs,
        }
      )
      await captureVerificationScreenshot(
        control,
        'board-quick-start-05-ready-column.png',
        '[data-testid="cloud-todo-workspace"]'
      )
      await control.command('click', '[data-testid="cloud-project-files-view"]')
      await control.command('waitFor', '[data-testid="cloud-files-upload"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-manage-view"]')
      await control.command('waitFor', '[data-testid="cloud-project-members-toggle"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-automation-view"]')
      await control.command('waitFor', '[data-testid="project-automation-view"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      await control.command('waitFor', '[data-testid="automation-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="automation-button"]')
      await control.command('waitFor', '[data-testid="create-automation-button"]', {
        timeoutMs: uiTimeoutMs,
      })

      assert.ok(
        cloudProjectListFailures > 0,
        'The scenario did not exercise an unavailable cloud project list'
      )
      assert.deepEqual(
        cloudDetailRequests,
        [],
        `Local project details unexpectedly called cloud APIs: ${cloudDetailRequests.join(', ')}`
      )
    },

    diagnostics() {
      return { cloudDetailRequests, cloudProjectListFailures }
    },
  }
}
