import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DesktopPerformanceJournal } from '../e2e/desktop/performance-journal.mjs'
import {
  readPerformanceReports,
  renderPerformanceReport,
} from '../e2e/desktop/performance-report.mjs'

test('a failed preflight preserves a missing-evidence report and a failing exit status', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-performance-preflight-'))
  try {
    const directory = join(root, 'never-started')
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../e2e/desktop/performance-report.mjs', import.meta.url)), directory],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, 'summary.md') } }
    )
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    assert.match(
      readFileSync(join(directory, 'performance-report.md'), 'utf8'),
      /No checkpoint evidence was produced/
    )
    assert.match(readFileSync(join(root, 'summary.md'), 'utf8'), /not a performance pass/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing directories contain no evidence while invalid result paths remain errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-performance-path-'))
  try {
    assert.deepEqual(readPerformanceReports(join(root, 'absent')), [])
    const invalid = join(root, 'file')
    writeFileSync(invalid, 'not a directory')
    assert.throws(() => readPerformanceReports(invalid), { code: 'ENOTDIR' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function snapshot() {
  return {
    version: 1,
    captureId: 'renderer',
    startedAt: '2026-11-16T00:00:00.000Z',
    finishedAt: '2026-11-16T00:00:00.010Z',
    durationMs: 10,
    regions: {
      document: {
        observed: true,
        mutationRecords: 2,
        attributeChanges: 1,
        textChanges: 1,
        addedNodes: 0,
        removedNodes: 0,
        rootRemovals: 0,
        addedSubtreeElements: 0,
        removedSubtreeElements: 0,
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
      injectedDuplicateDeliveries: 0,
      streamStarts: 1,
      reconnects: 0,
      fullTaskListReads: 0,
      pendingTaskListReads: 0,
    },
  }
}
const metadata = { checkpoint: 'sample', platform: 'linux', arch: 'x64', variant: 'core' }

test('reports distinguish Sites protocol integration from real external compatibility', () => {
  const report = new DesktopPerformanceJournal({
    ...metadata,
    verificationType: 'protocol-integration',
    externalServiceProtocols: ['sites'],
  }).report(true)
  assert.match(
    renderPerformanceReport([report]),
    /Protocol integration \(sites\); external compatibility unverified/
  )
  assert.match(renderPerformanceReport([{ ...report, verificationType: 'real-e2e' }]), /Real E2E/)
  assert.match(renderPerformanceReport([{ ...report, verificationType: undefined }]), /Unspecified/)
  assert.match(
    renderPerformanceReport([{ ...report, externalServiceProtocols: ['git-hosting'] }]),
    /Protocol integration \(git-hosting\); external compatibility unverified/
  )
})

test('shared protocol fixtures remain declared when final scenario metadata is merged', () => {
  const journal = new DesktopPerformanceJournal({ ...metadata })
  journal.recordExternalServiceProtocols(['dingtalk'])
  journal.recordExternalServiceProtocols(['git-hosting', 'dingtalk'])
  journal.recordExternalServiceProtocols([])
  const report = journal.report(true)
  assert.equal(report.verificationType, 'protocol-integration')
  assert.deepEqual(report.externalServiceProtocols, ['dingtalk', 'git-hosting'])
  assert.match(renderPerformanceReport([report]), /external compatibility unverified/)
  const real = new DesktopPerformanceJournal({ ...metadata })
  real.recordExternalServiceProtocols([])
  assert.equal(real.report(true).verificationType, 'real-e2e')
  assert.deepEqual(real.report(true).externalServiceProtocols, [])
})

test('cumulative snapshots retain command boundaries without double counting', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  journal.record('client', snapshot())
  journal.record('client', snapshot(), 'click', 'started', 'command-1')
  const next = snapshot()
  next.renders.app = 4
  journal.record('client', next, 'click', 'result', 'command-1')
  const result = journal.report(true)
  assert.equal(result.complete, true)
  assert.equal(result.metrics['renders.app'], 4)
  assert.deepEqual(result.observations[2], {
    captureId: 'renderer',
    action: 'click',
    phase: 'result',
    commandId: 'command-1',
    changes: { 'renders.app': 2 },
    observedAt: '2026-11-16T00:00:00.010Z',
    elapsedMs: 10,
    removals: [],
  })
  assert.equal(result.commands.click, 1)
  assert.equal(result.captures[0].durationMs, 10)
  assert.equal(result.comparisonValidated, false)
  assert.equal(result.baselineStatus, 'not-established')
})

test('observed zero counters establish coverage once without inventing missing counters', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  journal.record('client', snapshot())
  journal.record('client', snapshot(), 'click', 'started', 'zero-command')
  journal.record('client', snapshot(), 'click', 'result', 'zero-command')
  const report = journal.report(true)
  assert.equal(report.observations[0].changes['ui.document.rootRemovals'], 0)
  assert.equal(report.observations[0].changes['executor.fullTaskListReads'], 0)
  assert.equal(Object.hasOwn(report.observations[0].changes, 'renders.unavailable'), false)
  assert.equal(Object.hasOwn(report.observations[0].changes, 'react.commitCount'), false)
  assert.deepEqual(report.observations[1].changes, {})
  assert.deepEqual(report.observations[2].changes, {})
  assert.equal(report.metrics['ui.document.rootRemovals'], 0)
})

test('late region coverage preserves zero at its first observation in either delivery order', () => {
  for (const reverse of [false, true]) {
    const journal = new DesktopPerformanceJournal(metadata)
    const early = snapshot()
    early.regions.document = { observed: false }
    const late = snapshot()
    late.durationMs = 20
    const frames = [early, late]
    if (reverse) frames.reverse()
    for (const frame of frames) journal.record('client', frame)
    const report = journal.report(true)
    assert.equal(report.complete, true)
    assert.equal(Object.hasOwn(report.observations[0].changes, 'ui.document.rootRemovals'), false)
    assert.equal(report.observations[1].changes['ui.document.rootRemovals'], 0)
    assert.equal(report.metrics['ui.document.rootRemovals'], 0)
  }
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

test('controlled replays remain recorded without hiding uninjected duplicates', () => {
  for (const injected of [0, 1]) {
    const journal = new DesktopPerformanceJournal(metadata)
    const value = snapshot()
    value.executor.duplicateDeliveries = 1
    value.executor.injectedDuplicateDeliveries = injected
    journal.record('client', value)
    const report = journal.report(true)
    assert.equal(report.metrics['executor.duplicateDeliveries'], 1)
    assert.deepEqual(report.violations, injected ? [] : ['executor.duplicateDeliveries'])
  }
})

test('counter regression retains rejected boundaries and values without certifying completeness', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  journal.record('client', snapshot())
  const next = snapshot()
  next.durationMs = 20
  next.renders.app = 1
  journal.record('client', next, 'click', 'result', 'command-1')
  const report = journal.report(true)
  assert.equal(report.complete, false)
  assert.equal(report.metrics['renders.app'], 2)
  assert.deepEqual(report.rejectedSnapshots, [
    {
      clientId: 'client',
      captureId: 'renderer',
      action: 'click',
      phase: 'result',
      commandId: 'command-1',
      durationMs: 20,
      previousDurationMs: 10,
      error: 'Performance counter reset: renders.app',
      regressions: [{ name: 'renders.app', previous: 2, current: 1 }],
    },
  ])
})

test('overlapping results retain every boundary in capture order without double counting', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  for (const time of [0, 40, 10, 30, 20]) {
    const value = snapshot()
    value.durationMs = time
    value.renders.app = time / 10
    value.removals = time >= 20 ? [{ atMs: 15, parent: 'document', testIds: ['old-row'] }] : []
    journal.record(
      'client',
      value,
      'overlap',
      time === 10 ? 'started' : 'result',
      `command-${time}`
    )
  }
  const report = journal.report(true)
  assert.equal(report.complete, true)
  assert.equal(report.metrics['renders.app'], 4)
  assert.deepEqual(
    report.observations.map(o => o.elapsedMs),
    [0, 10, 20, 30, 40]
  )
  assert.deepEqual(
    report.observations.map(o => o.changes['renders.app'] ?? 0),
    [0, 1, 1, 1, 1]
  )
  assert.equal(report.observations.flatMap(o => o.removals).length, 1)
  assert.equal(report.observations[2].removals[0].atMs, 15)
  assert.deepEqual(report.rejectedSnapshots, [])
})

test('sorting late results does not hide a real counter regression or reused capture epoch', () => {
  for (const changedEpoch of [false, true]) {
    const journal = new DesktopPerformanceJournal(metadata)
    const latest = snapshot()
    latest.durationMs = 30
    latest.renders.app = 2
    journal.record('client', latest)
    const late = snapshot()
    late.durationMs = 20
    late.renders.app = 3
    if (changedEpoch) late.startedAt = '2026-11-17T00:00:00.000Z'
    journal.record('client', late)
    const report = journal.report(true)
    assert.equal(report.complete, false)
    assert.equal(report.rejectedSnapshots.length, 1)
  }
})

test('operation totals retain later deltas without adding maximum gauges', () => {
  const journal = new DesktopPerformanceJournal(metadata)
  const initial = snapshot()
  initial.responsiveness = {
    supportedEntryTypes: ['longtask'],
    longTaskCount: 1,
    longTaskTotalMs: 80,
    longTaskMaxMs: 80,
    droppedEvents: 0,
  }
  initial.regions.document.addedSubtreeElements = 100
  initial.regions.document.removedSubtreeElements = 100
  initial.regions.document.maxAddedSubtreeElements = 100
  initial.regions.document.maxRemovedSubtreeElements = 100
  journal.record('client', initial)
  journal.record('client', { ...initial, durationMs: 11 }, 'click', 'started', 'smaller-update')
  const next = structuredClone(initial)
  next.durationMs = 12
  next.regions.document.addedSubtreeElements = 125
  next.regions.document.removedSubtreeElements = 125
  journal.record('client', next, 'click', 'result', 'smaller-update')
  const another = structuredClone(initial)
  another.captureId = 'another-renderer'
  another.responsiveness.longTaskTotalMs = 20
  another.responsiveness.longTaskMaxMs = 20
  another.regions.document.addedSubtreeElements = 7
  another.regions.document.removedSubtreeElements = 7
  another.regions.document.maxAddedSubtreeElements = 7
  another.regions.document.maxRemovedSubtreeElements = 7
  journal.record('another-client', another)
  const report = journal.report(true)
  assert.equal(report.complete, true)
  assert.equal(report.metrics['renderer.longTaskCount'], 2)
  assert.equal(report.metrics['renderer.longTaskTotalMs'], 100)
  assert.equal(report.metrics['renderer.longTaskMaxMs'], 80)
  assert.equal(report.observations[2].changes['ui.document.addedSubtreeElements'], 25)
  assert.equal(report.observations[2].changes['ui.document.removedSubtreeElements'], 25)
  assert.equal(report.metrics['ui.document.addedSubtreeElements'], 132)
  assert.equal(report.metrics['ui.document.removedSubtreeElements'], 132)
  assert.equal(report.metrics['ui.document.maxAddedSubtreeElements'], 100)
  assert.equal(report.metrics['ui.document.maxRemovedSubtreeElements'], 100)
  const missing = structuredClone(next)
  delete missing.regions.document.removedSubtreeElements
  const incomplete = new DesktopPerformanceJournal(metadata)
  incomplete.record('client', missing)
  assert.equal(incomplete.report(true).complete, false)
})
