import assert from 'node:assert/strict'
import test from 'node:test'
import { DesktopPerformanceJournal } from '../e2e/desktop/performance-journal.mjs'
import { renderPerformanceReport } from '../e2e/desktop/performance-report.mjs'

function snapshot() {
  return {
    version: 1,
    captureId: 'renderer',
    regions: {
      document: {
        observed: true,
        mutationRecords: 2,
        attributeChanges: 1,
        textChanges: 1,
        addedNodes: 0,
        removedNodes: 0,
        rootRemovals: 0,
        maxAddedSubtreeElements: 0,
        maxRemovedSubtreeElements: 0,
      },
    },
    renders: { app: 2, unavailable: null },
    reactCommits: null,
    executor: {
      available: true,
      requests: { 'executor.describe': 1 },
      events: {},
      parseFailures: 0,
      protocolFailures: 0,
      transportFailures: 0,
      requestFailures: 0,
      cancellations: 0,
      duplicateEvents: 0,
      duplicateDeliveries: 0,
      streamStarts: 1,
      reconnects: 0,
      fullTaskListReads: 0,
      pendingTaskListReads: 0,
    },
  }
}
const metadata = { checkpoint: 'sample', platform: 'linux', arch: 'x64', variant: 'core' }

test('cumulative snapshots retain command boundaries without double counting', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  journal.record('client', snapshot())
  const next = snapshot()
  next.renders.app = 4
  journal.record('client', next, 'click', 'result', 'command-1')
  const result = journal.report(true)
  assert.equal(result.complete, true)
  assert.equal(result.metrics['renders.app'], 4)
  assert.deepEqual(result.observations[1], {
    captureId: 'renderer',
    action: 'click',
    phase: 'result',
    commandId: 'command-1',
    changes: { 'renders.app': 2 },
  })
  assert.equal(result.comparisonValidated, false)
  assert.equal(result.baselineStatus, 'not-established')
})

test('missing data, resets and cross-client reuse remain incomplete', () => {
  for (const next of [
    undefined,
    { ...snapshot(), renders: { app: 0 } },
    { ...snapshot(), executor: { available: false } },
  ]) {
    const journal = new DesktopPerformanceJournal(metadata)
    journal.record('client', snapshot())
    journal.record('client', next)
    assert.equal(journal.report(true).complete, false)
  }
  const journal = new DesktopPerformanceJournal(metadata)
  journal.record('client', snapshot())
  journal.record('other', snapshot())
  assert.equal(journal.report(true).complete, false)
})

test('protocol facts stay visible even when intentional fault injection functionally passes', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  const value = snapshot()
  value.executor.parseFailures = 1
  journal.record('client', value)
  const report = journal.report(true)
  assert.deepEqual(report.violations, ['executor.parseFailures'])
  assert.match(renderPerformanceReport([report]), /1 \/ 0/)
  assert.match(renderPerformanceReport([report]), /not a performance pass/)
})

test('a lost renderer is not rendered as a functional or performance pass', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  journal.record('client', undefined)
  const report = journal.report(false)
  const markdown = renderPerformanceReport([report])
  assert.match(markdown, /failed/)
  assert.match(markdown, /incomplete/)
  assert.match(markdown, /unavailable/)
  assert.equal(report.metrics['renders.app'], undefined)
})
