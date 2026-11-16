import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scope = selector => `${CONTENT} ${selector}`
const TITLE = 'Issue 阅读与回复回归'
const DESCRIPTION = [
  '## 目标',
  '让参与者打开详情即可理解目标与验收结果。',
  '### 验收标准',
  '- 保留事项标题和状态',
  '- 普通讨论回复不承诺继续执行',
  ...Array.from({ length: 8 }, (_, index) => `补充背景 ${index + 1}：检查长描述的展开与收起。`),
].join('\n\n')

function luminance(color) {
  const channels = color.match(/[\d.]+/g)?.map(Number)
  assert.ok(channels?.length >= 3, `Expected an RGB color, received ${color}`)
  assert.ok(channels.length === 3 || channels[3] === 1, `Expected opaque color: ${color}`)
  return channels.slice(0, 3).reduce((sum, channel, index) => {
    const value = channel / 255
    return (
      sum +
      (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][index]
    )
  }, 0)
}

async function verifyComposerVisible(control) {
  const selectors = [
    '[data-testid="cloud-todo-detail-scroll"]',
    '[data-testid="task-comment-form"]',
    '[data-testid="task-comment-form"] [data-testid="send-message-button"]',
  ]
    .map(scope)
    .join(', ')
  const metrics = JSON.parse(
    await control.command('getElementMetrics', selectors, { value: 'includeText' })
  )
  const scroll = metrics.find(row => row.testId === 'cloud-todo-detail-scroll')
  const form = metrics.find(row => row.testId === 'task-comment-form')
  const send = metrics.find(row => row.testId === 'send-message-button')
  assert.ok(
    scroll && form && send,
    'The Issue must expose its scroll viewport, composer and send action'
  )
  assert.ok(
    form.top >= scroll.top && form.bottom <= scroll.bottom - 15,
    `The entire composer must remain inside the viewport and bottom inset: ${JSON.stringify({ scroll, form })}`
  )
  assert.ok(
    send.top >= form.top && send.bottom <= form.bottom,
    'The send action must stay inside its composer'
  )
}

async function verifyConstrainedDiscussion(control, captureScreenshot) {
  const previous = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 720, height: 450 }),
    })
  )
  try {
    const action = scope('[data-testid="issue-persistent-task-action"]')
    await control.command('waitFor', action, { visible: true, stableMs: 300 })
    await verifyComposerVisible(control)
    const selectors = [
      scope('[data-testid="cloud-todo-detail"] > header'),
      action,
      scope('[data-testid="cloud-todo-detail-scroll"]'),
      scope('[data-testid="issue-reply-composer"]'),
    ].join(', ')
    const [header, taskAction, scroll, reply] = JSON.parse(
      await control.command('getElementMetrics', selectors, { value: 'includeText' })
    )
    assert.ok(taskAction.top >= header.top && taskAction.bottom <= header.bottom)
    assert.ok(
      scroll.height - reply.height - 16 >= scroll.height / 2,
      'At least half the constrained discussion viewport must remain available for reading'
    )
    await captureScreenshot(control, 'issue-detail-reading-03-constrained.png')
  } finally {
    await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previous) })
  }
}

