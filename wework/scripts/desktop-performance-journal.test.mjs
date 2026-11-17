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
  next.durationMs = 5
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
      durationMs: 5,
      previousDurationMs: 10,
      error: 'Performance counter reset: renders.app',
      regressions: [{ name: 'renders.app', previous: 2, current: 1 }],
    },
  ])
})
