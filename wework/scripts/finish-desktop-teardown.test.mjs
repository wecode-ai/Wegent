import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DesktopPerformanceJournal } from '../e2e/desktop/performance-journal.mjs'
import {
  finishDesktopTeardown,
  persistDesktopCommandEvidence,
} from '../e2e/desktop/modules/finish-desktop-teardown.mjs'

async function fixture(t) {
  const resultDir = await mkdtemp(join(tmpdir(), 'desktop-final-outcome-'))
  t.after(() => rm(resultDir, { recursive: true, force: true }))
  const performance = new DesktopPerformanceJournal({ checkpoint: 'lifecycle-outcome' })
  t.mock.method(console, 'error', () => {})
  return {
    control: {
      performance,
      fatalError: null,
      modelRequests: [],
      httpRequests: [],
      commandHistory: [],
    },
    resultDir,
    testFailed: false,
    teardownFailures: [],
    cleanupError: undefined,
  }
}
const readReport = async f =>
  JSON.parse(await readFile(join(f.resultDir, 'performance.json'), 'utf8'))

test('a late controller assertion makes the final report fail and retains its original cause', async t => {
  const f = await fixture(t)
  const original = new Error('The real model request failed its assertion')
  f.teardownFailures.push({ error: original, label: 'desktop controller' })
  await assert.rejects(finishDesktopTeardown(f), error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [original])
    return true
  })
  assert.equal((await readReport(f)).functionalPassed, false)
  assert.match(await readFile(join(f.resultDir, 'failure.txt'), 'utf8'), /desktop controller/)
})

test('successful cleanup retains the functional outcome independently of metric coverage', async t => {
  const f = await fixture(t)
  const command = {
    id: 'operation-id',
    action: 'fill',
    selector: '[data-testid="composer"]',
    clientId: 'renderer-client',
    queuedAt: '2026-11-18T00:00:00.000Z',
    startedAt: '2026-11-18T00:00:00.010Z',
    resultReceivedAt: '2026-11-18T00:00:00.020Z',
    actionSucceeded: true,
  }
  f.control.commandHistory.push({
    ...command,
    value: 'private-input',
    text: 'private-expected-text',
    headers: { Authorization: 'private-authorization' },
    futurePayload: { connectorToken: 'private-token' },
  })
  await finishDesktopTeardown(f)
  assert.equal((await readReport(f)).functionalPassed, true)
  assert.equal((await readReport(f)).complete, false, 'No renderer metrics were provided')
  assert.deepEqual(JSON.parse(await readFile(join(f.resultDir, 'command-history.json'), 'utf8')), [
    command,
  ])
  await assert.rejects(readFile(join(f.resultDir, 'failure.txt')), { code: 'ENOENT' })
})

test('cleanup failure is preserved and cannot leave a passing report', async t => {
  const f = await fixture(t)
  f.cleanupError = new Error('Result cleanup failed')
  await assert.rejects(finishDesktopTeardown(f), error => error === f.cleanupError)
  assert.equal((await readReport(f)).functionalPassed, false)
})

test('an existing scenario failure remains primary and its evidence is not overwritten', async t => {
  const f = await fixture(t)
  f.testFailed = true
  f.teardownFailures.push({ label: 'desktop controller', error: new Error('Late failure') })
  f.cleanupError = new Error('Cleanup failure')
  await writeFile(join(f.resultDir, 'failure.txt'), 'Original scenario failure')
  await finishDesktopTeardown(f)
  assert.equal((await readReport(f)).functionalPassed, false)
  assert.equal(
    await readFile(join(f.resultDir, 'failure.txt'), 'utf8'),
    'Original scenario failure'
  )
})

test('unwritable performance evidence rejects the run rather than returning success', async t => {
  const f = await fixture(t)
  f.resultDir = join(f.resultDir, 'missing-directory')
  await assert.rejects(finishDesktopTeardown(f), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0].code, 'ENOENT')
    return true
  })
})

test('a late controller fatal error fails even after the controller close step settled', async t => {
  const f = await fixture(t)
  const original = new Error('Late model-service assertion')
  f.control.fatalError = original
  await assert.rejects(finishDesktopTeardown(f), error => {
    assert.deepEqual(error.errors, [original])
    return true
  })
  assert.equal((await readReport(f)).functionalPassed, false)
})

test('retains model requests and numeric HTTP evidence that arrived during teardown', async t => {
  const f = await fixture(t)
  await writeFile(join(f.resultDir, 'model-requests.json'), '[]')
  const lateRequest = { body: { model: 'fixture-model', input: 'Late synthetic fixture request' } }
  const http = { method: 'POST', path: '/v1/responses', status: 500, completed: true }
  f.control.modelRequests.push({
    ...lateRequest,
    authorization: 'private-model-authorization',
    headers: { 'x-api-key': 'private-model-key' },
  })
  f.control.httpRequests.push(http)
  f.teardownFailures.push({
    label: 'desktop controller',
    error: new Error('Late request rejected'),
  })
  await assert.rejects(finishDesktopTeardown(f), AggregateError)
  assert.deepEqual(JSON.parse(await readFile(join(f.resultDir, 'model-requests.json'), 'utf8')), [
    lateRequest,
  ])
  assert.deepEqual(JSON.parse(await readFile(join(f.resultDir, 'http-requests.json'), 'utf8')), [
    http,
  ])
  assert.equal((await readReport(f)).functionalPassed, false)
})

test('partial evidence survives a pending teardown without certifying success', async t => {
  const f = await fixture(t)
  f.control.commandHistory.push({
    id: 'pending-cleanup-operation',
    action: 'getRoute',
    value: 'private-value',
  })
  await persistDesktopCommandEvidence(f)
  assert.deepEqual(JSON.parse(await readFile(join(f.resultDir, 'command-history.json'), 'utf8')), [
    { id: 'pending-cleanup-operation', action: 'getRoute' },
  ])
  await assert.rejects(readFile(join(f.resultDir, 'performance.json')), { code: 'ENOENT' })
  f.teardownFailures.push({ label: 'process output', error: new Error('Evidence drainage failed') })
  await assert.rejects(finishDesktopTeardown(f), /process output/)
  assert.equal((await readReport(f)).functionalPassed, false)
})
