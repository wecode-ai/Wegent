import assert from 'node:assert/strict'

export const PERFORMANCE_SCHEMA = 1
const REGION_COUNTERS = [
  'mutationRecords',
  'attributeChanges',
  'textChanges',
  'addedNodes',
  'removedNodes',
  'rootRemovals',
  'addedSubtreeElements',
  'removedSubtreeElements',
  'maxAddedSubtreeElements',
  'maxRemovedSubtreeElements',
]
const EXECUTOR_COUNTERS = [
  'parseFailures',
  'protocolFailures',
  'transportFailures',
  'requestFailures',
  'cancellations',
  'duplicateEvents',
  'duplicateDeliveries',
  'injectedDuplicateDeliveries',
  'streamStarts',
  'reconnects',
  'fullTaskListReads',
  'pendingTaskListReads',
]
const INVARIANTS = [
  'executor.parseFailures',
  'executor.protocolFailures',
  'executor.duplicateDeliveries',
]

function counter(value, name) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `Missing or invalid performance counter: ${name}`
  )
  return value
}

export function flattenPerformance(snapshot) {
  assert.equal(snapshot?.version, 1, 'Missing renderer performance schema')
  assert.ok(
    typeof snapshot.captureId === 'string' && snapshot.captureId,
    'Missing performance capture identity'
  )
  const metrics = new Map()
  for (const [name, region] of Object.entries(snapshot.regions)) {
    assert.equal(typeof region.observed, 'boolean', `Missing region coverage: ${name}`)
    if (!region.observed) continue
    for (const field of REGION_COUNTERS)
      metrics.set(`ui.${name}.${field}`, counter(region[field], field))
  }
  for (const [name, value] of Object.entries(snapshot.renders)) {
    if (value !== null) metrics.set(`renders.${name}`, counter(value, name))
  }
  if (snapshot.reactCommits !== null)
    metrics.set('react.commitCount', counter(snapshot.reactCommits.count, 'react.commitCount'))
  const responsiveness = snapshot.responsiveness
  if (responsiveness) {
    assert.ok(
      Array.isArray(responsiveness.supportedEntryTypes) &&
        responsiveness.supportedEntryTypes.every(type =>
          ['longtask', 'long-animation-frame'].includes(type)
        ),
      'Invalid responsiveness availability'
    )
    for (const [type, fields] of [
      ['longtask', ['longTaskCount', 'longTaskTotalMs', 'longTaskMaxMs']],
      [
        'long-animation-frame',
        ['frameCount', 'frameTotalMs', 'frameMaxMs', 'slowScriptCount', 'slowScriptMaxMs'],
      ],
    ]) {
      if (!responsiveness.supportedEntryTypes.includes(type)) continue
      for (const field of fields)
        metrics.set(`renderer.${field}`, counter(responsiveness[field], field))
    }
    metrics.set(
      'renderer.droppedDetailEvents',
      counter(responsiveness.droppedEvents, 'droppedEvents')
    )
  }
  assert.equal(
    snapshot.executor?.available,
    true,
    'Executor performance instrumentation is unavailable'
  )
  for (const field of EXECUTOR_COUNTERS)
    metrics.set(`executor.${field}`, counter(snapshot.executor[field], field))
  for (const field of ['requests', 'events']) {
    assert.ok(
      snapshot.executor[field] && !Array.isArray(snapshot.executor[field]),
      `Missing Executor ${field}`
    )
    for (const [name, value] of Object.entries(snapshot.executor[field])) {
      metrics.set(`executor.${field}.${name}`, counter(value, name))
    }
  }
  return Object.fromEntries(metrics)
}

function regressions(previous, metrics) {
  return Object.entries(previous ?? {})
    .filter(([name, count]) => metrics && (metrics[name] === undefined || metrics[name] < count))
    .map(([name, count]) => ({ name, previous: count, current: metrics[name] ?? null }))
}

function validateCounters(previous, metrics) {
  const reset = regressions(previous, metrics)[0]
  assert.ok(!reset, 'Performance counter reset: ' + reset?.name)
}

function frameObservation(frame, previous) {
  return {
    captureId: frame.captureId,
    action: frame.action,
    phase: frame.phase,
    commandId: frame.commandId,
    changes: Object.fromEntries(
      Object.entries(frame.metrics)
        .map(([name, count]) => [name, count - (previous?.metrics[name] ?? 0)])
        .filter(([name, count]) => count !== 0 || !Object.hasOwn(previous?.metrics ?? {}, name))
    ),
    observedAt: frame.finishedAt,
    elapsedMs: frame.durationMs,
    removals: frame.removals.filter(removal => removal.atMs >= (previous?.durationMs ?? 0)),
  }
}