export async function verifyIssueDetailReading(control, { captureScreenshot, uiTimeoutMs }) {
  await control.command('click', scope('[data-testid="cloud-todo-detail-close"]'))
  await control.command('waitFor', scope('[data-testid="cloud-todo-detail"]'), { visible: false })
  await control.command('clickWhenEnabled', scope('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scope('[data-testid="cloud-todo-title"]'), { value: TITLE })
  await control.command('fill', scope('[data-testid="cloud-todo-detail-description"]'), {
    value: DESCRIPTION,
  })
  await control.command('clickWhenEnabled', scope('[data-testid="cloud-todo-create-confirm"]'))
  const detail = scope('[data-testid="cloud-todo-detail"]')
  const description = `${detail} .task-detail-desc .bn-editor`
  await control.command('waitFor', detail, { text: TITLE, visible: true, timeoutMs: uiTimeoutMs })
  await control.command('waitFor', description, {
    text: '让参与者打开详情即可理解目标与验收结果。',
  })
  const metrics = JSON.parse(
    await control.command('getElementMetrics', `${description}, ${description} .bn-block-outer`, {
      value: 'includeText',
    })
  )
  const preview = metrics[0]
  const goal = metrics.find(row => row.text?.trim() === '让参与者打开详情即可理解目标与验收结果。')
  assert.ok(goal, 'The goal paragraph must render in the description')
  assert.ok(
    goal.top >= preview.top && goal.bottom <= preview.bottom + 1,
    'The collapsed description must include the goal body, not only its heading'
  )
  await verifyComposerVisible(control)
  const toggle = scope('[data-testid="issue-description-toggle"]')
  await control.command('waitFor', `${toggle}[aria-expanded="false"]`)
  await control.command('click', toggle)
  await control.command('waitFor', `${toggle}[aria-expanded="true"]`)
  await control.command('click', toggle)
  await control.command('waitFor', `${toggle}[aria-expanded="false"]`)
  await captureScreenshot(control, 'issue-detail-reading-01-description.png')

  await control.command('nativePress', scope('[data-testid="issue-description-edit"]'), {
    key: 'Enter',
  })
  const save = scope('[data-testid="cloud-todo-save"]')
  await control.command('waitFor', `${save}:disabled`, { visible: true, stableMs: 300 })
  assert.doesNotMatch(
    await control.command('getText', detail),
    /有未保存的修改/,
    'Entering description editing must not turn Markdown normalization into an unsaved edit'
  )
  await control.command('fill', scope('[data-testid="cloud-todo-detail-description"]'), {
    value: DESCRIPTION + '\n\n已核对描述保存。',
  })
  await control.command('clickWhenEnabled', save)
  await control.command('waitFor', description, { text: '已核对描述保存。' })
  await control.command('waitFor', scope('[data-testid="issue-save-status"]'), { text: '已保存' })

  const title = scope('[data-testid="cloud-todo-detail-title"]')
  await control.command('fill', title, { value: `${TITLE}已更新` })
  await control.command('waitFor', scope('[data-testid="issue-save-status"]'), {
    text: '有未保存的修改',
  })
  await control.command('press', title, { key: 'Enter' })
  await control.command('waitFor', scope('[data-testid="issue-save-status"]'), { text: '已保存' })

  const composer = scope('[data-testid="cloud-task-activity-composer"]')
  const name = await control.command('getAttribute', composer, { value: 'aria-label' })
  assert.ok(name?.trim(), 'The discussion editor must have an accessible name')
  const body = '普通人工讨论，只补充验收背景。'
  await control.command('fill', composer, { value: body })
  await control.command(
    'clickWhenEnabled',
    scope('[data-testid="task-comment-form"] [data-testid="send-message-button"]')
  )
  const list = scope('[data-testid="cloud-task-activity-list"]')
  await control.command('waitFor', list, { text: body })
  const snapshot = JSON.parse(await control.command('snapshot', list))
  const reply = snapshot.testIds.find(id => id.startsWith('cloud-task-activity-reply-toggle-'))
  assert.ok(reply, 'The persisted comment must offer a reply')
  const replySelector = scope(`[data-testid="${reply}"]`)
  await control.command('scrollIntoView', replySelector)
  await control.command('waitFor', scope('[data-testid="issue-header-context"]'), {
    text: `${TITLE}已更新`,
    visible: true,
  })
  const timestamp = `${list} .task-detail-thread-actions time`
  const foreground = luminance(
    await control.command('getComputedStyleValue', timestamp, { value: 'color' })
  )
  const background = luminance(
    await control.command('getComputedStyleValue', detail, { value: 'background-color' })
  )
  const ratio =
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  assert.ok(ratio >= 4.5, `Comment timestamp contrast must reach 4.5:1, received ${ratio}`)
  await control.command('click', replySelector)
  const replyComposer = scope('[data-testid="issue-reply-composer"]')
  await control.command('waitFor', replyComposer, { text: '继续此讨论', visible: true })
  assert.doesNotMatch(await control.command('getText', replyComposer), /继续原执行任务/)
  assert.equal(
    await control.command('getAttribute', composer, { value: 'aria-label' }),
    '回复此讨论…'
  )
  await captureScreenshot(control, 'issue-detail-reading-02-reply.png')
  await verifyConstrainedDiscussion(control, captureScreenshot)
  await control.command('click', scope('[data-testid="issue-reply-cancel"]'))
}
