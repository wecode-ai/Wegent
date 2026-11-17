import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scope = selector => `${CONTENT} ${selector}`
const TITLE = 'Issue 阅读与回复回归：窄窗口与字号变化后的长标题完整显示'
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

async function verifyConstrainedDiscussion(control, captureScreenshot, replySelector) {
  const previous = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 720, height: 450 }),
    })
  )
  try {
    await control.command('click', scope('[data-testid="issue-reply-cancel"]'))
    const sendActions = scope('[data-testid="task-comment-form-send-actions"]')
    await control.command('waitFor', sendActions)
    await control.command('scrollIntoViewAsUser', sendActions)
    await control.command('click', sendActions)
    const sendOption = '[data-testid="task-comment-form-send-option"]'
    const closeOption = '[data-testid="task-comment-form-close"]'
    await control.command('waitFor', sendOption, { visible: true })
    await verifyTouchTargets(control, sendOption + ', ' + closeOption)
    await control.command('nativePress', closeOption, { key: 'Escape' })
    await control.command('waitFor', sendOption, { visible: false })
    await control.command('scrollIntoViewAsUser', replySelector)
    await control.command('click', replySelector)
    await control.command('waitFor', scope('[data-testid="issue-reply-composer"]'), {
      visible: true,
    })
    await verifyNarrowProperties(control)
    await control.command(
      'scrollIntoViewAsUser',
      scope('[data-testid="cloud-todo-detail-tag-input"]')
    )
    await control.command('fill', scope('[data-testid="cloud-todo-detail-tag-input"]'), {
      value: '触控回归,',
    })
    const removeTag = scope('[data-testid="cloud-todo-detail-tag-tag-remove-触控回归"]')
    await control.command('waitFor', removeTag, { visible: true })
    await verifyTouchTargets(control, removeTag)
    await control.command('click', removeTag)
    await control.command('waitFor', removeTag, { visible: false })
    await control.command('scrollIntoViewAsUser', scope('[data-testid="issue-milestone"]'))
    await control.command('click', scope('[data-testid="issue-milestone"]'))
    const milestone = '[data-testid="issue-milestone-option-empty"]'
    await control.command('waitFor', milestone, { visible: true })
    await verifyTouchTargets(control, '[data-testid^="issue-milestone-option-"]')
    await control.command('nativePress', milestone, { key: 'Escape' })
    await control.command('waitFor', milestone, { visible: false })
    await control.command(
      'scrollIntoViewAsUser',
      scope('[data-testid="cloud-todo-detail-start-date-trigger"]')
    )
    await control.command(
      'waitFor',
      scope('[data-testid="cloud-todo-detail-start-date-trigger"]'),
      { visible: true }
    )
    await control.command('click', scope('[data-testid="cloud-todo-detail-start-date-trigger"]'))
    const dateFields =
      '[data-testid="cloud-todo-detail-start-date"], [data-testid="cloud-todo-detail-due-date"]'
    await control.command('waitFor', '[data-testid="cloud-todo-detail-start-date"]', {
      visible: true,
    })
    const dates = JSON.parse(await control.command('getElementMetrics', dateFields))
    assert.equal(dates.length, 2)
    for (const date of dates) {
      assert.ok(
        date.width >= 44 && date.height >= 44,
        `Narrow date fields must remain at least 44px: ${JSON.stringify(date)}`
      )
    }
    const foreground = luminance(
      await control.command(
        'getComputedStyleValue',
        'label:has([data-testid="cloud-todo-detail-start-date"])',
        { value: 'color' }
      )
    )
    const background = luminance(
      await control.command(
        'getComputedStyleValue',
        '[role="dialog"]:has(> div > label > [data-testid="cloud-todo-detail-start-date"])',
        { value: 'background-color' }
      )
    )
    assert.ok(
      (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5,
      'Date labels must remain readable inside their portalled surface'
    )
    await control.command('nativePress', '[data-testid="cloud-todo-detail-start-date"]', {
      key: 'Escape',
    })
    await control.command('waitFor', '[data-testid="cloud-todo-detail-start-date"]', {
      visible: false,
    })
    await control.command(
      'scrollToRatioAsUser',
      scope('[data-testid="cloud-todo-detail-scroll"]'),
      {
        value: '1',
      }
    )
    const action = scope('[data-testid="issue-persistent-task-action"]')
    await control.command('waitFor', action, { visible: true, stableMs: 300 })
    await verifyComposerVisible(control)
    for (const selector of [
      scope('[data-testid="cloud-task-activity-composer"]'),
      scope('[data-testid="cloud-todo-detail-title"]'),
      scope('[data-testid="issue-reply-cancel"]'),
    ]) {
      const [target] = JSON.parse(await control.command('getElementMetrics', selector))
      assert.ok(
        target.width >= 44 && target.height >= 44,
        `Narrow input and reply targets must remain at least 44px: ${JSON.stringify(target)}`
      )
    }
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
      `At least half the constrained discussion viewport must remain available for reading: ${JSON.stringify({ scroll, reply })}`
    )
    const composer = scope('[data-testid="cloud-task-activity-composer"]')
    await control.command('fill', composer, {
      value: Array.from({ length: 8 }, (_, index) => `未发送草稿 ${index + 1}`).join('\n'),
    })
    const draftMetrics = JSON.parse(
      await control.command(
        'getElementMetrics',
        [
          scope('[data-testid="cloud-todo-detail-scroll"]'),
          scope('[data-testid="task-comment-form"]'),
        ].join(', '),
        { value: 'includeText' }
      )
    )
    const draftViewport = draftMetrics.find(row => row.testId === 'cloud-todo-detail-scroll')
    const draftForm = draftMetrics.find(row => row.testId === 'task-comment-form')
    assert.ok(
      draftViewport && draftForm,
      `Missing identified draft geometry: ${JSON.stringify(draftMetrics)}`
    )
    assert.ok(
      draftViewport.height - draftForm.height - 16 >= draftViewport.height / 2,
      `Long drafts must preserve the reading budget: ${JSON.stringify(draftMetrics)}`
    )
    await control.command(
      'nativePress',
      replySelector.replace('cloud-task-activity-reply-toggle-', 'issue-comment-create-child-'),
      { key: 'Tab' }
    )
    await control.command('waitFor', `${replySelector}:focus`, { visible: true, stableMs: 300 })
    const [focusedReply] = JSON.parse(await control.command('getElementMetrics', replySelector))
    assert.ok(focusedReply.width >= 44 && focusedReply.height >= 44)
    const [participant] = JSON.parse(
      await control.command(
        'getElementMetrics',
        scope('[data-testid="cloud-todo-add-collaborator"]')
      )
    )
    assert.ok(participant.width >= 44 && participant.height >= 44)
    const tools = JSON.parse(
      await control.command('getElementMetrics', scope('.task-detail-new-comment-actions > button'))
    )
    assert.ok(tools.length > 0, 'The composer must expose its tool actions')
    for (const tool of tools) {
      assert.ok(
        tool.width >= 44 && tool.height >= 44,
        `Narrow composer actions must remain at least 44px: ${JSON.stringify(tool)}`
      )
    }
    assert.equal(
      focusedReply.hitTestVisible,
      true,
      'The focused reply must not be covered by the long draft composer'
    )
    assert.ok(focusedReply.visibleIntersection?.height >= focusedReply.height - 1)
    await captureScreenshot(control, 'issue-detail-reading-03-constrained.png')
    await control.command('fill', composer, { value: '' })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previous) })
  }
}

