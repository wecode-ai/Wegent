import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, test, vi } from 'vitest'
import { acquireReleaseStartup } from './release-startup-owner.js'

const native = vi.hoisted(() => ({ spawn: vi.fn(), realpath: vi.fn(), mkdir: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: native.spawn }))
vi.mock('node:fs/promises', () => ({ realpath: native.realpath, mkdir: native.mkdir }))

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
