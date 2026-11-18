import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { E2EErrorLog, recordE2ERendererError } from './e2e-error-log.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

test('keeps complete redacted structured errors and independent restart identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'wework-error-journal-'))
  roots.push(root)
  const path = join(root, 'errors.jsonl')
  const first = new E2EErrorLog(path)
  first.record('renderer', 'failure', 'error', {
    message: 'Authorization: Bearer synthetic-secret',
    token: 'synthetic-token',
    stack: `Error\n${'x'.repeat(10_000)}`,
  })
  new E2EErrorLog(path)
  const text = readFileSync(path, 'utf8')
  const records = text
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(text).not.toContain('synthetic-secret')
  expect(text).not.toContain('synthetic-token')
  expect(records.map(record => record.sequence)).toEqual([1, 2, 1])
  expect(records[0].instanceId).not.toBe(records[2].instanceId)
  expect(records[1].details.stack).toHaveLength(10_006)
})

test('disabled collection does no IO and write failures are explicit without throwing', () => {
  const failed = vi.fn()
  new E2EErrorLog(undefined, failed).record('main', 'failure', 'error', {})
  expect(failed).not.toHaveBeenCalled()
  const root = mkdtempSync(join(tmpdir(), 'wework-error-journal-'))
  roots.push(root)
  const log = new E2EErrorLog(root, failed)
  expect(() => log.record('main', 'failure', 'error', {})).not.toThrow()
  expect(failed).toHaveBeenCalledTimes(2)
  expect(failed).toHaveBeenCalledWith('[desktop-e2e-collector-failed]\n')
  expect(log.checkpoint()).toMatchObject({ enabled: true, failedWrites: 3, sequence: 3 })
})

test('renderer reports use the explicit collector and preserve malformed errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'wework-browser-error-journal-'))
  roots.push(root)
  const path = join(root, 'errors.jsonl')
  const log = new E2EErrorLog(path)
  recordE2ERendererError(
    '[wework-e2e-error] ' +
      JSON.stringify({ type: 'unhandled-rejection', message: 'failed', status: 503 }),
    {},
    3,
    log
  )
  recordE2ERendererError('[wework-e2e-error] broken', {}, 3, log)
  const records = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(records.map(record => record.sequence)).toEqual([1, 2, 3])
  expect(records[1]).toMatchObject({
    source: 'renderer',
    type: 'unhandled-rejection',
    level: 'error',
    details: { status: 503 },
  })
  expect(records[2]).toMatchObject({
    source: 'renderer',
    type: 'renderer-error',
    level: 'error',
    details: { message: '[wework-e2e-error] broken' },
  })
  expect(log.checkpoint().failedWrites).toBe(0)
})
