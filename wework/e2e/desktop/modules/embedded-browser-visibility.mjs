import assert from 'node:assert/strict'

export async function verifyEmbeddedBrowserClickCursor(control, bridgeCall, label, ref, timeoutMs) {
  const id = await control.command('startBrowserCursorObservation', 'body', {
    value: label,
    timeoutMs,
  })
  let finished = false
  try {
    const clickResult = await bridgeCall({ action: 'click', ref, timeoutMs: 5_000 })
    assert.equal(clickResult.ok, true, `Click failed: ${JSON.stringify(clickResult)}`)
    assert.equal(clickResult.effect.domChanged, true)
    let evidence
    try {
      evidence = JSON.parse(
        await control.command('finishBrowserCursorObservation', 'body', { value: id, timeoutMs })
      )
    } finally {
      finished = true
    }
    assert.ok(evidence.firstVisible.cursorPresent)
    assert.ok(evidence.firstVisible.tabIconCount > 0, 'The browser tab did not show its agent icon')
    const cursorStyle = evidence.firstVisible.style
    assert.ok(
      cursorStyle.includes('translate3d'),
      `The host AI cursor did not move to the click target: ${cursorStyle}`
    )
    assert.ok(evidence.afterClick.elapsedMs >= 1_000)
    assert.equal(
      evidence.afterClick.visible,
      'true',
      'The host AI cursor disappeared immediately after the click'
    )
    assert.ok(evidence.afterClick.cursorPresent)
    assert.ok(evidence.afterClick.style.includes('translate3d'))
    assert.ok(evidence.afterClick.tabIconCount > 0)
    assert.ok(
      evidence.cursorHiddenAtUnixMs - evidence.clickFinishedAtUnixMs >= 4_000,
      'The host AI cursor hid before the product idle deadline'
    )
    assert.ok(
      evidence.hidden.cursorPresent,
      'The idle cursor overlay was removed instead of hidden'
    )
    assert.equal(evidence.hidden.visible, 'false')
    assert.equal(evidence.hidden.tabIconCount, 0, 'The idle browser tab retained its agent icon')
    return { ...evidence, clickResult }
  } finally {
    if (!finished) await control.command('cancelBrowserCursorObservation', 'body', { value: id })
  }
}

export async function waitForEmbeddedBrowserVisibility(
  control,
  label,
  expectedVisible,
  timeoutMs,
  message,
  previewSelector
) {
  const startedAt = Date.now()
  let lastState = null
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    if (previewSelector) {
      const errorSelector = `${previewSelector} [data-testid="smart-app-development-preview-error"]`
      if (Number(await control.command('getElementCount', errorSelector)) > 0) {
        const error = await control.command('getText', errorSelector)
        throw new Error(`Smart app development preview failed: ${error}`)
      }
    }
    try {
      lastState = JSON.parse(
        await control.command('getEmbeddedBrowserPageState', 'body', {
          value: label,
        })
      )
      const ready = expectedVisible ? lastState.url && lastState.isLoading === false : true
      if (lastState.visible === expectedVisible && ready) return lastState
    } catch (error) {
      // Reloading temporarily removes the native browser before opening its replacement.
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}: ${JSON.stringify({ state: lastState, error: lastError })}`)
}
