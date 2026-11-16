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
  await control.command('nativePress', `${home} [data-testid="personal-home-new-issue"]`, {
    key: 'Home',
  })
  await control.command(
    'waitFor',
    `${home} [data-testid="personal-home-record-mode"][aria-selected="true"]`
  )
}

/** Reuse the home checkpoint's real Issue and conversation; no additional model turn. */
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
    await verifyTaskLabels(control, home)
    await resizeHome(control, home, 1100, 800, timeoutMs)
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
    assert.equal(
      await control.command('getValue', input),
      draft,
      'Inspecting an Issue must retain the assistant draft'
    )
  } finally {
    await resizeHome(control, home, initial.viewportWidth, initial.viewportHeight, timeoutMs)
  }
}
