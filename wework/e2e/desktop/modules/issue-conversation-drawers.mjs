import assert from 'node:assert/strict'
import { getSingleElementMetrics } from './conversation-layout.mjs'
import { join, resultDir, writeFile } from './shared.mjs'

async function sampleDrawerMotion(control, scope, action, direction, timeoutMs) {
  await control.command(
    'startElementMetricsSampling',
    scope('[data-testid="issue-drawer-workspace"]'),
    {
      value: '800',
      target: '.issue-drawer-surface',
    }
  )
  await action()
  const deadline = Date.now() + timeoutMs
  let sample
  do {
    sample = JSON.parse(await control.command('getElementMetricsSample', 'body'))
    if (sample.done) break
    assert.ok(Date.now() < deadline, 'Drawer frame sampling timed out')
    await new Promise(resolve => setTimeout(resolve, 30))
  } while (!sample.done)
  await writeFile(
    join(resultDir, `issue-drawers-${direction}-frames.json`),
    JSON.stringify(sample, null, 2)
  )
  const frames = sample.frames.map(frame => ({
    ...frame,
    detail: frame.elements.find(element => element.className.includes('issue-drawer-detail')),
    conversation: frame.elements.find(element =>
      element.className.includes('issue-drawer-conversation')
    ),
  }))
  assert.ok(frames.length > 2, 'Drawer motion needs multiple captured frames')
  const first = frames[0].detail
  const last = frames.at(-1).detail
  assert.ok(first && last, 'The Issue must remain mounted throughout the motion')
  let intermediateFrames = 0
  for (const [index, frame] of frames.entries()) {
    const { detail, conversation } = frame
    assert.ok(detail && conversation, 'Both track surfaces must remain mounted')
    assert.equal(detail.identity, first.identity, 'The Issue surface must not remount')
    assert.ok(
      Math.abs(detail.width - first.width) <= 1,
      'The Issue width must stay fixed on every frame'
    )
    assert.ok(
      Math.abs(conversation.left - detail.right - 8) <= 1,
      'Drawers must maintain their 8px gap on every frame'
    )
    assert.ok(Math.abs(detail.top - conversation.top) <= 1, 'Drawers must stay vertically aligned')
    assert.ok(
      detail.border.every(width => width === '1px'),
      'The Issue must have a complete border'
    )
    if (
      detail.left > Math.min(first.left, last.left) + 1 &&
      detail.left < Math.max(first.left, last.left) - 1
    ) {
      intermediateFrames += 1
    }
    if (direction === 'close' && detail.left < last.left - 1) {
      assert.ok(
        frame.testIds.includes('ai-chat-modal'),
        'Conversation content disappeared before the track finished returning'
      )
    }
    if (index === 0) continue
    const previous = frames[index - 1]
    const movement = detail.left - previous.detail.left
    assert.ok(
      direction === 'open' ? movement <= 1 : movement >= -1,
      'The shared track must not jump backwards'
    )
    const elapsed = frame.time - previous.time
    assert.ok(elapsed >= 0, 'Drawer frame timestamps must be monotonic')
    assert.ok(
      Math.abs(movement) <= ((detail.width + 8) * 4 * elapsed) / 220 + 2,
      'The shared track jumped instead of sliding'
    )
  }
  assert.ok(
    intermediateFrames > 0,
    `The ${direction} transition must include visible intermediate frames`
  )
}

