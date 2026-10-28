import assert from 'node:assert/strict'

const FLASH_ANIMATION = 'task-detail-comment-flash'

function flashFrame(sample) {
  return sample.frames.find(
    frame =>
      frame.connected &&
      frame.elements.some(
        element =>
          element.width > 0 &&
          element.height > 0 &&
          element.display !== 'none' &&
          element.animationName?.includes(FLASH_ANIMATION)
      )
  )
}

/** Capture the transient highlight before navigation and its layout waits begin. */
export async function observeCommentNavigation({
  control,
  selector,
  navigate,
  waitForComment,
  timeoutMs,
  recordSample,
}) {
  await control.command('startElementMetricsSampling', 'body', {
    value: String(timeoutMs),
    target: selector,
  })
  try {
    const baseline = JSON.parse(await control.command('getElementMetricsSample', 'body'))
    assert.equal(
      flashFrame(baseline),
      undefined,
      'The previous comment highlight must finish first'
    )
    const startedAt = Date.now()
    await navigate()
    const commentMs = await waitForComment(startedAt)
    let sample
    let frame
    do {
      sample = JSON.parse(await control.command('getElementMetricsSample', 'body'))
      frame = flashFrame(sample)
      if (frame || sample.done || Date.now() - startedAt >= timeoutMs) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (true)
    assert.ok(frame, 'The mentioned comment never flashed in the captured animation frames')
    // The renderer baseline precedes the click, so this includes setup time
    // instead of discounting transport latency from the original flash budget.
    return { commentMs, flashMs: Math.ceil(frame.time) }
  } finally {
    const sample = JSON.parse(await control.command('stopElementMetricsSampling', 'body'))
    await recordSample(sample)
  }
}