function framePosition(frames, durationMs) {
  let left = 0,
    right = frames.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (frames[middle].durationMs <= durationMs) left = middle + 1
    else right = middle
  }
  return left
}

/** Cumulative snapshots travel with the existing control protocol, without extra polling. */
export class DesktopPerformanceJournal {
  constructor(metadata) {
    this.metadata = metadata
    this.contexts = new Map()
    this.frames = new Map()
    this.errors = new Set()
    this.commands = new Map()
    this.observations = []
    this.rejectedSnapshots = []
  }

  recordExternalServiceProtocols(protocols) {
    const observed = new Set([...(this.metadata.externalServiceProtocols ?? []), ...protocols])
    this.metadata.externalServiceProtocols = [...observed]
    this.metadata.verificationType = observed.size ? 'protocol-integration' : 'real-e2e'
  }

  record(clientId, snapshot, action = 'ready', phase = 'ready', commandId = null) {
    if (phase === 'started') this.commands.set(action, (this.commands.get(action) ?? 0) + 1)
    let previous = this.contexts.get(snapshot?.captureId)
    let following, metrics
    try {
      metrics = flattenPerformance(snapshot)
      assert.ok(
        Number.isFinite(snapshot.durationMs) && snapshot.durationMs >= 0,
        'Missing or invalid capture elapsed time'
      )
      if (previous) {
        assert.equal(previous.clientId, clientId, 'Performance capture changed control clients')
        assert.equal(
          previous.startedAt,
          snapshot.startedAt,
          'Performance capture changed start time'
        )
      }
      const frames = this.frames.get(snapshot.captureId) ?? []
      const position = framePosition(frames, snapshot.durationMs)
      previous = frames[position - 1]
      following = frames[position]
      validateCounters(previous?.metrics, metrics)
      if (following) validateCounters(metrics, following.metrics)
      const frame = {
        clientId,
        captureId: snapshot.captureId,
        metrics,
        action,
        phase,
        commandId,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
        durationMs: snapshot.durationMs,
        removals: snapshot.removals ?? [],
      }
      frame.observation = frameObservation(frame, previous)
      if (following) {
        Object.assign(following.observation, frameObservation(following, frame))
        this.observations.splice(
          this.observations.indexOf(following.observation),
          0,
          frame.observation
        )
      } else this.observations.push(frame.observation)
      frames.splice(position, 0, frame)
      this.frames.set(snapshot.captureId, frames)
      this.contexts.set(snapshot.captureId, frames.at(-1))
    } catch (error) {
      this.errors.add(error.message)
      this.rejectedSnapshots.push({
        clientId,
        captureId: snapshot?.captureId ?? null,
        action,
        phase,
        commandId,
        durationMs: Number.isFinite(snapshot?.durationMs) ? snapshot.durationMs : null,
        previousDurationMs: previous?.durationMs ?? null,
        error: error.message,
        regressions: regressions(previous?.metrics, metrics),
        ...(following
          ? {
              followingDurationMs: following.durationMs,
              followingRegressions: regressions(metrics, following.metrics),
            }
          : {}),
      })
    }
  }

  report(functionalPassed) {
    const totals = new Map()
    for (const { metrics } of this.contexts.values()) {
      for (const [name, value] of Object.entries(metrics)) {
        const previous = totals.get(name) ?? 0
        const maximum =
          name.endsWith('.maxAddedSubtreeElements') ||
          name.endsWith('.maxRemovedSubtreeElements') ||
          (name.startsWith('renderer.') && name.endsWith('MaxMs'))
        totals.set(name, maximum ? Math.max(previous, value) : previous + value)
      }
    }
    const metrics = Object.fromEntries(totals)
    const violations = INVARIANTS.filter(name => {
      const count = metrics[name] ?? 0
      return (
        (name === 'executor.duplicateDeliveries'
          ? count - (metrics['executor.injectedDuplicateDeliveries'] ?? 0)
          : count) !== 0
      )
    })
    return {
      schema: PERFORMANCE_SCHEMA,
      ...this.metadata,
      functionalPassed,
      complete: this.contexts.size > 0 && this.errors.size === 0,
      contexts: this.contexts.size,
      captures: [...this.contexts].map(([captureId, context]) => ({
        captureId,
        clientId: context.clientId,
        startedAt: context.startedAt,
        finishedAt: context.finishedAt,
        durationMs: context.durationMs,
        removals: context.removals,
      })),
      coverageErrors: [...this.errors],
      rejectedSnapshots: this.rejectedSnapshots,
      violations,
      metrics,
      commands: Object.fromEntries(this.commands),
      observations: this.observations,
      baselineStatus: 'not-established',
      comparisonValidated: false,
    }
  }
}
