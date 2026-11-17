import assert from 'node:assert/strict'
import { until } from './plugin-regression-fixture.mjs'
import { verifyComposerLayout } from './issue-comment-workflow.mjs'
import { setGoalDraftForTabTransfer } from './goal-draft-flows.mjs'
import { waitForElementInsideScroller } from './conversation-layout.mjs'
import { confirmProjectDraftDiscard } from './project-create-dialog-navigation.mjs'

async function resizeHome(control, home, width, height, timeoutMs) {
  await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width, height }),
  })
  await until(
    async () => JSON.parse(await control.command('getElementMetrics', home))[0],
    metrics => metrics?.viewportWidth === width && metrics.viewportHeight === height,
    'The collaboration viewport must reach the requested size',
    timeoutMs
  )
}

async function waitForNarrowIssue(control, home, timeoutMs) {
  await until(
    async () =>
      JSON.parse(
        await control.command(
          'getElementMetrics',
          `${home}, ${home} [data-testid="collaboration-issue-detail"]`
        )
      ),
    ([frame, detail]) =>
      frame &&
      detail?.visibleIntersection &&
      detail.top <= frame.top + 120 &&
      detail.visibleIntersection.height >= Math.min(300, detail.height),
    'The narrow Issue header and working area must be in view',
    timeoutMs
  )
}

async function verifyEnglishParticipantExplanation(control, home, issueId, timeoutMs) {
  const participating = await control.command(
    'getAttribute',
    `${home} [data-testid="personal-home-scope-participating"]`,
    { value: 'aria-pressed' }
  )
  const openSettings = async () => {
    await resizeHome(control, home, 1440, 900, timeoutMs)
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('waitFor', '[data-testid="general-language-en-button"]', {
      visible: true,
    })
  }
  const closeSettings = async () => {
    await control.command('click', '[data-testid="settings-back-button"]')
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    await control.command('waitFor', home, { visible: true })
  }
  await openSettings()
  const originalLanguage = await control.command(
    'getAttribute',
    '[data-testid^="general-language-"][aria-pressed="true"]',
    { value: 'data-testid' }
  )
  assert.match(originalLanguage, /^general-language-(system|zh-CN|en)-button$/)
  try {
    await control.command('clickWhenEnabled', '[data-testid="general-language-en-button"]')
    await control.command(
      'waitFor',
      '[data-testid="general-language-en-button"][aria-pressed="true"]:enabled'
    )
    await closeSettings()
    await control.command('click', `${home} [data-testid="personal-home-scope-participating"]`)
    await control.command(
      'clickWhenEnabled',
      `${home} [data-testid="personal-home-issue-${issueId}"]`
    )
    const explanation = `${home} [data-testid="issue-collaborators-unavailable"]`
    await control.command('waitFor', explanation, {
      text: 'Editing participants is not available for this project yet',
      visible: true,
    })
    for (const width of [1100, 390]) {
      await resizeHome(control, home, width, 900, timeoutMs)
      await control.command('scrollIntoViewAsUser', explanation)
      await waitForElementInsideScroller(
        control,
        explanation,
        `${home} [data-testid="cloud-todo-detail-scroll"]`,
        'The complete English participant explanation must remain readable at constrained widths',
        timeoutMs,
        { clipToViewport: true }
      )
    }
  } finally {
    await openSettings()
    await control.command('clickWhenEnabled', `[data-testid="${originalLanguage}"]`)
    await control.command(
      'waitFor',
      `[data-testid="${originalLanguage}"][aria-pressed="true"]:enabled`
    )
    await closeSettings()
    await control.command(
      'click',
      `${home} [data-testid="personal-home-scope-${participating === 'true' ? 'participating' : 'assigned'}"]`
    )
  }
}

