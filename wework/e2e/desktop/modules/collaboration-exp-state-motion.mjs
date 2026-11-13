import assert from 'node:assert/strict'
import { assertNoStateAnimation, assertUnchangedGeometry } from './collaboration-exp-rhythm.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'

const metrics = async (control, selector, attributeNames = []) =>
  JSON.parse(
    await control.command('getElementMetrics', selector, {
      value: JSON.stringify({ includeText: true, attributeNames }),
    })
  )

export async function readTeam(control, relay) {
  const nodes = await metrics(control, `${relay} [data-assistant-id]`, [
    'data-assistant-id',
    'data-state',
    'aria-label',
  ])
  assert.ok(nodes.length > 0, 'The real assistant settings and owned work must be ready')
  const team = []
  for (const node of nodes) {
    const id = node.attributes['data-assistant-id']
    const state = node.attributes['data-state']
    const label = node.attributes['aria-label']
    assert.ok(['waiting', 'running', 'idle'].includes(state), `Unknown team state: ${state}`)
    const status = {
      waiting: /待确认|Awaiting confirmation/,
      running: /推进中|In progress/,
      idle: /待命|Standing by/,
    }[state]
    assert.match(node.text, status)
    assert.match(label, status, 'The accessible name must retain the visible status')
    const indicators = await metrics(
      control,
      `${relay} [data-assistant-id=${JSON.stringify(id)}] .assistant-presence-mark`,
      ['data-state']
    )
    assert.equal(indicators.length, 1, 'Each state must retain its semantic indicator')
    assert.equal(indicators[0].attributes['data-state'], state)
    if (node.width > 0)
      assert.ok(
        indicators[0].width > 0 && indicators[0].height > 0,
        'Visible team members must retain a visible state indicator'
      )
    team.push({ id, state, text: node.text, label })
  }
  return team.sort((a, b) => a.id.localeCompare(b.id))
}

export async function assertReducedStateMotion(control, scope) {
  const nodes = await metrics(control, `${scope} .experience-team-relay-node`, [
    'data-assistant-id',
  ])
  assert.ok(nodes.length > 0, 'Motion assertions require the real ready team nodes')
  for (const node of nodes) {
    const member = `${scope} [data-assistant-id=${JSON.stringify(node.attributes['data-assistant-id'])}]`
    for (const selector of [member, `${member} .assistant-presence-mark`]) {
      const read = value => control.command('getComputedStyleValue', selector, { value })
      assertNoStateAnimation(
        await read('animation-name'),
        await read('animation-duration'),
        selector
      )
    }
  }
  const signal = `${scope} .assistant-team-rail-signal`
  assertNoStateAnimation(
    await control.command('getComputedStyleValue', signal, { value: 'animation-name' }),
    await control.command('getComputedStyleValue', signal, { value: 'animation-duration' }),
    signal
  )
}

/** Sample real frames after state readiness; no delay substitutes for layout evidence. */
export async function assertStableStateGeometry(control, selector) {
  await control.command('startElementMetricsSampling', selector, {
    value: '180',
    target:
      '[data-assistant-id], .assistant-presence-mark, .assistant-team-rail-signal, dl, button',
  })
  const sample = await waitForValue(
    async () => JSON.parse(await control.command('getElementMetricsSample', 'body')),
    value => value.done && value,
    'Reduced-motion state geometry must finish sampling',
    10_000
  )
  assert.ok(sample.frames.length >= 2, 'Geometry evidence needs multiple real animation frames')
  assert.ok(sample.frames[0].elements?.length > 0, 'State descendants must be sampled too')
  for (const frame of sample.frames) {
    assert.equal(frame.connected, true)
    assertUnchangedGeometry([sample.frames[0]], [frame], selector)
    assertUnchangedGeometry(sample.frames[0].elements, frame.elements, `${selector} states`)
    for (const element of frame.elements) {
      assert.equal(element.reducedMotion, true)
      assert.deepEqual(element.animations, [], 'Reduced-motion states must have no live animation')
    }
  }
}

export async function assertMobileAssistantPriority(
  control,
  testId,
  runningRole,
  projectId,
  issueId
) {
  const decision = testId(
    `collaboration-exp-assistant-pending-${JSON.stringify(['local', projectId, issueId])}`
  )
  const [input] = await metrics(control, testId('collaboration-exp-assistant-input'))
  for (const selector of [runningRole, decision]) {
    await control.command('waitFor', selector, { visible: true })
    const [box] = await metrics(control, selector)
    assert.ok(box.width > 0 && box.height >= 44, 'Mobile state controls must remain usable')
    assert.ok(box.top >= 0 && box.bottom <= input.top + 1, `${selector} must precede the composer`)
    assert.ok(
      box.visibleIntersection?.height >= box.height - 1,
      `${selector} must fit in the first screen`
    )
  }
  const [snapshot] = await metrics(control, testId('collaboration-exp-assistant-snapshot'))
  assert.equal(snapshot?.height ?? 0, 0, 'The desktop work snapshot must collapse on mobile')
}

export async function assertNativeWorkOpened(control, address, timeoutMs) {
  const matches = actual =>
    actual?.deviceId === address.deviceId && actual?.taskId === address.taskId
  const debug = await waitForValue(
    async () => JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')),
    snapshot =>
      matches(snapshot.workbench?.currentRuntimeTask) &&
      matches(snapshot.pane?.currentRuntimeTask) &&
      snapshot.pane.transcript.loading === false &&
      snapshot,
    'Current assistant work must open its exact original native task and pane',
    timeoutMs
  )
  assert.equal(debug.workbench.error, null)
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, { visible: true })
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        '[data-workspace-tab-content][aria-hidden="false"] [data-testid="collaboration-exp-assistant-conversation-unavailable"]'
      )
    ),
    0,
    'Public Issue execution must not be routed into an unavailable ordinary assistant pane'
  )
}
