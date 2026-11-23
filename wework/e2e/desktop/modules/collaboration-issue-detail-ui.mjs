import assert from 'node:assert/strict'

export async function verifyIssueDetailPropertyUi(control, scope, timeoutMs) {
  const summary = scope('[data-testid="cloud-todo-state-summary"]')
  await control.command('waitFor', summary, { visible: true, timeoutMs })
  const { text: summaryText } = JSON.parse(await control.command('snapshot', summary))
  const propertyLabels = `${summary} [data-testid="issue-property-grid"] dt`
  assert.equal(
    Number(await control.command('getElementCount', propertyLabels)),
    4,
    'The Issue property grid must contain four labels'
  )
  assert.equal(
    await control.command('getText', propertyLabels),
    '状态\n负责人\n里程碑\n时间范围',
    'Each Issue property must have exactly one label in the property grid'
  )
  const metadata = scope('[data-testid="issue-primary-metadata"]')
  await control.command('waitFor', metadata, { visible: true, timeoutMs })
  const metadataText = await control.command('getText', metadata)
  assert.match(metadataText, /标签/)
  assert.match(metadataText, /参与者/)
  const propertyHeight = await control.command(
    'getComputedStyleValue',
    `${summary} .task-detail-property`,
    {
      value: 'min-height',
    }
  )
  assert.equal(
    await control.command('getComputedStyleValue', `${metadata} .task-detail-rail-prop`, {
      value: 'min-height',
    }),
    propertyHeight,
    'Primary metadata must share the property row height'
  )
  assert.equal(
    await control.command('getComputedStyleValue', `${metadata} .task-detail-rail-key`, {
      value: 'font-weight',
    }),
    await control.command('getComputedStyleValue', propertyLabels, { value: 'font-weight' }),
    'Primary metadata labels must share the property label weight'
  )
  await control.command('waitFor', `${metadata} [data-testid="cloud-todo-collaborators"]`, {
    visible: true,
    timeoutMs,
  })
  assert.doesNotMatch(
    summaryText,
    /可见范围/,
    'The secondary visibility control must not repeat its property label'
  )
  assert.equal(
    await control.command('getAttribute', scope('[data-testid="cloud-todo-detail-assignee"]'), {
      value: 'aria-label',
    }),
    '负责人',
    'The assignee icon control must remain accessible'
  )
  assert.equal(
    await control.command('getAttribute', scope('[data-testid="cloud-issue-security-level"]'), {
      value: 'aria-label',
    }),
    '任务可见范围',
    'The visibility icon control must remain accessible'
  )

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
    text: '继续此讨论',
    timeoutMs,
  })
  assert.doesNotMatch(
    await control.command('getText', reply),
    /将继续原执行任务/,
    'A plain discussion without an execution binding must not promise to resume a task'
  )
  const placeholder = `${reply} [data-testid="task-comment-form"] .composer-prosemirror-placeholder`
  await control.command('waitFor', placeholder, {
    text: '回复此讨论…',
    timeoutMs,
  })
}