async function verifyFocusedDraftResize(control, home, taskInput) {
  const draft = await control.command('getValue', taskInput)
  const longDraft = Array.from(
    { length: 40 },
    (_, index) => `尚未发送的长草稿 ${index + 1}：缩小窗口后继续从这里编辑，保留全部内容。`
  ).join('\n')
  const previous = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1100, height: 900 }),
  })
  try {
    await control.command('fill', taskInput, { value: longDraft })
    await control.command('click', taskInput)
    await control.command('setSelectionOffset', taskInput, {
      value: String(longDraft.replaceAll('\n', '').length),
    })
    for (const [width, height] of [
      [1000, 600],
      [390, 480],
    ]) {
      await resizeHome(control, home, width, height, 10000)
      await until(
        async () =>
          JSON.parse(
            await control.command('getElementMetrics', taskInput, {
              value: JSON.stringify({ includeSelection: true }),
            })
          )[0],
        metrics =>
          metrics?.selection?.hitTestVisible &&
          metrics.selection.visibleIntersection?.height >= metrics.selection.height - 1,
        'The focused caret must remain visible after resizing without further typing or focus',
        10000
      )
      await control.command('waitFor', `${taskInput}:focus`)
      assert.equal(await control.command('getValue', taskInput), longDraft)
    }
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previous })
    await control.command('fill', taskInput, { value: draft })
  }
}

async function verifyTaskLabels(control, home) {
  const participating = await control.command(
    'getAttribute',
    `${home} [data-testid="personal-home-scope-participating"]`,
    { value: 'aria-pressed' }
  )
  await control.command('nativePress', `${home} [data-testid="personal-home-record-mode"]`, {
    key: 'ArrowRight',
  })
  await control.command(
    'waitFor',
    `${home} [data-testid="personal-home-new-issue"][aria-selected="true"]`
  )
  await control.command('waitFor', `${home} [data-testid="personal-home-task-content"]`)
  const panel = `${home} [role="tabpanel"][aria-labelledby$="-task-tab"]:not([inert])`
  assert.match(
    await control.command('getText', `${panel} [data-testid="project-work-button"]`),
    /代码工作区|Code workspace/,
    'The execution directory must be distinguished from the collaboration project'
  )
  assert.match(
    await control.command(
      'getText',
      `${panel} [data-testid="collaboration-issue-project-trigger"]`
    ),
    /协作项目|Collaboration project/,
    'The Issue storage project must have its own visible label'
  )
  const taskInput = `${panel} [data-testid="personal-home-task-content"]`
  const draft = await control.command('getValue', taskInput)
  await verifyFocusedDraftResize(control, home, taskInput)
  const projectLabel = await control.command(
    'getAttribute',
    `${panel} [data-testid="collaboration-issue-project-trigger"]`,
    { value: 'aria-label' }
  )
  await control.command('click', `${panel} [data-testid="project-work-button"]`)
  await control.command(
    'click',
    '[data-testid="project-work-menu"] [data-testid="no-project-option"]',
    { visible: true }
  )
  await control.command(
    'waitFor',
    `${home} [data-testid="personal-home-new-issue"][aria-selected="true"]`
  )
  assert.equal(
    await control.command('getValue', taskInput),
    draft,
    'Clearing an optional code workspace must retain the collaboration composer and draft'
  )
  const goal = `${panel} [data-testid="goal-draft-pill"]`
  const existingGoal = JSON.parse(await control.command('getElementMetrics', goal)).length > 0
  if (!existingGoal) {
    await control.command('click', `${panel} [data-testid="add-context-button"]`)
    const [row, description] = JSON.parse(
      await control.command(
        'getElementMetrics',
        '[data-testid="set-goal-button"], [data-testid="goal-mode-description"]'
      )
    )
    assert.ok(
      description.left >= row.left &&
        description.right <= row.right &&
        description.bottom <= row.bottom,
      'The complete goal description must fit inside its menu item'
    )
    await control.command('click', `${panel} [data-testid="add-context-button"]`)
    await setGoalDraftForTabTransfer(control, panel)
  }
  const goalText = 'Keep pursuing this goal after opening global settings.'
  await control.command('fill', taskInput, { value: goalText })
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('click', `${home} [data-testid="personal-home-new-issue"]`)
  await control.command('waitFor', goal, { visible: true })
  assert.equal(
    await control.command('getValue', taskInput),
    goalText,
    'Global settings must retain the goal text'
  )
  assert.equal(
    await control.command(
      'getAttribute',
      `${panel} [data-testid="collaboration-issue-project-trigger"]`,
      { value: 'aria-label' }
    ),
    projectLabel
  )
  if (!existingGoal)
    await control.command('click', `${panel} [data-testid="cancel-goal-draft-button"]`)
  await control.command('fill', taskInput, { value: draft })
  if (participating === 'true')
    await control.command('click', `${home} [data-testid="personal-home-scope-participating"]`)
  await control.command('nativePress', `${home} [data-testid="personal-home-new-issue"]`, {
    key: 'ArrowLeft',
  })
  await control.command(
    'waitFor',
    `${home} [data-testid="personal-home-record-mode"][aria-selected="true"]`
  )
}

