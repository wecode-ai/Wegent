import assert from 'node:assert/strict'

/** Reuse the real pending-question lifecycle, including history and renderer reload. */
export async function verifyInteractionTime(control, page, { visible, expected } = {}) {
  const list =
    '[data-testid="interaction-list-item"][aria-pressed="true"] [data-testid="interaction-list-time"]'
  const detail = '[data-testid="interaction-detail-time"]'
  const readyOwner = `${page}:has(${list}):has(${detail})`
  const metrics = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${readyOwner}, ${readyOwner} ${list}, ${readyOwner} ${detail}`,
      {
        visible: true,
        value: JSON.stringify({
          includeText: true,
          attributeNames: ['datetime', 'title'],
          waitForMatch: true,
        }),
      }
    )
  )
  const owners = []
  let owner
  for (const metric of metrics) {
    if (metric.testId === 'runtime-interactions-page') {
      owner = { page: { ...metric, text: undefined }, times: [] }
      owners.push(owner)
    } else if (owner) owner.times.push(metric)
  }
  const active = owners.filter(item => item.page.visible)
  assert.equal(active.length, 1, `Expected one visible time owner: ${JSON.stringify(owners)}`)
  let timestamp
  for (const surface of ['list', 'detail']) {
    const isVisible = !visible || visible === surface
    const times = active[0].times.filter(item => item.testId === `interaction-${surface}-time`)
    assert.equal(
      times.length,
      1,
      `Expected one ${surface} time in the active owner: ${JSON.stringify(active)}`
    )
    const bounds = times[0]
    const iso = bounds.attributes.datetime
    assert.ok(Number.isFinite(Date.parse(iso)) && Date.parse(iso) > 0, 'Use a real event time')
    assert.equal(new Date(iso).toISOString(), iso, 'Expose a machine-readable ISO time')
    assert.ok(bounds.text.trim(), 'Show the formatted time')
    assert.ok(bounds.attributes.title.trim(), 'Expose the complete local date and time on hover')
    if (timestamp) assert.equal(iso, timestamp, 'List and detail must show the same event time')
    if (expected) assert.equal(iso, expected, 'Resizing and reload must preserve the event time')
    timestamp = iso
    if (isVisible) {
      assert.ok(
        bounds.visible === true &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left >= 0 &&
          bounds.top >= 0 &&
          bounds.right <= bounds.viewportWidth &&
          bounds.bottom <= bounds.viewportHeight &&
          bounds.scrollWidth <= bounds.clientWidth + 1,
        `${surface} time must fit inside the visible viewport without truncation`
      )
    }
  }
  return timestamp
}
