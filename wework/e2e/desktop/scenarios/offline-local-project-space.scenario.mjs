import assert from 'node:assert/strict'
import {
  CHECKPOINT_TASK_PROMPT,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  selectE2EModel,
} from '../modules/shared.mjs'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { captureVerificationScreenshot } from '../modules/workspace-flows.mjs'

const PROJECT_NAME = '离线本地项目空间'
const TASK_NAME = '离线本地任务'
const UPDATED_TASK_NAME = '离线本地任务（已更新）'
const COMMENT_TEXT = `新增任务进展动态 ${CHECKPOINT_TASK_PROMPT}`
const REPLY_TEXT = '回复这条进展动态'

export async function verifyTaskComments(control, taskCardTestId, uiTimeoutMs) {
  const initialStatus = await control.command(
    'getAttribute',
    '[data-testid="cloud-todo-detail-status"] option:checked',
    { value: 'value' }
  )
  const activity = '[data-testid="cloud-todo-detail"] .task-detail-comments'
  const composer = `${activity} [data-testid="cloud-task-activity-composer"]`
  const send = `${activity} [data-testid="send-message-button"]`
  const assertComposerDoesNotCoverActivity = async () => {
    const [list] = JSON.parse(
      await control.command(
        'getElementMetrics',
        `${activity} [data-testid="cloud-task-activity-list"]`
      )
    )
    const [footer] = JSON.parse(
      await control.command('getElementMetrics', `${activity} .task-detail-comment-bar`)
    )
    assert.ok(footer.top >= list.bottom - 1, 'The new-task composer covers activity replies')
  }
  await control.command('scrollIntoView', composer)
  await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
  assert.equal(Number(await control.command('getElementCount', `${send}:disabled`)), 1)
  control.setScenario('checkpoint_task')
  await selectE2EModel(control, undefined, undefined, `${activity} .task-detail-comment-bar`)
  await control.command('fill', composer, { value: COMMENT_TEXT })
  await captureVerificationScreenshot(control, 'experience-activity-01-new-task-draft.png')
  await control.command('clickWhenEnabled', send, { timeoutMs: uiTimeoutMs })
  const cards = `${activity} article[data-testid^="cloud-task-activity-card-"]`
  await control.command('waitFor', cards, { text: COMMENT_TEXT, timeoutMs: uiTimeoutMs })
  const cardId = await control.command('getAttribute', cards, { value: 'data-testid' })
  const card = `[data-testid="${cardId}"]`
  const reply = `${card} [data-testid^="cloud-task-activity-card-composer-"]`
  await control.command('waitFor', card, { text: COMMENT_TEXT, timeoutMs: uiTimeoutMs })
  await control.command('waitFor', card, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: uiTimeoutMs,
  })
  const firstResponseId = await control.command('getAttribute', `${card} [data-runtime-task-id]`, {
    value: 'data-testid',
  })
  const taskId = await control.command('getAttribute', `${card} [data-runtime-task-id]`, {
    value: 'data-runtime-task-id',
  })
  assert.ok(taskId, 'New activity must bind a persistent execution task')
  await control.command('scrollIntoView', reply)
  await assertComposerDoesNotCoverActivity()
  await captureVerificationScreenshot(control, 'experience-activity-02-new-task-result.png')
  await control.command('scrollIntoView', reply)
  await control.command('waitFor', reply, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('fill', reply, { value: REPLY_TEXT })
  await captureVerificationScreenshot(control, 'experience-activity-03-reply-draft.png')
  await control.command('press', reply, { key: 'Enter' })
  await control.command('waitFor', `${card} .task-detail-comment-replies`, {
    text: REPLY_TEXT,
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  const replyResponse = `${card} [data-runtime-task-id]:not([data-testid="${firstResponseId}"])`
  await control.command('waitFor', replyResponse, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: uiTimeoutMs,
  })
  const replyTaskId = await control.command('getAttribute', replyResponse, {
    value: 'data-runtime-task-id',
  })
  assert.equal(replyTaskId, taskId, 'Reply must continue the original task')
  await control.command('scrollIntoView', replyResponse)
  await assertComposerDoesNotCoverActivity()
  await captureVerificationScreenshot(control, 'experience-activity-04-same-task-reply.png')
  await control.command('click', '[data-testid="cloud-todo-detail-close"]')
  await control.command('click', `[data-testid="${taskCardTestId}"]`)
  await control.command('waitFor', card, { text: COMMENT_TEXT, timeoutMs: uiTimeoutMs })
  await control.command('scrollIntoView', reply)
  await control.command('waitFor', `${card} .task-detail-comment-replies`, {
    text: REPLY_TEXT,
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('scrollIntoView', composer)
  await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('scrollIntoView', reply)
  await control.command('waitFor', reply, { visible: true, timeoutMs: uiTimeoutMs })
  await control.command('select', '[data-testid="cloud-todo-detail-status"]', {
    value: 'completed',
  })
  await control.command('scrollIntoView', composer)
  await control.command('clickWhenEnabled', '[data-testid="cloud-todo-save"]', {
    timeoutMs: uiTimeoutMs,
  })
  await selectE2EModel(control, undefined, undefined, `${activity} .task-detail-comment-bar`)
  await control.command('fill', composer, { value: `完成后新增任务 ${CHECKPOINT_TASK_PROMPT}` })
  await captureVerificationScreenshot(
    control,
    'experience-activity-05-completed-issue-new-task.png'
  )
  await control.command('clickWhenEnabled', send, { timeoutMs: uiTimeoutMs })
  const newCard = `${cards}:not([data-testid="${cardId}"])`
  await control.command('waitFor', newCard, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
    timeoutMs: uiTimeoutMs,
  })
  const newTaskId = await control.command('getAttribute', `${newCard} [data-runtime-task-id]`, {
    value: 'data-runtime-task-id',
  })
  assert.ok(newTaskId)
  assert.notEqual(newTaskId, taskId, 'New activity after completion must create a separate task')
  await control.command('scrollIntoView', `${newCard} [data-runtime-task-id]`)
  await assertComposerDoesNotCoverActivity()
  await captureVerificationScreenshot(control, 'experience-activity-06-independent-task-result.png')
  assert.equal(
    await control.command(
      'getAttribute',
      '[data-testid="cloud-todo-detail-status"] option:checked',
      { value: 'value' }
    ),
    'completed'
  )
  await captureVerificationScreenshot(control, 'board-task-comments-restored.png', activity)
  await control.command('select', '[data-testid="cloud-todo-detail-status"]', {
    value: initialStatus,
  })
  await control.command('clickWhenEnabled', '[data-testid="cloud-todo-save"]', {
    timeoutMs: uiTimeoutMs,
  })
}

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
      await control.command('click', `[data-testid="${taskCardTestId}"]`)
      await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
        timeoutMs: uiTimeoutMs,
      })
      await verifyTaskComments(control, taskCardTestId, uiTimeoutMs)
      await control.command('click', '[data-testid="cloud-todo-detail-close"]')
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
        text: '在云端项目中配置自动化',
      })
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="automation-create-rule"]')),
        0,
        'An unavailable automation service offered a nonfunctional editor'
      )
      await captureVerificationScreenshot(control, 'experience-entry-01-cloud-project-required.png')
      await control.command('click', '[data-testid="automation-back-to-board"]')
      await control.command('waitFor', '[data-testid="cloud-todo-add"]', { visible: true })
      await captureVerificationScreenshot(control, 'experience-entry-02-return-to-board.png')
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
