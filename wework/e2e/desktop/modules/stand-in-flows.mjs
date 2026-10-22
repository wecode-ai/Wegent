/** Follow the project entry into the shared personal settings and expand optional instructions. */
export async function openProjectStandIn(
  control,
  entry,
  { connect = false, requirements = true, onConnections } = {}
) {
  await control.command('click', entry)
  await control.command('waitFor', '[data-testid="stand-in-source-collaboration"]')
  if (connect) {
    const enabled = await control.command(
      'getAttribute',
      '[data-testid="stand-in-source-collaboration"]',
      { value: 'aria-checked' }
    )
    if (enabled !== 'true')
      await control.command('click', '[data-testid="stand-in-source-collaboration"]')
    await onConnections?.()
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
  } else {
    await control.command('click', '[data-testid="stand-in-back"]')
  }
  await control.command('waitFor', '[data-testid="stand-in-auto"]')
  if (requirements) {
    await control.command('click', '[data-testid="stand-in-requirements-open"]')
    await control.command('waitFor', '[data-testid="stand-in-prompt"]')
  }
}

export async function discardStandInDraft(control) {
  await control.command('click', '[data-testid="stand-in-cancel"]')
  await control.command('click', '[data-testid="stand-in-discard"]')
  await control.command('waitFor', '[data-testid="stand-in-dialog"]', { visible: false })
}
