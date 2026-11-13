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
  const management = selector.match(
    /\[data-testid="collaboration-primary-(?:agents|teams|devices|templates)"\]/
  )
  if (management) {
    const toggle = `${selector.slice(0, management.index)}[data-testid="collaboration-management-toggle"]`
    if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) === 'false') {
      await control.command('click', toggle)
      await control.command('waitFor', `${toggle}[aria-expanded="true"]`, { timeoutMs })
    }
  }
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
  await control.command(
    'waitFor',
    inCollaborationSidebar('[data-testid="collaboration-project-tree"]', contentSelector),
    { timeoutMs }
  )
}
