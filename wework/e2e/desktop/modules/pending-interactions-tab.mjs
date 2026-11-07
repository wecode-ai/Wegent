import assert from 'node:assert/strict'

const TAB = '[data-testid="workspace-tab-select-pending-interactions"]'

export async function verifyPendingInteractionsTab(
  control,
  expectedQuestionCount,
  { openFromMenu = false, requireProjectCountKnown = false } = {}
) {
  assert.ok(Number.isInteger(expectedQuestionCount) && expectedQuestionCount >= 0)
  if (requireProjectCountKnown)
    await control.command('waitFor', `${TAB}[data-project-count-state="known"]`)
  await control.command(
    'waitFor',
    `${TAB}[data-pending-question-count="${expectedQuestionCount}"]`,
    { text: '待你处理' }
  )
  await control.command('waitFor', `${TAB}:not([data-project-count-state="loading"])`)
  const state = await control.command('getAttribute', TAB, { value: 'data-project-count-state' })
  assert.ok(['loading', 'unknown', 'known', 'unsupported'].includes(state))
  let total = null
  if (state === 'known' || state === 'unsupported') {
    const projectCount = await control.command('getAttribute', TAB, {
      value: 'data-project-pending-count',
    })
    assert.match(projectCount, /^\d+$/)
    assert.ok(Number.isSafeInteger(Number(projectCount)))
    if (state === 'unsupported') assert.equal(Number(projectCount), 0)
    total = expectedQuestionCount + Number(projectCount)
  }
  const title = total === null ? '待你处理' : `待你处理（${total}）`
  const counter = '[data-testid="workspace-tab-pending-count-pending-interactions"]'
  if (total === null) {
    await control.command('waitFor', counter, { visible: false })
  } else {
    await control.command('waitFor', counter, { text: String(total), visible: true })
    assert.equal(await control.command('getText', counter), `（${total}）`)
    const [counterMetrics] = JSON.parse(await control.command('getElementMetrics', counter))
    const [tabMetrics] = JSON.parse(await control.command('getElementMetrics', TAB))
    assert.ok(
      counterMetrics.width > 0 && counterMetrics.scrollWidth <= counterMetrics.clientWidth + 1,
      'The pending count must be visible without truncation'
    )
    assert.ok(
      counterMetrics.left >= tabMetrics.left && counterMetrics.right <= tabMetrics.right,
      'The pending count must fit inside its tab'
    )
  }
  assert.equal(await control.command('getAttribute', TAB, { value: 'title' }), title)
  assert.equal(Number(await control.command('getElementCount', TAB)), 1)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        '[data-testid="workspace-tab-close-pending-interactions"]'
      )
    ),
    0,
    'The default pending-interactions tab must remain fixed'
  )
  if (!openFromMenu) return
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-pending-interactions"]', {
    text: '待你处理',
  })
  await control.command('click', '[data-testid="workspace-tab-add-pending-interactions"]')
  assert.equal(await control.command('getAttribute', TAB, { value: 'aria-selected' }), 'true')
  assert.equal(Number(await control.command('getElementCount', TAB)), 1)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="workspace-tab-add-menu"]')),
    0
  )
}
