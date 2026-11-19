import assert from 'node:assert/strict'

export async function verifyUiRefreshCollection(control) {
  const result = await control.refreshes.measure(
    'ui-refresh-collection-probe',
    {
      regions: [{ name: 'probe', selector: '[data-testid="e2e-ui-refresh-probe"]' }],
      renderIds: [],
    },
    () => control.command('probeUiRefreshCapture', 'body')
  )
  assert.equal(result.regions.probe.observed, true)
  assert.ok(result.regions.probe.mutationBatches >= 1)
  assert.equal(result.regions.probe.rootRemovals, 1)
  control.refreshes.assertWithin(result, { regions: { probe: { rootRemovals: 1 } } })
}
