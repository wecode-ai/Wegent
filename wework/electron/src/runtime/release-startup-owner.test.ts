import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { acquireReleaseStartup } from './release-startup-owner.js'

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  realpath: vi.fn(),
  mkdir: vi.fn(),
  lstat: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawn: native.spawn }))
vi.mock('node:fs/promises', () => ({
  realpath: native.realpath,
  mkdir: native.mkdir,
  lstat: native.lstat,
}))
vi.mock('node:os', () => ({ userInfo: () => ({ homedir: '/native-home', uid: 7 }) }))

function processFixture() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  native.realpath.mockResolvedValue('/canonical/releases')
  native.mkdir.mockResolvedValue(undefined)
  native.lstat.mockResolvedValue({ isDirectory: () => true, uid: 7, mode: 0o40700 })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('first launch resolves missing descendants through the existing canonical ancestor', async () => {
  native.realpath.mockImplementation(async (path: string) => {
    if (path.endsWith('/missing/releases'))
      throw Object.assign(new Error('Absent'), { code: 'ENOENT' })
    if (path.endsWith('/missing')) throw Object.assign(new Error('Absent'), { code: 'ENOENT' })
    return '/canonical/base'
  })
  const child = processFixture()
  native.spawn.mockReturnValue(child)
  vi.stubEnv('TMPDIR', '/unrelated-temporary-path')
  const acquiring = acquireReleaseStartup('/alias/missing/releases', '/native/launcher', vi.fn())
  await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledOnce())
  const key = createHash('sha256').update('/canonical/base/missing/releases').digest('hex')
  expect(native.spawn.mock.calls[0]?.[1]).toEqual([
    '--startup-lock',
    `/native-home/.wegent/release-startup/${key}/startup.lock`,
  ])
  child.stdout.write('locked\n')
  const release = await acquiring
  const released = release()
  child.emit('close', 0)
  await released
})

test.each([
  { uid: 8, mode: 0o40700 },
  { uid: 7, mode: 0o40777 },
])('rejects an unprotected lock namespace (%j)', async metadata => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  native.lstat.mockResolvedValue({ isDirectory: () => true, ...metadata })
  await expect(acquireReleaseStartup('/release', '/native/launcher', vi.fn())).rejects.toThrow(
    'private and user-owned'
  )
  expect(native.spawn).not.toHaveBeenCalled()
})

test('canonical aliases wait on the same native lock without creating application data', async () => {
  const children = [processFixture(), processFixture()]
  native.spawn.mockReturnValueOnce(children[0]).mockReturnValueOnce(children[1])
  const first = acquireReleaseStartup('/one/alias', '/native/launcher', vi.fn())
  const second = acquireReleaseStartup('/another/alias', '/native/launcher', vi.fn())
  await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(2))
  expect(native.spawn.mock.calls[0]?.[1]).toEqual(native.spawn.mock.calls[1]?.[1])
  expect(native.mkdir.mock.calls.every(([path]) => !path.startsWith('/canonical/releases'))).toBe(
    true
  )
  for (const [index, acquiring] of [first, second].entries()) {
    children[index]!.stdout.write('locked\n')
    const release = await acquiring
    const releasing = release()
    expect(children[index]!.stdin.writableEnded).toBe(true)
    children[index]!.emit('close', 0)
    await releasing
  }
})

test('unexpected helper termination fails closed and cannot be released as a success', async () => {
  const child = processFixture()
  native.spawn.mockReturnValue(child)
  const lost = vi.fn()
  const acquiring = acquireReleaseStartup('/release', '/native/launcher', lost)
  await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledOnce())
  child.stdout.write('locked\n')
  const release = await acquiring
  child.emit('close', 0)
  expect(lost).toHaveBeenCalledOnce()
  await expect(release()).rejects.toThrow('Native release startup lock was lost')
})

test('a missing native launcher propagates the startup error', async () => {
  const child = processFixture()
  native.spawn.mockReturnValue(child)
  const lost = vi.fn()
  const acquiring = acquireReleaseStartup('/release', '/missing/launcher', lost)
  const rejected = expect(acquiring).rejects.toThrow('ENOENT')
  await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledOnce())
  child.emit('error', new Error('ENOENT'))
  child.emit('close', -2)
  await rejected
  expect(lost).not.toHaveBeenCalled()
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
})
