import { until } from './plugin-regression-fixture.mjs'

export async function openExplicitModelMenu(control, trigger, { requireSelection = false } = {}) {
  const menu = '[data-testid="model-selector-menu"]'
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', menu)
  await until(
    async () => {
      if ((await control.command('getAttribute', menu, { value: 'data-panel' })) === 'simple') {
        await control.command('clickWhenEnabled', `${menu} [data-testid="model-advanced-toggle"]`)
        return false
      }
      // Catalog initialization can briefly expose advanced view before resolving a selection.
      return (
        Number(
          await control.command(
            'getElementCount',
            `${menu}[data-panel="advanced"]${requireSelection ? ' [role="radio"][aria-checked="true"]' : ''}`,
            { visible: true }
          )
        ) > 0
      )
    },
    ready => ready,
    'The explicit model menu did not become ready'
  )
}
