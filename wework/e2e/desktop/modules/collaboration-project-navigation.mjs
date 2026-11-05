import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export async function selectCollaborationProjectView(
  control,
  contentSelector,
  view,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const compact = `${contentSelector} [data-testid="collaboration-project-view-select"]`
  const tabId = view === 'gantt' ? 'collaboration-gantt-tab' : `collaboration-tab-${view}`
  // ResizeObserver can replace the navigation between controller round trips.
  await control.command(
    'selectOrClick',
    `${compact}, ${contentSelector} [data-testid="${tabId}"]`,
    {
      value: view,
      visible: true,
      timeoutMs,
    }
  )
}

export async function waitForLocalProjectNavigation(
  control,
  contentSelector,
  projectName,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const title = `${contentSelector} [data-testid="cloud-project-header-title"]`
  await control.command('waitFor', title, { text: projectName, timeoutMs })
  // Keep identity and its visibility bound to the layout at each renderer observation.
  const compact = ':has([data-testid="collaboration-project-view-select"])'
  const wideTitle = `${contentSelector}:not(${compact}) [data-testid="cloud-project-header-title"]`
  const selectedProject = `${contentSelector}${compact} [data-testid="collaboration-platform-sidebar"] [data-testid^="collaboration-workspace-project-"][aria-current="page"]`
  await control.command('waitFor', `${wideTitle}, ${selectedProject}`, {
    text: projectName,
    visible: true,
    timeoutMs,
  })
  await selectCollaborationProjectView(control, contentSelector, 'board', timeoutMs)
  await control.command('waitFor', `${contentSelector} [data-testid="collaboration-board"]`, {
    visible: true,
    timeoutMs,
  })
}
