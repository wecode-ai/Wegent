/** Open the project picker, follow the explicit link into personal settings. */
export async function openProjectStandIn(
  control,
  entry,
  { connect = false, requirements = true, onConnections } = {}
) {
  await control.command('click', entry)
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
  await control.command('click', '[data-testid="stand-in-personal-settings-link"]')
  await control.command('waitFor', '[data-testid="stand-in-auto"]')
  if (connect) {
    await control.command('click', '[data-testid="stand-in-connections-open"]')
    await control.command('waitFor', '[data-testid="stand-in-source-collaboration"]')
    const enabled = await control.command(
      'getAttribute',
      '[data-testid="stand-in-source-collaboration"]',
      { value: 'aria-checked' }
    )
    if (enabled !== 'true')
      await control.command('click', '[data-testid="stand-in-source-collaboration"]')
    await onConnections?.()
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
    await control.command('waitFor', '[data-testid="stand-in-auto"]')
  }
  if (requirements) await control.command('waitFor', '[data-testid="stand-in-prompt"]')
}

export async function discardStandInDraft(control) {
  await control.command('click', '[data-testid="stand-in-close"]')
  await control.command('click', '[data-testid="stand-in-discard"]')
  await control.command('waitFor', '[data-testid="stand-in-settings"]', { visible: false })
}
