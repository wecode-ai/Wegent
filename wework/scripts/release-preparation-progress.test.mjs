// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  releasePreparationProgress,
  prepareReleaseProcess,
  RELEASE_PREPARATION_PROGRESS_PREFIX,
  waitForReleasePreparation,
  spawnReleaseProcess,
} from '../electron/src/runtime/release-preparation-progress.mjs'

const event = (
  stage,
  { version = 'source', releaseId = 'source-preparation', phase = 'started' } = {}
) =>
  `2026-11-02T00:00:00.000Z [supervisor] ${JSON.stringify({ event: 'release-preparation-stage', version, releaseId, stage, phase })}\n`

test('reads only complete preparation stages for the selected release', () => {
  const log =
    event('macos-installation', { version: 'previous' }) +
    event('profile-copy') +
    event('components') +
    event('runtimes') +
    event('macos-installation', { releaseId: 'candidate' }) +
    event('profile-prepare').trimEnd()
  assert.deepEqual(releasePreparationProgress(log, 'source-preparation', 'source'), {
    phase: 'runtimes',
  })
  assert.deepEqual(releasePreparationProgress(log + '\n', 'source-preparation', 'source'), {
    phase: 'profile-prepare',
  })
})

test('rejects backwards stages within one log read', () => {
  assert.throws(
    () =>
      releasePreparationProgress(
        event('runtimes') + event('components'),
        'source-preparation',
        'source'
      ),
    /regressed/
  )
})

test('target progress uses framed stdout independently of diagnostic files', () => {
  const frame = (stage, releaseId = 'target-slot') =>
    RELEASE_PREPARATION_PROGRESS_PREFIX +
    JSON.stringify({
      event: 'release-preparation-stage',
      releaseId,
      version: 'target',
      stage,
    }) +
    '\n'
  const output =
    'An unrelated diagnostic with { invalid JSON\n' +
    frame('macos-installation', 'another-slot') +
    frame('profile-copy') +
    frame('runtimes') +
    frame('profile-prepare').trimEnd()
  assert.deepEqual(releasePreparationProgress(output, 'target-slot', 'target', 'stdout'), {
    phase: 'runtimes',
  })
  assert.deepEqual(releasePreparationProgress(output + '\n', 'target-slot', 'target', 'stdout'), {
    phase: 'profile-prepare',
  })
})

test.each(['ready', 'unknown'])(
  'rejects a reported %s stage before successful process exit',
  stage => {
    assert.throws(
      () => releasePreparationProgress(event(stage), 'source-preparation', 'source'),
      /regressed or is unknown/
    )
  }
)

test('runs the real target process without depending on a diagnostic journal', async () => {
  const frame =
    RELEASE_PREPARATION_PROGRESS_PREFIX +
    JSON.stringify({
      event: 'release-preparation-stage',
      releaseId: 'target-slot',
      version: 'target',
      stage: 'runtimes',
    }) +
    '\n'
  const result = await prepareReleaseProcess(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(frame)})`],
    {
      env: { ...process.env },
      progress: 'stdout',
      releaseId: 'target-slot',
      version: 'target',
      stop: async () => assert.fail('A successful target must not be stopped'),
    }
  )
  assert.equal(result.stdout, frame)
})

test.each(['journal', 'stdout'])(
  'allows total %s preparation beyond one budget while bounding every phase',
  async source => {
    let complete
    const preparation = new Promise(resolve => {
      complete = resolve
    })
    const stages = [
      'profile-copy',
      'components',
      'runtimes',
      'runtimes',
      'profile-prepare',
      'profile-prepare',
    ]
    let time = 0
    let stopped = false
    const result = await waitForReleasePreparation(
      preparation,
      async () => {
        const releaseId = source === 'stdout' ? 'target-slot' : 'source-preparation'
        const version = source === 'stdout' ? 'target' : 'source'
        const line = event(stages.shift(), { releaseId, version })
        const output =
          source === 'stdout'
            ? RELEASE_PREPARATION_PROGRESS_PREFIX + line.slice(line.indexOf('{'))
            : line
        return releasePreparationProgress(output, releaseId, version, source)
      },
      {
        now: () => time,
        sleep: async () => {
          time += 100_000
          if (stages.length === 0) complete('prepared')
        },
        stop: async () => {
          stopped = true
        },
      }
    )
    assert.ok(time > 300_000)
    assert.equal(result, 'prepared')
    assert.equal(stopped, false)
  }
)

test('keeps the last phase bounded until the process actually exits', async () => {
  let reject
  const preparation = new Promise((_, fail) => {
    reject = fail
  })
  preparation.child = { pid: 1 }
  let time = 0
  let stops = 0
  await assert.rejects(
    waitForReleasePreparation(preparation, async () => ({ phase: 'profile-prepare' }), {
      now: () => time,
      sleep: async () => {
        time += 100_000
      },
      stop: async child => {
        assert.equal(child, preparation.child)
        stops++
        reject(new Error('stopped'))
      },
    }),
    /phase=profile-prepare, elapsedMs=300000/
  )
  assert.equal(stops, 1)
})

test('preserves the original source process failure', async () => {
  const original = new Error('source preparation failed with original stderr')
  const preparation = Promise.reject(original)
  await assert.rejects(
    waitForReleasePreparation(preparation, async () => ({ phase: 'profile-prepare' }), {
      stop: async () => {},
    }),
    error => error === original
  )
})

test('a buffer failure still stops its live preparation owner', async () => {
  const preparation = spawnReleaseProcess(
    process.execPath,
    ['-e', "process.stdout.write('oversized');setInterval(() => {}, 1000)"],
    { env: { ...process.env }, maxBuffer: 2 }
  )
  let stopped = false
  await assert.rejects(
    waitForReleasePreparation(preparation, async () => ({ phase: 'preparing' }), {
      stop: async child => {
        assert.equal(child, preparation.child)
        stopped = true
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGKILL')
        await exited
      },
    }),
    /buffer limit/
  )
  assert.equal(stopped, true)
})
