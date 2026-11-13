import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export const COLLABORATION_SIDEBAR_SELECTOR = '[data-testid="collaboration-platform-sidebar"]'

export function inCollaborationSidebar(selector, contentSelector = '') {
  const sidebarSelector = `${COLLABORATION_SIDEBAR_SELECTOR} ${selector}`
  return contentSelector ? `${contentSelector} ${sidebarSelector}` : sidebarSelector
}

/** Reveal the exact target after it mounts, regardless of sidebar list length. */
export async function revealCollaborationSidebarElement(
  control,
  selector,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  await control.command('waitFor', selector, { timeoutMs })
  await control.command('scrollIntoView', selector, { visible: true })
  await control.command('waitFor', selector, { visible: true, timeoutMs })
}

/** Wait for the project groups that now display their spaces directly. */
export async function expandCollaborationSpaces(
  control,
  contentSelector = '[data-workspace-tab-content][aria-hidden="false"]',
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  for (const location of ['local', 'cloud']) {
    await control.command(
      'waitFor',
      inCollaborationSidebar(
        `[data-testid="collaboration-project-group-${location}"]`,
        contentSelector
      ),
      { timeoutMs }
    )
  }
}
