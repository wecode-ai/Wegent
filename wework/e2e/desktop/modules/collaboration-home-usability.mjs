import assert from 'node:assert/strict'
import { until } from './plugin-regression-fixture.mjs'
import { verifyComposerLayout } from './issue-comment-workflow.mjs'

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

async function verifyTaskLabels(control, home) {
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
  await control.command('nativePress', `${home} [data-testid="personal-home-new-issue"]`, {
    key: 'ArrowLeft',
  })
  await control.command(
    'waitFor',
    `${home} [data-testid="personal-home-record-mode"][aria-selected="true"]`
  )
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
  const trigger = '[data-testid="collaboration-workspace-project-create"]'
  const dialog = '[data-testid="collaboration-project-create-dialog"]'
  await control.command(
    'click',
    '[data-testid="collaboration-workspace-home-wework-local-workspace"]'
  )
  await control.command('click', trigger)
  await control.command('click', '[data-testid="collaboration-workspace-project-create-blank"]')
  await control.command('waitFor', dialog, { visible: true })
  assert.ok(
    (await control.command('getAttribute', dialog, { value: 'aria-label' }))?.trim(),
    'The project modal must expose its visible title as an accessible name'
  )
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
  await control.command('waitFor', '[data-testid="template-detail-cancel"]', { visible: true })
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await until(
    async () =>
      JSON.parse(
        await control.command('getElementMetrics', '[data-testid="template-detail-cancel"]')
      ),
    metrics => metrics.length === 0,
    'Escape must close only the template preview',
    timeoutMs
  )
  assert.equal(await control.command('getValue', name), projectDraft)
  await control.command('nativePress', ':focus', { key: 'Escape' })
  await until(
    async () => JSON.parse(await control.command('getElementMetrics', 'dialog[open]')),
    metrics => metrics.length === 0,
    'A second Escape must close template discovery while retaining project creation',
    timeoutMs
  )
  assert.equal(await control.command('getValue', name), projectDraft)
  await control.command('nativePress', ':focus', { key: 'Escape' })
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
  await control.command('click', '[data-testid="collaboration-primary-home"]')
  await control.command('waitFor', home, { visible: true })
  if (participating === 'true') {
    await control.command('click', `${home} [data-testid="personal-home-scope-participating"]`)
  }
}

/** Reuse the checkpoint's real services; no additional model turn. */
export async function verifyCollaborationHomeUsability(
  control,
  { home, input, issueId, timeoutMs }
) {
  const [initial] = JSON.parse(await control.command('getElementMetrics', home))
  const draft = await control.command('getValue', input)
  const toggle = `${home} [data-testid="personal-home-toggle-sidebar"]`
  try {
    await resizeHome(control, home, 1440, 900, timeoutMs)
    await control.command('click', toggle)
    await control.command('waitFor', `${toggle}[aria-expanded="false"]`)
    assert.equal(
      await control.command(
        'getComputedStyleValue',
        `${home} [data-testid="personal-home-stand-in"]`,
        { value: 'display' }
      ),
      'none'
    )
    await control.command('click', toggle)
    await control.command('waitFor', input)
    assert.equal(
      await control.command('getValue', input),
      draft,
      'Sidebar restoration must retain the draft'
    )
    await verifyRecordDraftNavigation(control, home)
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
    await control.command('click', `${home} [data-testid="personal-home-back-to-issues"]`)

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
    await control.command('click', `${home} [data-testid="personal-home-back-to-issues"]`)
    await control.command('fill', record, { value: savedRecord })

    assert.equal(
      await control.command('getValue', input),
      draft,
      'Inspecting an Issue must retain the assistant draft'
    )
  } finally {
    await resizeHome(control, home, initial.viewportWidth, initial.viewportHeight, timeoutMs)
  }
}
