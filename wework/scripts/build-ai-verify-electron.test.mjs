// @vitest-environment node

import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const { spawn, acquireProcessLock, releaseLock } = vi.hoisted(() => ({
  spawn: vi.fn(),
  acquireProcessLock: vi.fn(),
  releaseLock: vi.fn(),
}))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('./lib/process-lock.mjs', () => ({ acquireProcessLock }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.resetModules()
})

function stubPackageCommands({ failInstall = false } = {}) {
  acquireProcessLock.mockResolvedValue(releaseLock)
  spawn.mockImplementation((_command, args) => {
    const child = new EventEmitter()
    // The packaged build consumes its verified ZIP through package-app.mjs.
    // Downloading a second, unpacked development runtime must not be required.
    const installsRuntime = args.some(value => value.includes('prepare:electron'))
    const installsDependencies = args.some(value => value.includes('install'))
    queueMicrotask(() => {
      child.emit('exit', installsRuntime || (failInstall && installsDependencies) ? 1 : 0)
    })
    return child
  })
}

function expectedCommand(args) {
  return wrapWindowsScriptCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args)
}

test.each([false, true])(
  'builds from package inputs without installing a second Electron runtime (dependencies ready: %s)',
  async ready => {
    vi.stubEnv('WEWORK_ELECTRON_DEPENDENCIES_READY', ready ? 'true' : '')
    vi.stubEnv('WEWORK_E2E_PREBUILT_EXECUTOR_PATH', '/fixture/executor')
    vi.stubEnv('WEWORK_EXECUTOR_PATH', '/personal/executor')
    stubPackageCommands()

    await import('./build-ai-verify-electron.mjs')

    const commands = ready
      ? [['--dir', 'electron', 'run', 'build:package']]
      : [
          ['--dir', 'electron', 'install', '--frozen-lockfile'],
          ['--dir', 'electron', 'run', 'build:package'],
        ]
    expect(spawn).toHaveBeenCalledTimes(commands.length)
    expect(acquireProcessLock).toHaveBeenCalledTimes(ready ? 0 : 1)
    expect(releaseLock).toHaveBeenCalledTimes(ready ? 0 : 1)
    commands.forEach((args, index) => {
      const command = expectedCommand(args)
      expect(spawn.mock.calls[index].slice(0, 2)).toEqual([command.command, command.args])
    })
    const environment = spawn.mock.calls.at(-1)[2].env
    expect(environment.WEWORK_EXECUTOR_PATH).toMatch(/[/\\]fixture[/\\]executor$/)
    expect(environment.VITE_WEWORK_E2E).toBe('true')
    expect(environment.VITE_WEWORK_RELEASE_CHANNEL).toBe('stable')
  }
)

test('does not package after a frozen dependency installation fails', async () => {
  vi.stubEnv('WEWORK_ELECTRON_DEPENDENCIES_READY', '')
  stubPackageCommands({ failInstall: true })

  await expect(import('./build-ai-verify-electron.mjs')).rejects.toThrow('exited with code 1')

  const command = expectedCommand(['--dir', 'electron', 'install', '--frozen-lockfile'])
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0].slice(0, 2)).toEqual([command.command, command.args])
  expect(releaseLock).toHaveBeenCalledOnce()
})
