import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import diagnostics from './release-build-diagnostics.cjs'
import { buildRelease } from './build-release.mjs'

const { recordReleaseBuildStage } = diagnostics
const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function environment() {
  const path = await mkdtemp(join(tmpdir(), 'wework-release-diagnostics-'))
  directories.push(path)
  return { WEWORK_RELEASE_DIAGNOSTICS_DIR: path, WEWORK_RELEASE_ARCH: 'x64' }
}

async function records(env) {
  const directory = env.WEWORK_RELEASE_DIAGNOSTICS_DIR
  const [file] = await readdir(directory)
  return (await readFile(join(directory, file), 'utf8')).trim().split('\n').map(JSON.parse)
}

test('records stage completion and only the allowlisted notarization result', async () => {
  const env = await environment()
  const result = { status: 'Accepted', token: 'private-token', message: 'private-output' }
  await expect(recordReleaseBuildStage('notary-submit', async () => result, env)).resolves.toBe(
    result
  )
  const events = await records(env)
  expect(events.map(event => event.phase)).toEqual(['started', 'completed'])
  expect(events[1]).toMatchObject({ stage: 'notary-submit', arch: 'x64', notaryStatus: 'Accepted' })
  expect(events[1].elapsedMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(events)).not.toMatch(/private-/)
})

test('retains the original failure and safe process metadata without command output', async () => {
  const env = { ...(await environment()), WEWORK_ONLINE_UPDATE_BUILD: 'true' }
  const error = Object.assign(new Error('deadlineExceeded --password private-password'), {
    exitCode: 69,
    signal: 'SIGTERM',
    notaryStatus: 'In Progress',
  })
  await expect(
    recordReleaseBuildStage(
      'notary-submit',
      async () => {
        throw error
      },
      env
    )
  ).rejects.toBe(error)
  const events = await records(env)
  expect(events[1]).toMatchObject({
    phase: 'failed',
    failure: 'transport',
    exitCode: 69,
    signal: 'SIGTERM',
    package: 'online',
    notaryStatus: 'In Progress',
  })
  expect(JSON.stringify(events)).not.toMatch(/password|deadlineExceeded/)
})

test('leaves diagnostics disabled without an explicit output directory', async () => {
  await expect(recordReleaseBuildStage('installer', async () => 42, {})).resolves.toBe(42)
})

test('does not retain unexpected notarization output as status metadata', async () => {
  const env = await environment()
  await recordReleaseBuildStage('notary-submit', async () => ({ status: 'private-output' }), env)
  const events = await records(env)
  expect(events[1].notaryStatus).toBe('unknown')
  expect(JSON.stringify(events)).not.toContain('private-output')
})

test('distinguishes parallel package builds and preserves a failed builder exit', async () => {
  const env = { ...(await environment()), WEWORK_RELEASE_PLATFORM: 'macos' }
  const error = Object.assign(new Error('private-builder-output'), { exitCode: 1 })
  await expect(
    buildRelease(env, async (_command, _args, _cwd, overrides) => {
      if (overrides.WEWORK_ONLINE_UPDATE_BUILD === 'true') throw error
    })
  ).rejects.toBe(error)
  const events = await records(env)
  expect(events.filter(event => event.phase === 'started').map(event => event.package)).toEqual([
    'installer',
    'online',
  ])
  expect(events.find(event => event.phase === 'completed')).toMatchObject({ package: 'installer' })
  expect(events.find(event => event.phase === 'failed')).toMatchObject({
    package: 'online',
    exitCode: 1,
  })
  expect(JSON.stringify(events)).not.toContain('private-builder-output')
})
