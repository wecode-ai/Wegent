import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'

import {
  assertStartupProgressStages,
  startupSlowObservation,
  startupTimeoutObservation,
  waitForStartupProgressEvidence,
} from '../../e2e/desktop/modules/startup-splash-progress.mjs'

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
const progress = (stage: string) => ({
  step: 'startup-progress',
  status: 'started',
  stage,
  elapsedMs: 1,
})
const line = (event: Record<string, unknown>) =>
  `[startup] ${JSON.stringify(event)
    .replaceAll('"', "'")
    .replaceAll(/'([a-zA-Z]+)':/g, '$1: ')}\n`

const rendererProgress = {
  stage: {
    id: 'renderer',
    label: { en: 'Loading tasks and projects', zh: '加载任务与项目' },
  },
  index: 8,
  total: 9,
  startedAt: 100,
}
const rendererStep = 'Step 9 of 9 · Loading tasks and projects'

test('slow evidence uses real observations from the same renderer stage before timeout', () => {
  const slow = {
    progress: rendererProgress,
    stepCount: rendererStep,
    slowHidden: false,
    timeoutHidden: true,
    capturedAt: 200,
  }
  const current = { ...slow, slowHidden: true, timeoutHidden: false }
  assert.deepEqual(startupSlowObservation({ ...current, observations: [slow, current] }), slow)
  assert.equal(startupSlowObservation({ ...current, observations: [current] }), undefined)
  assert.equal(
    startupSlowObservation({
      ...current,
      observations: [{ ...slow, progress: { ...rendererProgress, startedAt: 1 } }],
    }),
    undefined
  )
  assert.equal(
    startupSlowObservation({ ...current, observations: [{ ...slow, stepCount: 'Step 8 of 9' }] }),
    undefined
  )
  assert.equal(
    startupSlowObservation({
      ...current,
      observations: [{ ...slow, progress: { stage: { id: 'core-dsh' } } }],
    }),
    undefined
  )
})

test('timeout evidence excludes the previous stage while its DOM update is in flight', () => {
  const previous = {
    progress: rendererProgress,
    stepCount: 'Step 8 of 9',
    timeoutHidden: false,
    capturedAt: 150,
  }
  const slow = {
    ...previous,
    stepCount: rendererStep,
    timeoutHidden: true,
    capturedAt: 200,
  }
  const timeout = { ...slow, timeoutHidden: false, capturedAt: 300 }
  const current = { ...timeout, observations: [previous, slow] }
  assert.equal(startupTimeoutObservation(current), undefined)
  assert.equal(
    startupTimeoutObservation({ ...current, observations: [previous, slow, timeout] }),
    timeout
  )
})

test.each([rendererStep, '第 9 步，共 9 步 · 加载任务与项目'])(
  'matches progress instead of stale live DOM for %s',
  stepCount => {
    const previous = {
      progress: rendererProgress,
      stepCount: 'Step 8 of 9 · Starting the local service',
      slowHidden: false,
      timeoutHidden: true,
    }
    const oldTimeout = { ...previous, slowHidden: true, timeoutHidden: false }
    const current = { ...previous, observations: [previous, oldTimeout] }
    assert.equal(startupSlowObservation(current), undefined)
    assert.equal(startupTimeoutObservation(current), undefined)

    const slow = { ...previous, stepCount }
    const timeout = { ...oldTimeout, stepCount }
    const loaded = { ...current, observations: [previous, oldTimeout, slow, timeout] }
    assert.equal(startupSlowObservation(loaded), slow)
    assert.equal(startupTimeoutObservation(loaded), timeout)
  }
)

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