async function verifyOwnerKeyboardFocus(control, home) {
  await control.command('click', `${home} [data-testid="collaboration-issue-owner"]`)
  const menu = '[data-testid="collaboration-issue-owner-menu"]'
  const search = '[data-testid="collaboration-issue-owner-search"]'
  await control.command('waitFor', search, { visible: true })
  await control.command('nativePress', search, { key: 'Tab' })
  const unassigned = '[data-testid="collaboration-issue-owner-none"]'
  await control.command('waitFor', `${unassigned}:focus`, { visible: true })
  assert.notEqual(
    await control.command('getComputedStyleValue', unassigned, { value: 'box-shadow' }),
    'none',
    'Keyboard focus needs a visible indicator beyond the selected or hovered background'
  )
  await control.command('nativePress', unassigned, { key: 'Escape' })
  await control.command('waitFor', menu, { visible: false })
}

async function verifyAssistantSetupTouchTarget(control, home) {
  await control.command('click', `${home} [data-testid="personal-home-tab-stand-in"]`)
  const toggle = `${home} [data-testid="personal-home-assistant-view-toggle"]`
  await control.command('scrollIntoViewAsUser', toggle)
  await control.command('click', toggle)
  const connect = `${home} [data-testid="personal-home-setup-assistant"]`
  await control.command('scrollIntoViewAsUser', connect)
  await control.command('waitFor', connect, { visible: true })
  const [target] = JSON.parse(await control.command('getElementMetrics', connect))
  assert.ok(
    target.width >= 44 && target.height >= 44 && target.hitTestVisible,
    'The mobile assistant connection action must provide a visible 44px touch target'
  )
  await control.command('scrollIntoViewAsUser', toggle)
  await control.command('click', toggle)
}

async function verifyRecordDraftNavigation(control, home) {
  const record = `${home} [data-testid="collaboration-home-issue-content"]`
  const previous = await control.command('getValue', record)
  const participating = await control.command(
    'getAttribute',
    `${home} [data-testid="personal-home-scope-participating"]`,
    { value: 'aria-pressed' }
  )
  const project = `${home} [data-testid="collaboration-issue-project-trigger"]`
  const target = await control.command('getAttribute', project, { value: 'aria-label' })
  const draft = 'Preserve this unfinished issue across global settings navigation.'
  await control.command('fill', record, { value: draft })
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('waitFor', record, { visible: true })
  if (participating === 'true') {
    await control.command('click', `${home} [data-testid="personal-home-scope-participating"]`)
  }
  assert.equal(
    await control.command('getValue', record),
    draft,
    'An unfinished Issue must survive opening and leaving global settings'
  )
  assert.equal(
    await control.command('getAttribute', project, { value: 'aria-label' }),
    target,
    'Global settings must preserve the target collaboration project alongside its draft'
  )
  for (const selector of [
    record,
    `${home} [data-testid="personal-home-general-chat"] [data-testid="chat-message-input"]`,
  ]) {
    assert.ok(
      (await control.command('getAttribute', selector, { value: 'aria-label' }))?.trim(),
      'Each core collaboration input must have a localized accessible name'
    )
  }
  await control.command('fill', record, { value: previous })
}

