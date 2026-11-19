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
  const selector = '[data-testid="stand-in-source-collaboration"]'
  await control.command('waitFor', selector)
  const current = await control.command('getAttribute', selector, { value: 'aria-checked' })
  if (current !== String(enabled)) await control.command('click', selector)
  await control.command('waitFor', `${selector}[aria-checked="${enabled}"]`)
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
