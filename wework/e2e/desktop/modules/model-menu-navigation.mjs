export async function openExplicitModelMenu(control, trigger) {
  const menu = '[data-testid="model-selector-menu"]'
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', menu)
  if ((await control.command('getAttribute', menu, { value: 'data-panel' })) === 'simple') {
    await control.command('clickWhenEnabled', '[data-testid="model-advanced-toggle"]')
  }
  await control.command('waitFor', `${menu}[data-panel="advanced"]`)
}