async function verifyTouchTargets(control, selector) {
  const targets = JSON.parse(await control.command('getElementMetrics', selector))
  assert.ok(targets.length > 0, `Expected touch targets: ${selector}`)
  for (const target of targets) {
    assert.ok(
      target.width >= 44 && target.height >= 44,
      `Mobile targets must be at least 44px: ${JSON.stringify(target)}`
    )
  }
}

async function verifyNarrowProperties(control) {
  const more = scope('[data-testid="cloud-todo-more-properties"]')
  const priority = scope('[data-testid="cloud-todo-detail-priority"]')
  await control.command('scrollIntoViewAsUser', more)
  await control.command('click', more)
  await control.command('scrollIntoViewAsUser', priority)
  await control.command('waitFor', `${priority}:enabled`, { visible: true })
  await verifyTouchTargets(control, priority)
  await control.command('scrollIntoViewAsUser', more)
  await control.command('click', more)
  const add = scope('[data-testid="cloud-todo-add-collaborator"]')
  await control.command('scrollIntoViewAsUser', add)
  await control.command('waitFor', add + ':disabled', { visible: true })
  await verifyTouchTargets(control, add)
  const availability = scope('[data-testid="issue-collaborators-unavailable"]')
  await control.command('waitFor', availability, {
    text: '此项目暂不支持编辑参与者',
    visible: true,
  })
  assert.equal(
    await control.command('getAttribute', add, { value: 'aria-describedby' }),
    await control.command('getAttribute', availability, { value: 'id' })
  )
  await control.command('waitFor', scope('[data-testid="cloud-todo-collaborator-select"]'), {
    visible: false,
  })
}

