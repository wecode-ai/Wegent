import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export async function selectCollaborationProjectView(
  control,
  contentSelector,
  view,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const compact = `${contentSelector} [data-testid="collaboration-project-view-select"]`
  if (Number(await control.command('getElementCount', compact)) > 0) {
    await control.command('waitFor', compact, { visible: true, enabled: true, timeoutMs })
    await control.command('select', compact, { value: view })
  } else {
    const tabId = view === 'gantt' ? 'collaboration-gantt-tab' : `collaboration-tab-${view}`
    await control.command('clickWhenEnabled', `${contentSelector} [data-testid="${tabId}"]`, {
      visible: true,
      timeoutMs,
    })
  }
}

export async function waitForLocalProjectNavigation(
  control,
  contentSelector,
  projectName,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const title = `${contentSelector} [data-testid="cloud-project-header-title"]`
  await control.command('waitFor', title, { text: projectName, timeoutMs })
  const compact = `${contentSelector} [data-testid="collaboration-project-view-select"]`
  if (Number(await control.command('getElementCount', compact)) > 0) {
    // Compact headers hide the title; the selected, visible sidebar row owns project identity.
    await control.command(
      'waitFor',
      `${contentSelector} [data-testid="collaboration-platform-sidebar"] [data-testid^="collaboration-workspace-project-"][aria-current="page"]`,
      { text: projectName, visible: true, timeoutMs }
    )
  } else {
    await control.command('waitFor', title, { text: projectName, visible: true, timeoutMs })
  }
  await selectCollaborationProjectView(control, contentSelector, 'board', timeoutMs)
  await control.command('waitFor', `${contentSelector} [data-testid="collaboration-board"]`, {
    visible: true,
    timeoutMs,
  })
}
