export const MANAGER_RESUME_QUESTION = '隐私开关的默认行为需要发起方确认，是否保持存量用户现状？'

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