async function verifyProjectDialogKeyboard(control, home, timeoutMs) {
  const participating = await control.command(
    'getAttribute',
    `${home} [data-testid="personal-home-scope-participating"]`,
    { value: 'aria-pressed' }
  )
  await control.command('click', `${home} [data-testid="personal-home-tab-stand-in"]`)
  const assistant = `${home} [data-testid="right-workspace-chat-composer-shell"]`
  await control.command('waitFor', assistant, { visible: true })
  const before = JSON.parse(await control.command('getElementMetrics', assistant))
  assert.ok(before.length > 0 && before.some(item => item.hitTestVisible))
  const actions = '[data-testid="collaboration-workspace-actions-wework-local-workspace"]'
  await control.command(
    'hover',
    '[data-testid="collaboration-workspace-tree-wework-local-workspace"]'
  )
  await control.command('click', actions)
  await control.command(
    'clickWhenEnabled',
    '[data-testid="collaboration-workspace-nav-create-project"]'
  )
  const homeDialog = '[data-testid="collaboration-project-create-dialog"]'
  await control.command('waitFor', homeDialog, { visible: true })
  const covered = JSON.parse(await control.command('getElementMetrics', assistant))
  assert.equal(covered.length, before.length, 'The modal must retain the background Home composer')
  assert.ok(
    covered.every(item => !item.hitTestVisible),
    'The project modal must cover every background assistant composer'
  )
  await control.command('click', `${homeDialog} [data-testid="collaboration-project-create-close"]`)
  await control.command('waitFor', homeDialog, { visible: false })
  await control.command('waitFor', home, { visible: true })
  const trigger = '[data-testid="collaboration-workspace-project-create"]'
  const dialog = '[data-testid="collaboration-project-create-dialog"]'
  await control.command(
    'click',
    '[data-testid="collaboration-workspace-home-wework-local-workspace"]'
  )
  await control.command('click', trigger)
  await control.command('click', '[data-testid="collaboration-workspace-project-create-blank"]')
  await control.command('waitFor', dialog, { visible: true })
  await resizeHome(control, dialog, 390, 900, timeoutMs)
  for (const testId of [
    'collaboration-project-create-close',
    'collaboration-project-name-input',
    'project-create-choose-template',
    'collaboration-project-create-add-collaborator',
    'collaboration-project-create-advanced',
    'collaboration-project-create-cancel',
  ]) {
    const [target] = JSON.parse(
      await control.command('getElementMetrics', `${dialog} [data-testid="${testId}"]`)
    )
    assert.ok(
      target.width >= 44 && target.height >= 44,
      `${testId} must provide a mobile touch target`
    )
  }
  const titleId = await control.command('getAttribute', dialog, { value: 'aria-labelledby' })
  assert.ok(titleId?.trim(), 'The project modal must reference its visible title')
  const title = await control.command('getText', `${dialog} [id=${JSON.stringify(titleId)}]`)
  assert.ok(title.trim(), 'The project modal must expose a nonempty accessible name')
  assert.equal(title, await control.command('getText', `${dialog} h2`))
  for (let index = 0; index < 12; index += 1) {
    await control.command('nativePress', ':focus', { key: 'Tab' })
    const focused = await control.command('getActiveElementTestId', 'body')
    assert.ok(focused, 'Every project-dialog tab stop must remain identifiable')
    await control.command('waitFor', `${dialog} [data-testid="${focused}"]`)
  }
  const name = '[data-testid="collaboration-project-name-input"]'
  const projectDraft = 'Keep the project draft when leaving template previews'
  await control.command('fill', name, { value: projectDraft })
  await control.command('click', '[data-testid="project-create-choose-template"]')
  await control.command('click', '[data-testid="template-details-product-lifecycle"]')
  const preview = `${dialog} [data-testid="template-inline-detail"]`
  await control.command('waitFor', preview, { visible: true })
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await until(
    async () => JSON.parse(await control.command('getElementMetrics', preview)),
    metrics => metrics.length === 0,
    'Escape must close only the template preview',
    timeoutMs
  )
  await control.command('waitFor', `${dialog} [data-testid="template-search"]`, { visible: true })
  assert.equal(await control.command('getValue', name), projectDraft)
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await until(
    async () =>
      JSON.parse(
        await control.command(
          'getElementMetrics',
          '[data-testid="project-create-template-catalog"]'
        )
      ),
    metrics => metrics.length === 0,
    'A second Escape must close template discovery while retaining project creation',
    timeoutMs
  )
  assert.equal(await control.command('getValue', name), projectDraft)
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await confirmProjectDraftDiscard(control)
  await until(
    async () => JSON.parse(await control.command('getElementMetrics', dialog)),
    metrics => metrics.length === 0,
    'Escape must dismiss the project dialog',
    timeoutMs
  )
  await until(
    () => control.command('getActiveElementTestId', 'body'),
    testId => testId === 'collaboration-workspace-project-create',
    'Escape must close the project dialog and restore its creation-menu opener',
    timeoutMs
  )
  await resizeHome(control, 'body', 1440, 900, timeoutMs)
  await control.command('click', '[data-testid="collaboration-primary-home"]')
  await control.command('waitFor', home, { visible: true })
  if (participating === 'true') {
    await control.command('click', `${home} [data-testid="personal-home-scope-participating"]`)
  }
}

