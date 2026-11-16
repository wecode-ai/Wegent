import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_SELECTOR,
  SCROLLER_SELECTOR,
  waitForBottom,
} from './streaming-text-fixture.mjs'
import { waitForWorkbenchDebugState } from './workspace-flows.mjs'

const ANCHORS = `${ACTIVE_WORKBENCH_SELECTOR} [data-scroll-anchor]`
const SCROLLBAR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-scrollbar"]`

export async function verifyConversationSwitchPosition(
  control,
  { address, anchorText, name, pinned, resultDir, uiTimeoutMs, whileAway }
) {
  await control.command('waitFor', ANCHORS, { text: anchorText })
  const startedAt = Date.now()
  const phases = []
  const recordPhase = phase => phases.push({ phase, elapsedMs: Date.now() - startedAt })
  await control.command('startScrollStabilitySampling', ANCHORS, {
    value: JSON.stringify({
      anchorText,
      scrollerSelector: SCROLLER_SELECTOR,
      durationMs: uiTimeoutMs,
    }),
  })
  let sample
  let layout = null
  let layoutStarted = false
  let expired = false
  let settledFrom = 0
  try {
    // The away pane sends no model request. Catalog/provider setup is not part
    // of the measured conversation switch and has a separate readiness timeout.
    await control.command('click', '[data-testid="new-chat-button"]')
    await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })
    recordPhase('away-ready')
    await whileAway?.()
    await control.command(
      'clickWhenEnabled',
      `[data-testid="runtime-local-task-row-${address.taskId}"]`
    )
    await waitForWorkbenchDebugState(
      control,
      snapshot =>
        snapshot.pane?.currentRuntimeTask?.taskId === address.taskId &&
        snapshot.pane?.transcript?.loading === false,
      `${name}: the selected task transcript did not finish restoring`
    )
    recordPhase('transcript-restored')
    await control.command('startElementMetricsSampling', SCROLLER_SELECTOR, {
      value: String(uiTimeoutMs),
      target: '[data-testid="desktop-floating-composer-card"]',
    })
    layoutStarted = true
    settledFrom = JSON.parse(await control.command('getScrollStabilitySample', ANCHORS)).frames
      .length
    recordPhase('idle-observation-started')
    // Observe the completed fixture without input or new model output. Existence alone
    // is deliberately insufficient: the sampler must catch every intervening layout.
    await control.command('waitFor', ANCHORS, { text: anchorText, stableMs: 1_000 })
    recordPhase('idle-observation-completed')
  } finally {
    expired = JSON.parse(await control.command('getScrollStabilitySample', ANCHORS)).done
    sample = JSON.parse(await control.command('stopScrollStabilitySampling', ANCHORS))
    if (layoutStarted)
      layout = JSON.parse(await control.command('stopElementMetricsSampling', SCROLLER_SELECTOR))
    const diagnostics = JSON.parse(
      await control.command('getConversationDiagnosticsSnapshot', 'body')
    )
    await writeFile(
      join(resultDir, `conversation-switch-${name}.json`),
      JSON.stringify({ sample, layout, diagnostics, phases }, null, 2)
    )
  }
  assert.equal(expired, false, `${name}: sampling expired before the switch observation completed`)
  assert.ok(sample.frames.length >= 5, `${name}: switching did not capture enough visible frames`)
  const first = sample.frames[0]
  for (const frame of [...sample.frames, ...sample.scrollEvents]) {
    assert.ok(
      Math.abs(frame.anchorTop - first.anchorTop) <= 2,
      `${name}: task switching moved the visible text: ${JSON.stringify({ first, frame })}`
    )
    if (pinned)
      assert.ok(
        frame.scrollHeight - frame.clientHeight - frame.scrollTop <= 1,
        `${name}: switching lost bottom pinning: ${JSON.stringify(frame)}`
      )
  }
  const settled = sample.frames.slice(settledFrom)
  assert.ok(settled.length >= 5, `${name}: no idle observation window was captured`)
  for (const frame of settled)
    assert.equal(
      frame.scrollHeight,
      settled[0].scrollHeight,
      `${name}: unchanged conversation height oscillated after restoration finished`
    )
  const composerFrames = layout?.frames.filter(frame => frame.elements?.length === 1) ?? []
  assert.ok(composerFrames.length >= 5, `${name}: the restored composer was not observed`)
  for (const frame of composerFrames) {
    const composer = frame.elements[0]
    const bottomGap = frame.top + frame.height - composer.bottom
    assert.ok(
      composer.top >= frame.top && bottomGap >= 0 && bottomGap <= 32,
      `${name}: the composer moved away from the viewport bottom: ${JSON.stringify({ frame, bottomGap })}`
    )
  }
}

export async function verifyConversationSwitchScrollStability(control, options) {
  await verifyConversationSwitchPosition(control, {
    ...options,
    name: 'reading',
    anchorText: 'Turn 1 section 1',
    pinned: false,
  })
  await control.command('press', SCROLLBAR, { key: 'End' })
  await waitForBottom(control, 'The saved bottom position', options.uiTimeoutMs)
  await verifyConversationSwitchPosition(control, {
    ...options,
    name: 'bottom',
    anchorText: 'SCROLLBAR_HISTORY_END_4',
    pinned: true,
  })
}
