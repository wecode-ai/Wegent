import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  assertStartupProgressStages,
  waitForStartupProgressEvidence,
} from './startup-splash-progress.mjs'

const stages = [
  'launch',
  'shell',
  'components',
  'cli',
  'workspace',
  'services',
  'core-dsh',
  'renderer',
]
const progress = stage => ({ step: 'startup-progress', status: 'started', stage, elapsedMs: 1 })
const line = event =>
  `[startup] ${JSON.stringify(event)
    .replaceAll('"', "'")
    .replaceAll(/'([a-zA-Z]+)':/g, '$1: ')}\n`

test('startup evidence collapses adjacent repeated stages and rejects regressions', () => {
  const events = stages.flatMap(stage => [progress(stage), progress(stage)])
  assert.deepEqual(assertStartupProgressStages(events), stages)
  assert.throws(
    () => assertStartupProgressStages([...events, progress('components')]),
    /out of order/
  )
  assert.throws(
    () => assertStartupProgressStages(events.filter(event => event.stage !== 'workspace')),
    /workspace/
  )
})

test('durable startup verification waits for splash close from the new process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-startup-evidence-'))
  try {
    const logs = join(directory, 'logs')
    await mkdir(logs)
    const logPath = join(logs, 'wework-main.log')
    const completed =
      stages.map(stage => line(progress(stage))).join('') +
      line({ step: 'renderer-startup-ready', status: 'completed', elapsedMs: 2 })
    await writeFile(
      logPath,
      `${completed}${line({ step: 'startup-splash-close', status: 'completed', elapsedMs: 3 })}`
    )
    const afterBytes = Buffer.byteLength(await readFile(logPath))
    await appendFile(logPath, completed)
    let settled = false
    const verification = waitForStartupProgressEvidence({
      userDataDirectory: directory,
      resultDir: directory,
      afterBytes,
      timeoutMs: 2_000,
    }).then(value => {
      settled = true
      return value
    })
    await delay(80)
    assert.equal(
      settled,
      false,
      'The old process close or new renderer readiness completed verification early'
    )
    await appendFile(
      logPath,
      line({ step: 'startup-splash-close', status: 'completed', elapsedMs: 3 })
    )
    assert.deepEqual((await verification).stages, stages)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
