import assert from 'node:assert/strict'
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

/** Open optional space management before interacting with workspace controls. */
export async function expandCollaborationSpaces(
  control,
  contentSelector = '[data-workspace-tab-content][aria-hidden="false"]',
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  const toggle = inCollaborationSidebar(
    '[data-testid="collaboration-workspaces-section-toggle"]',
    contentSelector
  )
  await expandCollaborationToggle(control, toggle, timeoutMs)
}

async function expandCollaborationToggle(control, toggleSelector, timeoutMs) {
  await revealCollaborationSidebarElement(control, toggleSelector, timeoutMs)
  const expandedSelector = `${toggleSelector}[aria-expanded="true"]`
  const expanded = await control.command('getAttribute', toggleSelector, {
    value: 'aria-expanded',
  })
  assert.ok(
    expanded === 'true' || expanded === 'false',
    'A workspace toggle must expose its expanded state'
  )
  if (expanded === 'true') return
  await control.command('click', toggleSelector)
  await control.command('waitFor', expandedSelector, {
    visible: true,
    timeoutMs,
  })
}