async function verifyTallReplyReading(
  control,
  { attachment, composer, replySelector, captureScreenshot }
) {
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 720, height: 450 }),
  })
  const footer = scope('.task-detail-comment-bar')
  const draft = Array.from({ length: 8 }, (_, index) => `保留长回复草稿 ${index + 1}`).join('\n')
  try {
    await control.command('fill', composer, { value: draft })
    await control.command('waitFor', `${footer}[data-oversized="true"]`)
    assert.equal(
      await control.command('getComputedStyleValue', footer, { value: 'position' }),
      'static'
    )
    const card = replySelector.replace(
      'cloud-task-activity-reply-toggle-',
      'cloud-task-activity-card-'
    )
    await control.command('scrollIntoViewAsUser', card)
    const [discussion] = JSON.parse(await control.command('getElementMetrics', card))
    assert.ok(
      discussion.hitTestVisible && discussion.visibleIntersection?.height >= discussion.height - 1,
      `An oversized composer must allow the original discussion to be fully read: ${JSON.stringify(discussion)}`
    )
    await captureScreenshot(control, 'issue-detail-reading-06-tall-reply-discussion.png')
    await control.command('scrollIntoViewAsUser', footer)
    await verifyComposerVisible(control)
    await control.command('waitFor', composer, { visible: true })
    assert.equal(
      await control.command('getValue', composer),
      draft,
      'Returning to the composer must preserve every draft line'
    )
    await captureScreenshot(control, 'issue-detail-reading-07-tall-reply-controls.png')
    await control.command('click', `${attachment} [data-testid="remove-attachment-button"]`)
    await control.command('waitFor', attachment, { visible: false })
    await control.command('waitFor', `${footer}[data-oversized="false"]`)
    assert.equal(
      await control.command('getComputedStyleValue', footer, { value: 'position' }),
      'sticky'
    )
    assert.equal(
      await control.command('getValue', composer),
      draft,
      'Removing the attachment must preserve every draft line'
    )
    await verifyComposerVisible(control)
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
}

async function setIssueUIFontSize(control, issueId, size) {
  await control.command('click', scope('[data-testid="settings-button"]'))
  await control.command('waitFor', '[data-testid="settings-menu-button"]', { visible: true })
  await control.command('click', '[data-testid="settings-menu-button"]')
  const back = scope('[data-testid="settings-back-button"]')
  await control.command('waitFor', back, { visible: true })
  await control.command('click', scope('[data-testid="settings-nav-appearance"]'))
  const input = scope('[data-testid="appearance-ui-font-size-input"]')
  await control.command('scrollIntoViewAsUser', input)
  await control.command('waitFor', input, { visible: true })
  await control.command('fill', input, { value: String(size) })
  await control.command('nativePress', input, { key: 'Enter' })
  await control.command('click', back)
  const detail = scope('[data-testid="cloud-todo-detail"]')
  const metrics = JSON.parse(await control.command('getElementMetrics', detail))
  if (!metrics.some(row => row.visibleIntersection)) {
    const card = scope(`[data-testid="cloud-todo-card-${issueId}"]`)
    await control.command('waitFor', card, { visible: true })
    await control.command('click', card)
  }
  await control.command('waitFor', detail, { visible: true })
  const title = scope('[data-testid="cloud-todo-detail-title"]')
  assert.equal(
    await control.command('getComputedStyleValue', title, { value: '--text-base' }),
    `${size}px`
  )
}