async function verifyCompactNavigation(control, home, timeoutMs) {
  const record = `${home} [data-testid="collaboration-home-issue-content"]`
  const previous = await control.command('getValue', record)
  const target = await control.command(
    'getAttribute',
    `${home} [data-testid="collaboration-issue-project-trigger"]`,
    { value: 'aria-label' }
  )
  const participating = await control.command(
    'getAttribute',
    `${home} [data-testid="personal-home-scope-participating"]`,
    { value: 'aria-pressed' }
  )
  const draft = 'Retain the Issue draft while using compact navigation.'
  await control.command('fill', record, { value: draft })
  const toggle = '[data-testid="collaboration-navigation-toggle"]'
  await control.command('waitFor', `${toggle}[aria-expanded="false"]`, { visible: true })
  const [navigation] = JSON.parse(
    await control.command('getElementMetrics', '[data-testid="collaboration-platform-sidebar"]')
  )
  assert.ok(
    navigation.height <= 52,
    'Collapsed navigation must leave the narrow viewport for content'
  )
  await control.command('click', toggle)
  await control.command('waitFor', `${toggle}[aria-expanded="true"]`)
  await control.command(
    'click',
    '[data-testid="collaboration-workspace-home-wework-local-workspace"]'
  )
  await control.command('waitFor', `${toggle}[aria-expanded="false"]`)
  await control.command('click', toggle)
  await control.command('click', '[data-testid="collaboration-primary-home"]')
  await control.command('waitFor', home, { visible: true })
  assert.equal(await control.command('getValue', record), draft)
  assert.equal(
    await control.command(
      'getAttribute',
      `${home} [data-testid="collaboration-issue-project-trigger"]`,
      { value: 'aria-label' }
    ),
    target
  )
  if (participating === 'true')
    await control.command('click', `${home} [data-testid="personal-home-scope-participating"]`)
  await control.command('fill', record, { value: previous })

  const strip = '[data-testid="workspace-tab-strip"]'
  const selected = `${strip} [role="tab"][aria-selected="true"]`
  const [viewport, active] = JSON.parse(
    await control.command('getElementMetrics', `${strip}, ${selected}`)
  )
  assert.ok(
    active.left >= viewport.left - 1 && active.right <= viewport.right + 1,
    `The selected workspace tab must remain fully visible in a narrow window: ${JSON.stringify({ viewport, active })}`
  )
  const current = await control.command('getAttribute', selected, { value: 'data-testid' })
  await control.command('nativePress', selected, { key: 'ArrowLeft' })
  assert.notEqual(await control.command('getActiveElementTestId', 'body'), current)
  assert.equal(
    await control.command('getAttribute', selected, { value: 'data-testid' }),
    current,
    'Arrow navigation must move focus without activating another workspace'
  )
  await control.command('nativePress', ':focus', { key: 'ArrowRight' })
  assert.equal(await control.command('getActiveElementTestId', 'body'), current)
}

