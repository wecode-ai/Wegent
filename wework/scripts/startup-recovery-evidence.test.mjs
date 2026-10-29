import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { compactDesktopE2EResult } from '../e2e/desktop/result-retention.mjs'

const execute = promisify(execFile)
const fixture = resolve(import.meta.dirname, 'fixtures/startup-recovery-evidence.cjs')
const recoveryModule = resolve(import.meta.dirname, '../e2e/desktop/modules/startup-recovery.mjs')
let root

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wework-recovery-evidence-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function verify(mode, evidence = {}) {
  // Load the actual Node module in its own process: browser URL transforms and
  // coverage counters must not alter code serialized into the child script.
  const { stdout } = await execute(
    process.execPath,
    [fixture, mode, root, recoveryModule, JSON.stringify(evidence)],
    { timeout: 5_000 }
  )
  return JSON.parse(stdout)
}

test.each([0, 250])(
  'never parses incomplete JSON with a %i ms child write delay',
  async writeDelayMs => {
    const result = await verify('race', { writeDelayMs })
    console.info('Recovery publication boundary trace:', JSON.stringify(result.events))

    expect(result.writerExitCode).toBe(0)
    expect(result.failure.message).toContain('Recovery verification failed')
    expect(result.events[0]).toMatchObject({ event: 'opened', bytes: 0 })
    expect(
      result.events.some(event => event.event === 'read-missing' && event.code === 'ENOENT')
    ).toBe(true)
    // Writer notifications and filesystem reads may interleave independently.
    const writerEvents = result.events.filter(event =>
      ['opened', 'written', 'published'].includes(event.event)
    )
    expect(writerEvents.map(event => event.event)).toEqual(['opened', 'written', 'published'])
    const reads = result.events.filter(event => event.event === 'read')
    expect(reads).toEqual([{ event: 'read', bytes: writerEvents[1].bytes }])
    expect(reads[0].bytes).toBeGreaterThan(0)
    expect(result.events.some(event => event.event === 'read' && event.bytes === 0)).toBe(false)
    expect(
      (await readdir(join(root, 'startup-recovery'))).some(file => file.endsWith('.tmp'))
    ).toBe(false)
  }
)

test('keeps malformed completed evidence fatal instead of retrying JSON errors', async () => {
  const result = await verify('malformed')

  expect(result.failure.name).toBe('SyntaxError')
})

test('retains only explicit recovery diagnostics when a child assertion fails', async () => {
  const evidence = { error: 'Recovery assertion failed' }
  const result = await verify('completed', evidence)

  expect(result.failure.message).toContain('Recovery assertion failed')
  expect(JSON.parse(await readFile(join(root, 'startup-reset-evidence.json'), 'utf8'))).toEqual(
    evidence
  )
  expect(await readFile(join(root, 'startup-reset-recovery.log'), 'utf8')).toBe(
    'app-state cleanup: failed\n'
  )
  const diagnostics = [
    'startup-reset-cleanup-failure.png',
    'startup-reset-evidence.json',
    'startup-reset-handoff.jsonl',
    'startup-reset-recovery.log',
    'startup-reset-runtime-confirmation.png',
    'startup-reset-user-confirmation.png',
  ]
  expect((await readdir(root)).sort()).toEqual([...diagnostics, 'startup-recovery'].sort())
  await compactDesktopE2EResult(root)
  expect((await readdir(root)).sort()).toEqual(diagnostics)
})

const successfulRecovery = {
  runtimeResetPreservesUserState: true,
  userResetPreservesTasksAndSessions: true,
  realRelaunches: 2,
  failedCleanupRetried: true,
}

test('accepts complete successful evidence and retains the required diagnostics', async () => {
  const result = await verify('completed', successfulRecovery)

  expect(result.evidence).toEqual(successfulRecovery)
  expect(await readFile(join(root, 'startup-reset-runtime-confirmation.png'), 'utf8')).toBe(
    'unit diagnostic fixture'
  )
})

test.each([
  { runtimeResetPreservesUserState: false },
  { userResetPreservesTasksAndSessions: false },
  { realRelaunches: 1 },
  { failedCleanupRetried: false },
])('keeps the recovery assertion fatal for %j', async override => {
  const result = await verify('completed', { ...successfulRecovery, ...override })

  expect(result.failure.name).toBe('AssertionError')
})
