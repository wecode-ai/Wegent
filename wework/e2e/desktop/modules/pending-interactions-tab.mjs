import assert from 'node:assert/strict'

const TAB = '[data-testid="workspace-tab-select-pending-interactions"]'

export async function verifyPendingInteractionsTab(
  control,
  expectedQuestionCount,
  { openFromMenu = false, requireProjectCountKnown = false, expectedProjectCount } = {}
) {
  assert.ok(Number.isInteger(expectedQuestionCount) && expectedQuestionCount >= 0)
  const questions = `${TAB}[data-pending-question-count="${expectedQuestionCount}"]`
  let readyTab = `${questions}:not([data-project-count-state="loading"])`
  if (expectedProjectCount !== undefined) {
    assert.ok(Number.isInteger(expectedProjectCount) && expectedProjectCount >= 0)
    readyTab = `${questions}[data-project-count-state="known"][data-project-pending-count="${expectedProjectCount}"]`
  } else if (requireProjectCountKnown) readyTab = `${questions}[data-project-count-state="known"]`
  const counter = '[data-testid="workspace-tab-pending-count-pending-interactions"]'
  const metrics = JSON.parse(
    await control.command('getElementMetrics', `${readyTab}, ${readyTab} ${counter}`, {
      text: '待你处理',
      value: JSON.stringify({
        includeText: true,
        waitForMatch: true,
        attributeNames: [
          'title',
          'data-pending-question-count',
          'data-project-pending-count',
          'data-project-count-state',
        ],
      }),
    })
  )
  const tabs = metrics.filter(item => item.testId === 'workspace-tab-select-pending-interactions')
  assert.equal(tabs.length, 1)
  const tab = tabs[0]
  const state = tab.attributes['data-project-count-state']
  assert.ok(['unknown', 'known', 'unsupported'].includes(state))
  assert.equal(tab.attributes['data-pending-question-count'], String(expectedQuestionCount))
  if (expectedProjectCount !== undefined) {
    assert.equal(state, 'known')
    assert.equal(tab.attributes['data-project-pending-count'], String(expectedProjectCount))
  }
  let total = null
  if (state === 'known' || state === 'unsupported') {
    const projectCount = tab.attributes['data-project-pending-count']
    assert.match(projectCount, /^\d+$/)
    assert.ok(Number.isSafeInteger(Number(projectCount)))
    if (state === 'unsupported') assert.equal(Number(projectCount), 0)
    total = expectedQuestionCount + Number(projectCount)
  }
  const title = total === null ? '待你处理' : `待你处理（${total}）`
  const counters = metrics.filter(
    item => item.testId === 'workspace-tab-pending-count-pending-interactions'
  )
  if (total === null) {
    assert.equal(counters.length, 0)
  } else {
    assert.equal(counters.length, 1)
    const counterMetrics = counters[0]
    assert.equal(counterMetrics.visible, true)
    assert.equal(counterMetrics.text, `（${total}）`)
    assert.ok(
      counterMetrics.width > 0 && counterMetrics.scrollWidth <= counterMetrics.clientWidth + 1,
      'The pending count must be visible without truncation'
    )
    assert.ok(
      counterMetrics.left >= tab.left && counterMetrics.right <= tab.right,
      'The pending count must fit inside its tab'
    )
  }
  assert.equal(tab.attributes.title, title)
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