async function verifyDiscussionReply(control, home) {
  const panel = `${home} [data-testid="personal-home-stand-in"] > [role="tabpanel"]:not([inert])`
  const activity = `${panel} [data-testid="cloud-task-activity-list"]`
  const editor = `${panel} [data-testid="cloud-task-activity-composer"]`
  const text = 'A local discussion about the release checklist.'
  await control.command('fill', editor, { value: text })
  const submit = `${panel} [data-testid="task-comment-form"] [data-testid="send-message-button"]:enabled`
  await control.command('waitFor', submit)
  await control.command('click', submit)
  await control.command('waitFor', activity, { text })
  await control.command('click', `${activity} [data-testid^="cloud-task-activity-reply-toggle-"]`)
  const reply = `${panel} [data-testid="issue-reply-composer"]`
  await control.command('waitFor', reply)
  const label = await control.command('getText', reply)
  assert.match(label, /继续此讨论|Continues this discussion/)
  assert.doesNotMatch(label, /原执行任务|existing execution/)
  assert.match(
    await control.command('getAttribute', `${reply} [data-testid="cloud-task-activity-composer"]`, {
      value: 'aria-label',
    }),
    /回复此讨论|Reply in this thread/
  )
  await control.command('click', `${reply} [data-testid="issue-reply-cancel"]`)
}

