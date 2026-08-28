const ACTIVE_WORKSPACE_TAB_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'

export async function ensureProjectExpandedInActiveSidebar(
  control,
  { projectId = null, timeoutMs }
) {
  let sidebarSelector = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar"]`
  const visibleSidebarCount = Number(
    await control.command('getElementCount', sidebarSelector, { visible: true })
  )
  let requireVisible = visibleSidebarCount > 0

  if (visibleSidebarCount === 0) {
    const hoverEdgeSelector = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar-hover-edge"]`
    const hoverEdgeCount = Number(await control.command('getElementCount', hoverEdgeSelector))
    if (hoverEdgeCount > 0) {
      await control.command('hover', hoverEdgeSelector)
      sidebarSelector = `${ACTIVE_WORKSPACE_TAB_SELECTOR} [data-testid="desktop-sidebar-preview-panel"]`
      requireVisible = true
      await control.command('waitFor', sidebarSelector, {
        timeoutMs,
        visible: true,
      })
    }
  }

  const projectsToggleSelector = `${sidebarSelector} [data-testid="projects-section-toggle"]`
  const projectRowSelector = projectId
    ? `${sidebarSelector} [data-testid="project-row-${projectId}"]`
    : sidebarSelector
  const projectButtonSelector = `${projectRowSelector} [data-testid="project-item-button"]`

  await control.command('waitFor', projectsToggleSelector, {
    timeoutMs,
    visible: requireVisible,
  })
  await control.command('scrollIntoView', projectsToggleSelector)
  const projectsSectionExpanded = await control.command('getAttribute', projectsToggleSelector, {
    value: 'aria-expanded',
    visible: requireVisible,
  })
  if (projectsSectionExpanded !== 'true') {
    await control.command('click', projectsToggleSelector, { visible: requireVisible })
  }

  await control.command('waitFor', projectButtonSelector, {
    timeoutMs,
    visible: requireVisible,
  })
  await control.command('scrollIntoView', projectButtonSelector)
  const projectExpanded = await control.command('getAttribute', projectButtonSelector, {
    value: 'aria-expanded',
    visible: requireVisible,
  })
  if (projectExpanded !== 'true') {
    await control.command('click', projectButtonSelector, { visible: requireVisible })
  }
  await control.command('waitFor', `${projectButtonSelector}[aria-expanded="true"]`, {
    timeoutMs,
    visible: requireVisible,
  })
  await new Promise(resolve => setTimeout(resolve, 350))

  return { requireVisible, sidebarSelector }
}
