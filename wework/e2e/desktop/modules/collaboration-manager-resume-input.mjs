import assert from 'node:assert/strict'

import { selectTool, selectedToolCall, toolOutputText } from './response-protocol.mjs'

export const MANAGER_RESUME_QUESTION = '隐私开关的默认行为需要发起方确认，是否保持存量用户现状？'
const QUESTION_CALL = 'manager-resume-business-question'

export function updateStatusArguments() {
  return {
    status: 'in_review',
    reason: '本轮两项成员任务均已完成，负责人已综合核验。',
    comment: '负责人已核验本轮两项任务的执行证据，提交 Issue 待确认。',
  }
}

export function createCollaborationIssueReplies(scope, managerReplyResult) {
  const scoped = selector => `${scope} ${selector}`
  const replyToActivity = async (control, cardTestId, text) => {
    const messageId = cardTestId.slice('cloud-task-activity-card-'.length)
    await control.command('scrollIntoView', scoped(`[data-testid="${cardTestId}"]`))
    await control.command(
      'click',
      scoped(`[data-testid="cloud-task-activity-reply-toggle-${messageId}"]`)
    )
    const composer = scoped('[data-testid="issue-reply-composer"]')
    await control.command('fill', `${composer} [data-testid="cloud-task-activity-composer"]`, {
      value: text,
    })
    await control.command('clickWhenEnabled', `${composer} [data-testid="send-message-button"]`)
  }
  const replyToManagerConclusion = async (control, cardTestId, text, timeoutMs) => {
    const messageId = cardTestId.slice('cloud-task-activity-card-'.length)
    await control.command('scrollIntoView', scoped(`[data-testid="${cardTestId}"]`))
    await control.command(
      'click',
      scoped(`[data-testid="cloud-task-activity-open-task-${messageId}"]`)
    )
    const panel = scoped('[data-testid="work-item-task-chat-panel"]')
    const composer = `${panel} [data-testid="chat-message-input"]`
    await control.command('waitFor', composer, { timeoutMs })
    await control.command('fill', composer, { value: text })
    await control.command('clickWhenEnabled', `${panel} [data-testid="send-message-button"]`, {
      timeoutMs,
    })
    await control.command('waitFor', `${panel} [data-testid="message-assistant"]`, {
      text: managerReplyResult,
      timeoutMs,
    })
    await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
    await control.command('waitFor', panel, { visible: false, timeoutMs })
  }
  return { scoped, replyToActivity, replyToManagerConclusion }
}

export function managerResumeQuestion(body) {
  const answer = toolOutputText(body, QUESTION_CALL)
  if (answer !== null) {
    assert.deepEqual(JSON.parse(answer), {
      answers: {
        rollout: { answers: ['保持现状'] },
        readers: { answers: ['限定本仓'] },
        target: { answers: ['新增隐私项'] },
      },
    })
    return null
  }
  return selectedToolCall(
    QUESTION_CALL,
    selectTool(body, 'request_user_input', {
      questions: [
        {
          id: 'rollout',
          header: '默认行为',
          question: MANAGER_RESUME_QUESTION,
          options: [
            { label: '保持现状', description: '存量用户保持原行为，可回滚。' },
            { label: '默认开启', description: '发布后改变存量用户行为，需另行评审。' },
          ],
        },
        {
          id: 'readers',
          header: '生效范围',
          question: '哪些读取方需要遵循这个开关？',
          options: [
            { label: '限定本仓', description: '只影响当前仓库内的读取链路。' },
            { label: '跨服务', description: '需要其他服务一起变更和联调。' },
          ],
        },
        {
          id: 'target',
          header: '开关对象',
          question: '需要新增隐私项还是调整已有功能开关？',
          options: [
            { label: '新增隐私项', description: '新增独立的用户隐私配置。' },
            { label: '已有功能开关', description: '修改已有功能的开启条件。' },
          ],
        },
      ],
    })
  )
}

/** The user can reach the resumed manager while its native input call is blocked. */
export async function answerResumedManagerFromIssue({
  control,
  scope,
  leader,
  request,
  issueId,
  managerTaskId,
  previousManagerEvents,
  waitForValue,
  timeoutMs,
}) {
  const bindings = await waitForValue(
    () => request(`/api/v1/loop-items/${issueId}/tasks`),
    rows => rows.some(row => row.task_id === managerTaskId) && rows,
    'The waiting manager has no Issue transcript binding',
    timeoutMs
  )
  assert.ok(bindings.some(row => row.task_id === managerTaskId))
  await control.command(
    'waitFor',
    `${scope} [data-testid="cloud-todo-detail-assignee"][data-value="agent:${leader.id}"]`,
    { timeoutMs }
  )
  const event = await waitForValue(
    async () => {
      const snapshot = JSON.parse(
        await control.command('snapshot', `${scope} [data-testid="cloud-task-activity-list"]`)
      )
      return snapshot.testIds.filter(
        id => id.startsWith('cloud-task-manager-event-') && !previousManagerEvents.includes(id)
      )
    },
    ids => {
      assert.ok(ids.length <= 1, 'One finished round must create exactly one manager activity')
      return ids[0] ?? null
    },
    'The resumed manager has no visible Issue activity',
    timeoutMs
  )
  const messageId = event.slice('cloud-task-manager-event-'.length)
  await control.command('waitFor', `${scope} [data-testid="${event}"]`, { text: leader.name })
  await control.command('scrollIntoView', `${scope} [data-testid="${event}"]`)
  await control.command(
    'clickWhenEnabled',
    `${scope} [data-testid="cloud-task-manager-execution-${messageId}"]`
  )
  const panel = `${scope} [data-testid="work-item-task-chat-panel"]`
  await control.command('waitFor', `${panel} [data-testid="request-user-input-questions"]`, {
    text: MANAGER_RESUME_QUESTION,
    timeoutMs,
  })
  await control.command('click', `${panel} [data-testid="request-user-input-option-rollout-0"]`)
  await control.command('click', `${panel} [data-testid="request-user-input-option-readers-0"]`)
  await control.command('click', `${panel} [data-testid="request-user-input-option-target-0"]`)
  await control.command(
    'clickWhenEnabled',
    `${panel} [data-testid="request-user-input-submit-button"]`
  )
  await control.command('waitFor', `${panel} [data-testid="request-user-input-submit-button"]`, {
    visible: false,
    timeoutMs,
  })
  await control.command('click', `${scope} [data-testid="ai-chat-modal-close"]`)
  await control.command('waitFor', panel, { visible: false, timeoutMs })
}