/** Reuse the checkpoint's real services; no additional model turn. */
export async function verifyCollaborationHomeUsability(
  control,
  { home, input, issueId, timeoutMs }
) {
  const [initial] = JSON.parse(await control.command('getElementMetrics', home))
  const draft = await control.command('getValue', input)
  const sidebarToggle = `${home} [data-testid="personal-home-toggle-sidebar"]`
  try {
    await resizeHome(control, home, 1440, 900, timeoutMs)
    await control.command('click', sidebarToggle)
    await control.command('waitFor', `${sidebarToggle}[aria-expanded="false"]`)
    assert.equal(
      await control.command(
        'getComputedStyleValue',
        `${home} [data-testid="personal-home-stand-in"]`,
        { value: 'display' }
      ),
      'none'
    )
    await control.command('click', sidebarToggle)
    await control.command('waitFor', input)
    assert.equal(
      await control.command('getValue', input),
      draft,
      'Sidebar restoration must retain the draft'
    )
    await verifyRecordDraftNavigation(control, home)
    await verifyOwnerKeyboardFocus(control, home)
    await verifyTaskLabels(control, home)
    await verifyProjectDialogKeyboard(control, home, timeoutMs)
    await resizeHome(control, home, 1100, 800, timeoutMs)
    const [frame] = JSON.parse(
      await control.command(
        'getElementMetrics',
        `${home} [data-testid="personal-home-items-region"]`
      )
    )
    const [submit] = JSON.parse(
      await control.command(
        'getElementMetrics',
        `${home} [data-testid="collaboration-home-create-issue"]`
      )
    )
    assert.ok(
      submit.left >= frame.left && submit.right <= frame.right,
      'The Issue submit action must stay inside its column'
    )
    await control.command('click', `${home} [data-testid="personal-home-issue-${issueId}"]`)
    const form = `${home} [data-testid="task-comment-form"]`
    await control.command('waitFor', form)
    await verifyComposerLayout(
      control,
      form,
      `${form} [data-testid="send-message-button"]`,
      `${form} [data-testid="task-comment-form-send-actions"]`
    )
    await control.command('click', `${home} [data-testid="personal-home-tab-stand-in"]`)
    await resizeHome(control, home, 768, 900, timeoutMs)
    await control.command('click', `${home} [data-testid="personal-home-issue-${issueId}"]`)
    await waitForNarrowIssue(control, home, timeoutMs)
    const selectedTab = `${home} [data-testid="personal-home-tabs"] [role="tab"][aria-selected="true"]`
    const detailTab = await control.command('getAttribute', selectedTab, { value: 'data-testid' })
    await control.command('nativePress', selectedTab, { key: 'ArrowLeft' })
    assert.equal(
      await control.command('getActiveElementTestId', 'body'),
      await control.command('getAttribute', selectedTab, { value: 'data-testid' }),
      'Changing workspace panels must keep keyboard focus on the selected tab'
    )
    await control.command('nativePress', ':focus', { key: 'ArrowRight' })
    assert.equal(await control.command('getActiveElementTestId', 'body'), detailTab)
    await control.command('click', `${home} [data-testid="personal-home-back-to-issues"]`)

    await resizeHome(control, home, 390, 900, timeoutMs)
    await verifyCompactNavigation(control, home, timeoutMs)
    await verifyAssistantSetupTouchTarget(control, home)
    for (const selector of [
      '[data-testid="workspace-tab-strip"] [role="tab"][aria-selected="true"]',
      '[data-testid="workspace-tab-add"]',
      '[data-testid="wework-notifications-button"]',
      '[data-testid="topnav-feedback-button"]',
    ]) {
      const [target] = JSON.parse(await control.command('getElementMetrics', selector))
      assert.ok(
        target?.width >= 44 && target?.height >= 44,
        `Narrow titlebar control must provide a 44px target: ${selector}`
      )
    }
    const record = `${home} [data-testid="collaboration-home-issue-content"]`
    const savedRecord = await control.command('getValue', record)
    const narrowIssue = 'Narrow creation reveals the resulting Issue'
    await control.command('fill', record, {
      value: `# ${narrowIssue}\n\nCheck directional navigation, filters, and empty-state recovery.`,
    })
    await control.command('click', `${home} [data-testid="collaboration-home-create-issue"]`)
    await control.command('waitFor', `${home} [data-testid="cloud-todo-detail-title"]`, {
      text: narrowIssue,
    })
    assert.equal(
      await control.command('getText', `${home} [data-testid="cloud-todo-detail-title"]`),
      narrowIssue,
      'The Issue title must use its first semantic Markdown line, preserving the body separately'
    )
    await waitForNarrowIssue(control, home, timeoutMs)
    const description = `${home} .task-detail-workspace-description`
    const [preview, paragraph] = JSON.parse(
      await control.command(
        'getElementMetrics',
        `${description} .bn-editor, ${description} .bn-editor [data-content-type="paragraph"] .bn-inline-content`
      )
    )
    const lineHeight = Number.parseFloat(
      await control.command(
        'getComputedStyleValue',
        `${description} .bn-editor [data-content-type="paragraph"] .bn-inline-content`,
        { value: 'line-height' }
      )
    )
    assert.ok(
      paragraph.top >= preview.top && paragraph.top + lineHeight <= preview.bottom + 1,
      'The collapsed Markdown description must show a complete line of useful body text'
    )
    const descriptionToggle = `${home} [data-testid="issue-description-toggle"]`
    await control.command('waitFor', `${descriptionToggle}[aria-expanded="false"]`)
    const controlled = await control.command('getAttribute', descriptionToggle, {
      value: 'aria-controls',
    })
    assert.ok(controlled, 'The description disclosure must identify the controlled content')
    await control.command('click', descriptionToggle)
    await control.command('waitFor', `${descriptionToggle}[aria-expanded="true"]`)
    const [heading] = JSON.parse(await control.command('getElementMetrics', `${description} h1`))
    assert.ok(
      heading.width > 0 && heading.height > 0,
      'Expanding must reveal the original Markdown heading'
    )
    await control.command('click', descriptionToggle)
    await control.command('waitFor', `${descriptionToggle}[aria-expanded="false"]`)
    await verifyDiscussionReply(control, home)
    await control.command('click', `${home} [data-testid="personal-home-back-to-issues"]`)
    await control.command('fill', record, { value: savedRecord })
    await control.command('click', record)
    for (const width of [1100, 390]) {
      await resizeHome(control, home, width, 900, timeoutMs)
      assert.equal(
        await control.command('getActiveElementTestId', 'body'),
        'collaboration-home-issue-content',
        'A completed return request must not steal composer focus after resizing'
      )
    }

    assert.equal(
      await control.command('getValue', input),
      draft,
      'Inspecting an Issue must retain the assistant draft'
    )
    await verifyEnglishParticipantExplanation(control, home, issueId, timeoutMs)
  } finally {
    await resizeHome(control, 'body', initial.viewportWidth, initial.viewportHeight, timeoutMs)
  }
}
