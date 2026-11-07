import assert from 'node:assert/strict'

/** Reuse the real pending-question lifecycle, including history and renderer reload. */
export async function verifyInteractionTime(control, page, { visible, expected } = {}) {
  const selectors = {
    list: `${page} [data-testid="interaction-list-item"][aria-pressed="true"] [data-testid="interaction-list-time"]`,
    detail: `${page} [data-testid="interaction-detail-time"]`,
  }
  let timestamp
  for (const [surface, selector] of Object.entries(selectors)) {
    const isVisible = !visible || visible === surface
    await control.command('waitFor', selector, isVisible ? { visible: true } : {})
    const iso = await control.command('getAttribute', selector, { value: 'datetime' })
    assert.ok(Number.isFinite(Date.parse(iso)) && Date.parse(iso) > 0, 'Use a real event time')
    assert.equal(new Date(iso).toISOString(), iso, 'Expose a machine-readable ISO time')
    assert.ok((await control.command('getText', selector)).trim(), 'Show the formatted time')
    assert.ok(
      (await control.command('getAttribute', selector, { value: 'title' })).trim(),
      'Expose the complete local date and time on hover'
    )
    if (timestamp) assert.equal(iso, timestamp, 'List and detail must show the same event time')
    if (expected) assert.equal(iso, expected, 'Resizing and reload must preserve the event time')
    timestamp = iso
    if (isVisible) {
      const [bounds] = JSON.parse(await control.command('getElementMetrics', selector))
      assert.ok(
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