// The caller owns a real Issue with at least one completed comment execution.
export async function verifyIssueConversationDrawers(control, scope, timeoutMs) {
  const detail = scope('[data-testid="cloud-todo-detail"]')
  const chat = scope('[data-testid="ai-chat-modal"]')
  const detailSurface = scope('.issue-drawer-detail')
  const conversationSurface = scope('.issue-drawer-conversation')
  const activity = JSON.parse(await control.command('snapshot', detail))
  const linkId = activity.testIds.find(id => id.startsWith('cloud-task-activity-open-task-'))
  assert.ok(linkId, 'The Issue has no execution conversation link')
  await control.command('waitFor', detail, { stableMs: 300, timeoutMs })
  const workspace = await getSingleElementMetrics(
    control,
    scope('[data-testid="issue-drawer-workspace"]'),
    'Project workspace'
  )
  const before = await getSingleElementMetrics(control, detailSurface, 'Issue drawer surface')
  const viewport = await getSingleElementMetrics(
    control,
    scope('.issue-drawer-viewport'),
    'Drawer clipping viewport'
  )
  await writeFile(
    join(resultDir, 'issue-drawers-initial-layout.json'),
    JSON.stringify({ workspace, viewport, detail: before }, null, 2)
  )
  assert.equal(viewport.scrollLeft, 0, 'Comment controls must not scroll the drawer track sideways')
  assert.ok(before.width <= 560, 'The Issue must open as a bounded sidebar, not a full page')
  assert.ok(before.left > workspace.left, 'The board must remain visible beside the first drawer')
  assert.ok(
    Math.abs(before.right - workspace.right) <= 1,
    `The first drawer must hug the project right edge: ${before.right} vs ${workspace.right}`
  )
  assert.ok(before.top >= workspace.top, 'Drawers must stay inside the project workspace')

  await sampleDrawerMotion(
    control,
    scope,
    () => control.command('click', scope(`[data-testid="${linkId}"]`)),
    'open',
    timeoutMs
  )
  await control.command('waitFor', chat, { stableMs: 300, timeoutMs })
  await control.command('waitFor', scope('[data-testid="project-chat-composer"]'), { timeoutMs })
  await control.command('waitFor', scope('[data-testid="composer-toolbar"]'), { timeoutMs })
  assert.equal(
    await control.command('getStyle', scope('[data-testid="right-workspace-chat-scroll-area"]'), {
      value: 'scrollbar-width',
    }),
    'none',
    'The shared conversation drawer must scroll without visible scrollbar chrome'
  )
  const left = await getSingleElementMetrics(control, detailSurface, 'Left Issue drawer')
  const right = await getSingleElementMetrics(
    control,
    conversationSurface,
    'Right conversation drawer'
  )
  await writeFile(
    join(resultDir, 'issue-drawers-open-layout.json'),
    JSON.stringify({ workspace, left, right }, null, 2)
  )
  assert.ok(left.width > 0 && right.width > 0, 'Both desktop drawers must remain visible')
  assert.ok(left.left < before.left, 'Opening a conversation must move the Issue to the left')
  assert.ok(left.right <= right.left, 'The conversation must not overlap the Issue')
  assert.ok(Math.abs(left.width - before.width) <= 1, 'Pushing the Issue must preserve its width')
  assert.ok(
    Math.abs(right.width - before.width) <= 1,
    'The second drawer must use the same sidebar width'
  )
  assert.ok(
    Math.abs(right.right - workspace.right) <= 1,
    'The second drawer must enter from the project right edge'
  )
  assert.ok(Math.abs(left.top - right.top) <= 1, 'Drawer tops must align')
  assert.ok(Math.abs(left.height - right.height) <= 1, 'Drawer heights must match')

  for (const property of ['background-color', 'border-radius', 'border', 'box-shadow']) {
    assert.equal(
      await control.command('getStyle', scope('.issue-drawer-detail'), { value: property }),
      await control.command('getStyle', scope('.issue-drawer-conversation'), { value: property }),
      `The two drawers must share ${property}`
    )
  }
  const leftHeader = await getSingleElementMetrics(control, `${detail} > header`, 'Issue header')
  const rightHeader = await getSingleElementMetrics(control, `${chat} > header`, 'Chat header')
  assert.equal(leftHeader.height, rightHeader.height, 'Drawer title bars must have equal heights')

  await sampleDrawerMotion(
    control,
    scope,
    () => control.command('click', scope('[data-testid="ai-chat-modal-back"]')),
    'close',
    timeoutMs
  )
  await control.command('waitFor', chat, { visible: false, timeoutMs })
  await control.command('waitFor', detail, { stableMs: 300, timeoutMs })
  const restored = await getSingleElementMetrics(control, detailSurface, 'Restored Issue drawer')
  assert.ok(Math.abs(restored.left - before.left) <= 1, 'Returning must restore the Issue position')
  assert.ok(Math.abs(restored.width - before.width) <= 1, 'Returning must restore the Issue width')

  await control.command('click', scope(`[data-testid="${linkId}"]`))
  await control.command('waitFor', chat, { timeoutMs })
  await control.command('press', scope('[data-testid="ai-chat-modal-close"]'), { key: 'Escape' })
  await control.command('waitFor', chat, { visible: false, timeoutMs })
  await control.command('waitFor', detail, { timeoutMs })
}
