import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DesktopErrorCollector } from '../e2e/desktop/error-collector.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wework-error-collector-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'errors.jsonl')
  const log = join(root, 'app.log')
  writeFileSync(log, '')
  const collector = new DesktopErrorCollector(path, log)
  const record = (instanceId, sequence, source = 'collector', type = 'started', level = 'info') => {
    appendFileSync(path, JSON.stringify({ instanceId, sequence, source, type, level }) + '\n')
  }
  return { collector, record, path, log }
}

test('accounts for all errors exactly, supports phase marks and app restarts', t => {
  const { collector, record } = fixture(t)
  record('first', 1)
  const after = collector.mark()
  record('first', 2, 'renderer', 'uncaught-exception', 'error')
  record('second', 1)
  record('second', 2, 'network', 'request-failed', 'error')
  assert.throws(() => collector.assertErrors([], { after }), /Unexpected Wework errors/)
  collector.assertErrors(
    [
      { match: event => event.type === 'uncaught-exception' },
      { match: event => event.type === 'request-failed' },
    ],
    { after }
  )
  assert.deepEqual(collector.summary().assertionCoverage, {
    errors: 2,
    assertedErrors: 2,
    acknowledgedErrors: 0,
    unassertedErrors: 0,
  })
  assert.equal(collector.query({ source: 'renderer' }).length, 1)
  assert.throws(
    () => collector.assertErrors([{ match: event => event.type === 'missing' }]),
    /Unexpected error count/
  )
})

test('missing initialization, dropped records, duplicate records and truncated writes fail', t => {
  const { collector, record, path } = fixture(t)
  assert.throws(() => collector.assertHealthy(), /never started/)
  record('first', 2)
  assert.throws(() => collector.records(), /Missing or reordered/)
  writeFileSync(path, '')
  record('first', 1)
  record('first', 1)
  assert.throws(() => collector.records(), /Missing or reordered/)
  writeFileSync(path, '{"instanceId":')
  assert.throws(() => collector.records(), /Incomplete/)
})

test('persist failures fail health assertions even if the next record never arrives', t => {
  const { collector, record, log } = fixture(t)
  record('first', 1)
  appendFileSync(log, '[desktop-e2e-collector-failed]\n')
  assert.throws(() => collector.assertHealthy(), /failed to serialize or persist/)
})

test('required source coverage cannot pass because a source produced no errors', t => {
  const { collector, record } = fixture(t)
  record('first', 1)
  assert.throws(
    () => collector.assertErrors([], { sources: ['renderer'] }),
    /Missing error source: renderer/
  )
  record('first', 2, 'renderer', 'created')
  collector.assertErrors([], { sources: ['renderer'] })
  assert.throws(
    () => collector.assertErrors([], { source: 'misspelled-source' }),
    /Missing error source/
  )
  assert.throws(() => collector.assertErrors([], { after: -1 }), /nonnegative interval mark/)
  assert.throws(() => collector.assertErrors([], { after: 1000 }), /beyond the collected records/)
  assert.throws(() => collector.assertErrors([], { before: 1000 }), /beyond the collected records/)
  assert.throws(
    () => collector.assertErrors([], { after: 2, before: 0 }),
    /end must follow its start/
  )
})

test('an acknowledged checkpoint detects final write loss even if stderr evidence was lost', async t => {
  const { collector, record, path } = fixture(t)
  record('first', 1)
  const checkpoint = {
    enabled: true,
    instanceId: 'first',
    sequence: 2,
    failedWrites: 0,
    byteLength: statSync(path).size,
  }
  const control = { command: async () => JSON.stringify(checkpoint) }
  await assert.rejects(collector.assertCollectedErrors(control), /Missing acknowledged/)
  record('first', 2, 'collector', 'checkpoint')
  checkpoint.byteLength = statSync(path).size
  await collector.assertCollectedErrors(control)
  appendFileSync(path, '{')
  await collector.assertCollectedErrors(control)
  checkpoint.failedWrites = 1
  await assert.rejects(collector.assertCollectedErrors(control), /could not persist every/)
})

test('a current process acknowledgment cannot certify an earlier process after restart', async t => {
  const { collector, record, path } = fixture(t)
  record('first', 1)
  record('first', 2, 'main', 'started')
  const after = collector.mark()
  record('second', 1)
  record('second', 2, 'collector', 'checkpoint')
  const control = {
    command: async () =>
      JSON.stringify({
        enabled: true,
        instanceId: 'second',
        sequence: 2,
        failedWrites: 0,
        byteLength: statSync(path).size,
      }),
  }
  await assert.rejects(collector.assertCollectedErrors(control), /across collector instances/)
  await collector.assertCollectedErrors(control, [], { after })
  await assert.rejects(
    collector.assertCollectedErrors(control, [], { after, sources: ['main'] }),
    /Missing error source: main/
  )
})

test('assertion receipts distinguish unasserted errors, failed assertions and acknowledged coverage', async t => {
  const { collector, record, path } = fixture(t)
  record('first', 1)
  record('first', 2, 'renderer', 'injected', 'error')
  record('first', 3, 'renderer', 'unexpected', 'error')
  const expected = [{ match: event => event.type === 'injected' }]
  const options = { source: 'renderer', type: 'injected' }
  collector.assertErrors(expected, options)
  collector.assertErrors(expected, options)
  assert.throws(
    () => collector.assertErrors([], { source: 'renderer', type: 'unexpected' }),
    /Unexpected Wework errors/
  )
  assert.deepEqual(collector.summary().assertionCoverage, {
    errors: 2,
    assertedErrors: 1,
    acknowledgedErrors: 0,
    unassertedErrors: 1,
  })
  record('first', 4, 'collector', 'checkpoint')
  const checkpoint = {
    enabled: true,
    instanceId: 'first',
    sequence: 4,
    failedWrites: 0,
    byteLength: statSync(path).size,
  }
  await collector.assertCollectedErrors(
    { command: async () => JSON.stringify(checkpoint) },
    expected,
    options
  )
  const summary = collector.summary()
  assert.equal(summary.acknowledged, false)
  assert.deepEqual(summary.assertionCoverage, {
    errors: 2,
    assertedErrors: 1,
    acknowledgedErrors: 1,
    unassertedErrors: 1,
  })
  assert.equal(summary.assertions.length, 4)
  assert.equal(summary.assertions[2].passed, false)
  assert.deepEqual(summary.assertions[3].checkpoint, {
    instanceId: 'first',
    sequence: 4,
    byteLength: checkpoint.byteLength,
  })
  assert.deepEqual(summary.assertions[3].errors, [{ instanceId: 'first', sequence: 2 }])
})

test('assertion receipts retain record identities without copying failure details or descriptions', t => {
  const { collector, record, path } = fixture(t)
  record('first', 1)
  appendFileSync(
    path,
    JSON.stringify({
      instanceId: 'first',
      sequence: 2,
      source: 'runtime',
      type: 'injected',
      level: 'error',
      details: { message: 'synthetic-private-detail' },
    }) + '\n'
  )
  assert.throws(() =>
    collector.assertErrors([
      { match: () => true, count: 2, description: 'synthetic-private-description' },
    ])
  )
  const summary = collector.summary()
  assert.equal(summary.assertionCoverage.assertedErrors, 0)
  assert.equal(summary.assertionCoverage.unassertedErrors, 1)
  assert.doesNotMatch(JSON.stringify(summary.assertions), /synthetic-private/)
  assert.deepEqual(summary.assertions[0].errors, [{ instanceId: 'first', sequence: 2 }])
})