async function verifyIssueTypography(control, issueId, captureScreenshot) {
  const previous = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1280, height: 900 }),
  })
  const title = scope('[data-testid="cloud-todo-detail-title"]')
  const body = scope('[data-testid="cloud-todo-detail-description"]')
  try {
    await setIssueUIFontSize(control, issueId, 16)
    for (const [selector, token] of [
      [title, '--text-heading-lg'],
      [body, '--text-base'],
    ]) {
      assert.equal(
        await control.command('getComputedStyleValue', selector, { value: 'font-size' }),
        await control.command('getComputedStyleValue', selector, { value: token }),
        'Issue typography must follow the actual appearance settings'
      )
    }
    assert.equal(
      await control.command('getComputedStyleValue', title, { value: 'font-weight' }),
      '500'
    )
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 480, height: 760 }),
    })
    await control.command('scrollIntoViewAsUser', title)
    const [geometry] = JSON.parse(await control.command('getElementMetrics', title))
    assert.ok(
      geometry.scrollHeight <= geometry.clientHeight + 1,
      `Scaled titles must remain fully visible: ${JSON.stringify(geometry)}`
    )
    await captureScreenshot(control, 'issue-detail-reading-08-large-typography.png')
  } finally {
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1280, height: 900 }),
    })
    await setIssueUIFontSize(control, issueId, 14)
    await control.command('setMainWindowSize', 'body', { value: previous })
  }
}

