export async function sendStandInNotificationFollowUp(control, content, prompt) {
  const pane = `${content} [data-active-workbench-pane="true"]`
  const composer = `${pane} [data-testid="chat-message-input"][contenteditable="true"]`
  await control.command('waitFor', composer, { visible: true })
  await control.command('fill', composer, { value: prompt })
  // This flow verifies session routing; IME Enter handling has separate coverage.
  await control.command('clickWhenEnabled', `${pane} [data-testid="send-message-button"]`, {
    visible: true,
  })
}

/** Open the project picker, follow the explicit link into personal settings. */
export async function openProjectStandIn(
  control,
  entry,
  { connect = false, requirements = true, onConnections } = {}
) {
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  const projectLink = '[data-testid="personal-home-open-in-project"]'
  if (
    Number(await control.command('getElementCount', entry)) === 0 &&
    Number(await control.command('getElementCount', projectLink)) > 0
  )
    await control.command('clickWhenEnabled', projectLink)
  // Returning from personal settings remounts the project page asynchronously.
  await control.command('clickWhenEnabled', entry)
  await control.command('waitFor', '[data-testid="stand-in-project-select"]')
  const selected = await control.command('getValue', '[data-testid="stand-in-project-select"]')
  if (!selected) {
    const value = await control.command(
      'getAttribute',
      '[data-testid="stand-in-project-select"] option:not([disabled]):not([value="__new"])',
      { value: 'value' }
    )
    if (!value) throw new Error('The project picker must offer an existing personal stand-in')
    await control.command('select', '[data-testid="stand-in-project-select"]', { value })
  }
  await control.command('clickWhenEnabled', '[data-testid="stand-in-personal-settings-link"]')
  await control.command('waitFor', '[data-testid="stand-in-role-name"]')
  if (connect) {
    await editProjectSource(control, true)
    await onConnections?.()
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
    await control.command('waitFor', '[data-testid="stand-in-role-name"]')
  }
  if (requirements) await control.command('waitFor', '[data-testid="stand-in-prompt"]')
}

/** Change only this source's intake; the global lifecycle remains a separate native confirmation. */
export async function editProjectSource(control, enabled) {
  await control.command('click', '[data-testid="stand-in-connections-open"]')
  await openConnectionTypePicker(control)
  await control.command('click', '[data-testid="stand-in-add-projects-connection"]')
  await control.command('waitFor', '[data-testid="stand-in-project-scope"]')
  const count = Number(
    await control.command('getElementCount', '[data-testid^="stand-in-project-open-scope-"]')
  )
  if (enabled && !count) {
    await openProjectScopeDetails(control)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-project-list-mode"]')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-project-list-mode-all"]')
    const back = '[data-testid="stand-in-connections-back"]'
    await control.command('clickWhenEnabled', back)
    await control.command('waitFor', '[data-testid="stand-in-project-choose-projects"]')
    await control.command('clickWhenEnabled', back)
  } else if (!enabled && count) {
    await clearProjectScopes(control)
  }
  await control.command('waitFor', '[data-testid^="stand-in-project-open-scope-"]', {
    visible: enabled,
  })
}

export async function addAllProjectScopes(control, { configure = false } = {}) {
  await control.command('clickWhenEnabled', '[data-testid="stand-in-project-add-scope"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-all-projects"]')
  if (configure) return
  const back =
    '[data-testid="stand-in-connections-back"],[data-testid="stand-in-onboarding-connections-back"]'
  await control.command('clickWhenEnabled', back)
  await control.command('waitFor', '[data-testid="stand-in-project-choose-projects"]')
  await control.command('clickWhenEnabled', back)
}

export async function openProjectScopeDetails(control) {
  const saved = '[data-testid="stand-in-project-open-scope-projects"]'
  if (Number(await control.command('getElementCount', saved)) > 0) {
    await control.command('clickWhenEnabled', saved)
  } else {
    await control.command('clickWhenEnabled', '[data-testid="stand-in-project-add-scope"]')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-project-choose-projects"]')
  }
}

export async function clearProjectScopes(control) {
  for (const scope of ['projects', 'includeIndependentIssues', 'includeParticipatingIssues']) {
    const remove = `[data-testid="stand-in-project-open-scope-${scope}-remove"]`
    if (Number(await control.command('getElementCount', remove)) > 0) {
      await control.command('clickWhenEnabled', remove)
      await control.command('waitFor', remove, { visible: false })
    }
  }
}

export async function discardStandInDraft(control) {
  await control.command('click', '[data-testid="stand-in-close"]')
  await control.command('click', '[data-testid="stand-in-discard"]')
  await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
}

/** Control-channel readiness precedes the notification shell after reload. */
export async function openCollaborationNotifications(control) {
  await control.command('clickWhenEnabled', '[data-testid="wework-notifications-button"]')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="wework-notifications-category-collaboration"]'
  )
}

/** Empty settings show connection types immediately; populated settings use Add connection. */
export async function openConnectionTypePicker(control) {
  const button = '[data-testid="stand-in-add-connection"]'
  if (Number(await control.command('getElementCount', button)) > 0)
    await control.command('click', button)
  await control.command('waitFor', '[data-testid="stand-in-connection-type-picker"]')
}

export function standInSchedulerIntervalMs() {
  const intervalMs = Number(process.env.WEWORK_E2E_STAND_IN_POLL_INTERVAL_MS ?? 5000)
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('WEWORK_E2E_STAND_IN_POLL_INTERVAL_MS must be a positive integer')
  }
  return intervalMs
}

/** Observe a complete scheduler period plus jitter before asserting no dispatch. */
export async function waitForStandInSchedulerCycle() {
  await new Promise(resolve => setTimeout(resolve, standInSchedulerIntervalMs() + 500))
}
