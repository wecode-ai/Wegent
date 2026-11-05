import assert from 'node:assert/strict'

export async function verifyIssueDetailPropertyUi(control, scope, timeoutMs) {
  const summary = scope('[data-testid="cloud-todo-state-summary"]')
  await control.command('waitFor', summary, { visible: true, timeoutMs })
  const summaryText = await control.command('getText', summary)
  assert.doesNotMatch(
    summaryText,
    /创建人|报告人|可见范围/,
    'Secondary properties belong in the more information popover'
  )
  assert.equal(summaryText.match(/负责人/g)?.length, 1, 'Show the assignee label exactly once')
  assert.equal(
    await control.command('getAttribute', scope('[data-testid="cloud-todo-detail-assignee"]'), {
      value: 'aria-label',
    }),
    '负责人',
    'The assignee icon control must remain accessible'
  )
  await control.command('click', scope('[data-testid="cloud-todo-more-properties"]'))
  const properties = '[data-testid="cloud-todo-more-properties-popover"]'
  await control.command('waitFor', properties, { visible: true, timeoutMs })
  assert.equal(
    await control.command(
      'getAttribute',
      `${properties} [data-testid="cloud-issue-security-level"]`,
      {
        value: 'aria-label',
      }
    ),
    '任务可见范围',
    'The visibility icon control must remain accessible'
  )
  await control.command('press', properties, { key: 'Escape' })
  await control.command('waitFor', properties, { visible: false, timeoutMs })

  const status = scope('[data-testid="cloud-todo-detail-status"]')
  await control.command('hover', status, { visible: true })
  await control.command('waitFor', '[role="tooltip"]', {
    text: '表示 Issue 当前所处的处理阶段',
    timeoutMs,
  })
}

export async function verifyNewDiscussionComposerUi(control, scope, timeoutMs) {
  const placeholder = scope('[data-testid="task-comment-form"] .composer-prosemirror-placeholder')
  await control.command('waitFor', placeholder, {
    text: '发起新讨论…',
    timeoutMs,
  })
}

export async function verifyReplyComposerUi(control, scope, timeoutMs) {
  const reply = scope('[data-testid="issue-reply-composer"]')
  await control.command('waitFor', reply, {
    text: '将继续原执行任务',
    timeoutMs,
  })
  const placeholder = `${reply} [data-testid="task-comment-form"] .composer-prosemirror-placeholder`
  await control.command('waitFor', placeholder, {
    text: '回复此讨论（继续原执行任务）',
    timeoutMs,
  })
}