async function verifyStagedPreview(control, attachment, filename, captureScreenshot) {
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 480, height: 760 }),
  })
  try {
    await verifyTouchTargets(control, `${attachment} [data-testid="remove-attachment-button"]`)
    assert.equal(
      await control.command(
        'getAttribute',
        `${attachment} [data-testid="remove-attachment-button"]`,
        { value: 'aria-label' }
      ),
      '移除附件'
    )
    await control.command(
      'click',
      `${attachment} [data-testid="attachment-document-preview-button"]`
    )
    const preview = '[data-testid="cloud-file-preview-dialog"]'
    await control.command('waitFor', preview, { text: filename, visible: true })
    await control.command('waitFor', '[data-testid="cloud-file-preview-text"]', {
      text: 'Issue reply route regression',
      visible: true,
    })
    await verifyTouchTargets(
      control,
      '[data-testid="cloud-file-preview-close"], [data-testid="cloud-file-preview-download"]'
    )
    await captureScreenshot(control, 'issue-detail-reading-05-staged-attachment-preview.png')
    await control.command('nativePress', '[data-testid="cloud-file-preview-close"]', {
      key: 'Escape',
    })
    await control.command('waitFor', preview, { visible: false })
    await control.command('waitFor', attachment, { text: filename, visible: true })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
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
  const moreProperties = scope('[data-testid="cloud-todo-more-properties"]')
  const parent = scope('[data-testid="cloud-todo-detail-parent"]')
  await control.command('waitFor', parent, { visible: false })
  await control.command('click', moreProperties)
  await control.command('nativePress', parent, { key: 'Enter' })
  const parentSearch = '[data-testid="cloud-todo-detail-parent-search"]'
  await control.command('waitFor', `${parentSearch}:focus`, { visible: true })
  await control.command('nativePress', parentSearch, { key: 'Escape' })
  await control.command('waitFor', `${parent}:focus`, { visible: true })
  await control.command('click', moreProperties)
  await control.command('waitFor', parent, { visible: false })
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
  await control.command('fill', title, { value: '' })
  await control.command('press', title, { key: 'Enter' })
  const titleError = scope('[data-testid="issue-title-error"]')
  await control.command('waitFor', titleError, { text: '请输入事项标题', visible: true })
  assert.equal(await control.command('getAttribute', title, { value: 'aria-invalid' }), 'true')
  assert.equal(
    await control.command('getAttribute', title, { value: 'aria-describedby' }),
    await control.command('getAttribute', titleError, { value: 'id' })
  )
  await control.command('fill', title, { value: `${TITLE}已更新` })
  await control.command('waitFor', titleError, { visible: false })
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
  // Expand the description so the title can leave even a tall desktop viewport.
  await control.command('clickWhenEnabled', toggle)
  await control.command('waitFor', `${toggle}[aria-expanded="true"]`)
  await control.command('scrollIntoViewAsUser', replySelector, { value: 'start' })
  await control.command('waitFor', scope('[data-testid="issue-header-context"]'), {
    text: `${TITLE}已更新`,
    visible: true,
  })
  await control.command('clickWhenEnabled', toggle)
  await control.command('waitFor', `${toggle}[aria-expanded="false"]`)
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
  await verifyConstrainedDiscussion(control, captureScreenshot, replySelector)
  const routeDraft = '设置往返后保留这段回复草稿。'
  await control.command('fill', composer, { value: routeDraft })
  const attachment = scope('[data-testid="task-comment-form"] [data-testid="attachment-badge"]')
  const filename = 'issue-reply-route-draft.txt'
  await control.command('pasteFile', composer, {
    filename,
    mimeType: 'text/plain',
    value: Buffer.from('Issue reply route regression').toString('base64'),
  })
  await control.command('waitFor', attachment, { text: filename, visible: true })
  await control.command('waitFor', scope('[data-testid="uploading-attachment-badge"]'), {
    visible: false,
  })
  const activityId = await control.command('getAttribute', scope('.task-detail-comments'), {
    value: 'data-testid',
  })
  const issueId = activityId.replace('cloud-task-activity-', '')
  await control.command('click', scope('[data-testid="settings-button"]'))
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('waitFor', scope('[data-testid="settings-back-button"]'), { visible: true })
  await control.command('click', scope('[data-testid="settings-back-button"]'))
  const details = JSON.parse(await control.command('getElementMetrics', detail))
  if (!details.some(row => row.visibleIntersection)) {
    const card = scope(`[data-testid="cloud-todo-card-${issueId}"]`)
    await control.command('waitFor', card, { visible: true })
    await control.command('click', card)
  }
  await control.command('waitFor', composer, { text: routeDraft, visible: true })
  await control.command('waitFor', replyComposer, { text: '继续此讨论', visible: true })
  await control.command('waitFor', attachment, { text: filename, visible: true })
  assert.ok((await control.command('getText', replyComposer)).includes(body))
  await captureScreenshot(control, 'issue-detail-reading-04-restored-reply-draft.png')
  await verifyStagedPreview(control, attachment, filename, captureScreenshot)
  await verifyTallReplyReading(control, { attachment, composer, replySelector, captureScreenshot })
  await control.command('fill', composer, { value: '' })
  await control.command('click', scope('[data-testid="issue-reply-cancel"]'))
  const [beforeExpansion] = JSON.parse(await control.command('getElementMetrics', detail))
  const expand = scope('[data-testid="cloud-todo-detail-fullscreen"]')
  await control.command('click', expand)
  await control.command('waitFor', scope('.task-detail-workspace-panel-shell.is-expanded'), {
    visible: true,
    stableMs: 300,
  })
  const [expanded] = JSON.parse(await control.command('getElementMetrics', detail))
  assert.ok(
    expanded.width >= beforeExpansion.width,
    `Expanding details must not shrink the reading column: ${JSON.stringify({ beforeExpansion, expanded })}`
  )
  await control.command('click', expand)
  await verifyIssueTypography(control, issueId, captureScreenshot)
}
