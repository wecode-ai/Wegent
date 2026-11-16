import assert from 'node:assert/strict'

export const PERFORMANCE_SCHEMA = 1
const REGION_COUNTERS = [
  'mutationRecords',
  'attributeChanges',
  'textChanges',
  'addedNodes',
  'removedNodes',
  'rootRemovals',
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

/** Cumulative snapshots travel with the existing control protocol, without extra polling. */
export class DesktopPerformanceJournal {
  constructor(metadata) {
    this.metadata = metadata
    this.contexts = new Map()
    this.errors = new Set()
    this.commands = new Map()
    this.observations = []
  }

  record(clientId, snapshot, action = 'ready', phase = 'ready', commandId = null) {
    this.commands.set(action, (this.commands.get(action) ?? 0) + 1)
    try {
      const metrics = flattenPerformance(snapshot)
      const previous = this.contexts.get(snapshot.captureId)
      if (previous) {
        assert.equal(previous.clientId, clientId, 'Performance capture changed control clients')
        for (const [name, count] of Object.entries(previous.metrics)) {
          assert.ok(
            metrics[name] !== undefined && metrics[name] >= count,
            `Performance counter reset: ${name}`
          )
        }
      }
      const changes = Object.fromEntries(
        Object.entries(metrics)
          .map(([name, count]) => [name, count - (previous?.metrics[name] ?? 0)])
          .filter(([, count]) => count !== 0)
      )
      this.observations.push({ captureId: snapshot.captureId, action, phase, commandId, changes })
      this.contexts.set(snapshot.captureId, { clientId, metrics })
    } catch (error) {
      this.errors.add(error.message)
    }
  }

  report(functionalPassed) {
    const totals = new Map()
    for (const { metrics } of this.contexts.values()) {
      for (const [name, value] of Object.entries(metrics)) {
        const previous = totals.get(name) ?? 0
        const maximum =
          name.endsWith('.maxAddedSubtreeElements') || name.endsWith('.maxRemovedSubtreeElements')
        totals.set(name, maximum ? Math.max(previous, value) : previous + value)
      }
    }
    const metrics = Object.fromEntries(totals)
    const violations = INVARIANTS.filter(name => (metrics[name] ?? 0) !== 0)
    return {
      schema: PERFORMANCE_SCHEMA,
      ...this.metadata,
      functionalPassed,
      complete: this.contexts.size > 0 && this.errors.size === 0,
      contexts: this.contexts.size,
      coverageErrors: [...this.errors],
      violations,
      metrics,
      commands: Object.fromEntries(this.commands),
      observations: this.observations,
      baselineStatus: 'not-established',
      comparisonValidated: false,
    }
  }
}
