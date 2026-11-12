import assert from 'node:assert/strict'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CATALOG_EFFORTS = ['low', 'high', 'xhigh', 'max', 'ultra']

export async function configureCatalogReasoning(control) {
  for (const effort of EFFORTS) {
    const selector = `[data-testid="local-model-reasoning-level-${effort}"]`
    await control.command('waitFor', selector, { visible: true })
    const checked = Number(await control.command('getElementCount', `${selector}:checked`)) === 1
    if (checked !== CATALOG_EFFORTS.includes(effort)) {
      await control.command('click', selector)
    }
  }
  await control.command('fill', '[data-testid="local-model-default-reasoning-input"]', {
    value: 'high',
  })
}

export async function verifyCatalogReasoning(control) {
  await control.command('click', '[data-testid="model-selector-button"]')
  await control.command('waitFor', '[data-testid="model-selection-mode"]', { text: '固定模型' })
  const snapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="model-control-reasoning-slider"]')
  )
  for (const effort of EFFORTS) {
    assert.equal(
      snapshot.testIds.includes(`model-control-reasoning-${effort}`),
      CATALOG_EFFORTS.includes(effort),
      `Fixed-model slider must match the saved Catalog checkbox for ${effort}`
    )
  }
  await control.command('press', 'body', { key: 'Escape' })
}

export async function selectCatalogEffort(control, effort) {
  await control.command('click', '[data-testid="model-selector-button"]')
  await control.command('click', `[data-testid="model-control-reasoning-${effort}"]`)
  const label = effort === 'ultra' ? 'Ultra' : '最大'
  await control.command('waitFor', '[data-testid="model-simple-header"]', { text: label })
  const panel = JSON.parse(
    await control.command('snapshot', '[data-testid="model-advanced-panel"]')
  )
  assert.equal(panel.testIds.includes('reasoning-ultra-burst'), effort === 'ultra')
  assert.equal(
    await control.command('getAttribute', '[data-testid="model-control-reasoning-track"]', {
      value: 'aria-valuetext',
    }),
    label
  )
  await control.command('press', 'body', { key: 'Escape' })
}
