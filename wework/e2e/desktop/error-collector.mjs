import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as pollInterval } from 'node:timers/promises'

/** Reads the complete journal on demand, including records from app restarts. */
export class DesktopErrorCollector {
  constructor(path, appLogPath) {
    this.path = path
    this.appLogPath = appLogPath
    this.assertions = []
    writeFileSync(path, '', { mode: 0o600 })
  }

  /** @param {{ byteLength?: number, allowPending?: boolean }} [options] */
  records({ byteLength, allowPending = false } = {}) {
    const bytes = readFileSync(this.path)
    if (byteLength !== undefined)
      assert.ok(bytes.length >= byteLength, 'Acknowledged error journal was truncated')
    let text = bytes.subarray(0, byteLength).toString('utf8')
    if (allowPending && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
    assert.ok(!text || text.endsWith('\n'), 'Incomplete E2E error journal record')
    const sequences = new Map()
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const entry = JSON.parse(line)
        assert.equal(typeof entry.instanceId, 'string', 'Missing collector instance identity')
        assert.equal(
          entry.sequence,
          (sequences.get(entry.instanceId) ?? 0) + 1,
          `Missing or reordered error records for ${entry.instanceId}`
        )
        if (!sequences.has(entry.instanceId)) {
          assert.equal(entry.source, 'collector')
          assert.equal(entry.type, 'started')
        }
        sequences.set(entry.instanceId, entry.sequence)
        return entry
      })
  }

  mark() {
    return this.records({ allowPending: true }).length
  }

  summary() {
    const records = this.records()
    const counts = new Map()
    for (const { source, type, level } of records) {
      const key = JSON.stringify([source, type, level])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const errors = records.filter(entry => entry.level === 'error')
    const identity = entry => JSON.stringify([entry.instanceId, entry.sequence])
    const asserted = new Set()
    const acknowledged = new Set()
    for (const receipt of this.assertions.filter(receipt => receipt.passed)) {
      for (const entry of receipt.errors) {
        asserted.add(identity(entry))
        if (receipt.checkpoint) acknowledged.add(identity(entry))
      }
    }
    const assertedErrors = errors.filter(entry => asserted.has(identity(entry))).length
    return {
      records: records.length,
      assertions: this.assertions,
      assertionCoverage: {
        errors: errors.length,
        assertedErrors,
        acknowledgedErrors: errors.filter(entry => acknowledged.has(identity(entry))).length,
        unassertedErrors: errors.length - assertedErrors,
      },
      acknowledged: false,
      groups: [...counts].map(([key, count]) => {
        const [source, type, level] = JSON.parse(key)
        return { source, type, level, count }
      }),
    }
  }

  query({ after = 0, before, source, type, level, byteLength } = {}) {
    return selectRecords(this.records({ byteLength }), { after, before, source, type, level })
  }

  assertHealthy({ sources = [], byteLength, instanceId } = {}) {
    const records = this.records({ byteLength })
    assert.ok(records.length > 0, 'Electron error collector never started')
    assert.ok(
      !records.some(
        entry =>
          entry.type === 'output-not-observed' &&
          (instanceId === undefined || entry.instanceId === instanceId)
      ),
      'Worker output collection is incomplete'
    )
    for (const source of sources) {
      assert.ok(
        records.some(
          entry =>
            entry.source === source && (instanceId === undefined || entry.instanceId === instanceId)
        ),
        `Missing error source: ${source}`
      )
    }
    assert.ok(
      !readFileSync(this.appLogPath, 'utf8').includes('[desktop-e2e-collector-failed]'),
      'E2E error collector failed to serialize or persist an event'
    )
    return records
  }

  /** Every matching event must be accounted for exactly once; no ignore list. */
  assertErrors(expected = [], options = {}) {
    return this.#assertErrors(expected, options, null)
  }

  #assertErrors(expected, options, checkpoint) {
    assert.ok(
      Number.isSafeInteger(options.after ?? 0) && (options.after ?? 0) >= 0,
      'Error assertions require a nonnegative interval mark'
    )
    const sources = options.sources ?? []
    assert.ok(Array.isArray(sources), 'Required error sources must be an array')
    const records = this.assertHealthy({
      ...options,
      sources: options.source === undefined ? sources : [...sources, options.source],
    })
    assert.ok(
      (options.after ?? 0) <= records.length,
      'Error interval mark is beyond the collected records'
    )
    assert.ok(
      options.before === undefined ||
        (Number.isSafeInteger(options.before) && options.before >= (options.after ?? 0)),
      'Error interval end must follow its start'
    )
    assert.ok(
      (options.before ?? records.length) <= records.length,
      'Error interval end is beyond the collected records'
    )
    const errors = selectRecords(records, { ...options, level: 'error' })
    const receipt = {
      after: options.after ?? 0,
      before: options.before ?? records.length,
      source: options.source ?? null,
      type: options.type ?? null,
      expectedCounts: expected.map(entry => entry.count ?? 1),
      checkpoint,
      errors: errors.map(({ instanceId, sequence }) => ({ instanceId, sequence })),
      passed: false,
    }
    try {
      const remaining = [...errors]
      for (const { match, count = 1, description } of expected) {
        assert.equal(typeof match, 'function', 'An error expectation needs a predicate')
        assert.ok(Number.isSafeInteger(count) && count > 0, 'Expected count must be positive')
        const matches = remaining.filter(match)
        assert.equal(matches.length, count, description ?? 'Unexpected error count')
        for (const entry of matches) remaining.splice(remaining.indexOf(entry), 1)
      }
      assert.deepEqual(remaining, [], 'Unexpected Wework errors')
      receipt.passed = true
      return errors
    } finally {
      this.assertions.push(receipt)
    }
  }

  async assertCollectedErrors(control, expected = [], options = {}) {
    const checkpoint = JSON.parse(await control.command('getErrorCollectionCheckpoint', 'body'))
    assert.equal(checkpoint.enabled, true, 'Electron error collector is disabled')
    assert.equal(checkpoint.failedWrites, 0, 'Electron could not persist every error record')
    assert.ok(
      Number.isSafeInteger(checkpoint.byteLength) && checkpoint.byteLength > 0,
      'Missing committed error journal offset'
    )
    const records = this.records({ byteLength: checkpoint.byteLength })
    const index = records.findIndex(
      entry =>
        entry.instanceId === checkpoint.instanceId &&
        entry.sequence === checkpoint.sequence &&
        entry.source === 'collector' &&
        entry.type === 'checkpoint'
    )
    assert.ok(index >= 0, 'Missing acknowledged error collection checkpoint')
    assert.ok(
      records
        .slice(options.after ?? 0, index + 1)
        .every(entry => entry.instanceId === checkpoint.instanceId),
      'Cannot certify collection across collector instances; assert before restarting and mark the new interval'
    )
    return this.#assertErrors(
      expected,
      {
        ...options,
        before: index + 1,
        byteLength: checkpoint.byteLength,
        instanceId: checkpoint.instanceId,
      },
      {
        instanceId: checkpoint.instanceId,
        sequence: checkpoint.sequence,
        byteLength: checkpoint.byteLength,
      }
    )
  }

  async waitForRecord(match, { after = 0, timeoutMs }) {
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'A positive step timeout is required')
    const deadline = Date.now() + timeoutMs
    while (true) {
      const record = this.records({ allowPending: true }).slice(after).find(match)
      if (record) return record
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Timed out waiting for an E2E error record')
      await pollInterval(Math.min(25, remaining))
    }
  }
}

function selectRecords(records, { after = 0, before, source, type, level } = {}) {
  return records
    .slice(after, before)
    .filter(
      entry =>
        (source === undefined || entry.source === source) &&
        (type === undefined || entry.type === type) &&
        (level === undefined || entry.level === level)
    )
}
