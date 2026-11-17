// @vitest-environment node

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

interface ProcessLifecycle {
  processInstanceMatches: (
    expected: { Id: number; ProcessName: string; StartedAt: string },
    actual: { Id: number; ProcessName: string; StartedAt: string } | null
  ) => boolean
  processIsAliveFromLinuxStat: (stat: string) => boolean | null
  processGroupHasLiveMembersFromLinuxStats: (
    stats: string[],
    processGroupId: number
  ) => boolean | null
  stopProcessGroup: (child: ChildProcess) => Promise<void>
  crashOwnedProcessTree: (child: ChildProcess, snapshot: unknown) => Promise<void>
  windowsTaskkillArguments: (processId: number) => string[]
  waitForOwnedProcessExit: (
    snapshot: unknown,
    options: { timeoutMs?: number; isAlive: (pid: number) => boolean }
  ) => Promise<void>
}

interface LocalHarnessCli {
  localHarnessCliPath: (binDirectory: string, name: string, platform?: NodeJS.Platform) => string
}

const ownedProcessGroups = new Set<number>()
const ownedProcesses = new Set<number>()

async function loadProcessLifecycle(): Promise<ProcessLifecycle> {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-lifecycle.mjs')
  ).href
  return import(/* @vite-ignore */ moduleUrl) as Promise<ProcessLifecycle>
}

async function loadLocalHarnessCli(): Promise<LocalHarnessCli> {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/modules/local-harness-cli.mjs')
  ).href
  return import(/* @vite-ignore */ moduleUrl) as Promise<LocalHarnessCli>
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessToStop(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  return !isProcessRunning(pid)
}

async function readChildPid(parent: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    parent.once('error', reject)
    parent.stdout?.once('data', chunk => {
      const childPid = Number.parseInt(String(chunk).trim(), 10)
      if (Number.isInteger(childPid)) {
        resolvePromise(childPid)
        return
      }
      reject(new Error(`Invalid child pid: ${String(chunk)}`))
    })
  })
}

afterEach(() => {
  for (const processId of ownedProcesses) {
    try {
      process.kill(processId, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  ownedProcesses.clear()
  for (const processGroupId of ownedProcessGroups) {
    try {
      process.kill(-processGroupId, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  ownedProcessGroups.clear()
})

describe('desktop process lifecycle', () => {
  test('shutdown waits for owned writers even after the application exited', async () => {
    const { waitForOwnedProcessExit } = await loadProcessLifecycle()
    const snapshot = {
      applicationPid: 101,
      platform: process.platform,
      capturedAt: Date.now(),
      degraded: [],
      processes: [
        { pid: 101, parentPid: 1, startedAt: Date.now() - 1_000 },
        { pid: 102, parentPid: 101, startedAt: Date.now() - 1_000 },
      ],
    }
    let observations = 0
    await waitForOwnedProcessExit(snapshot, {
      isAlive: pid => pid === 102 && observations++ === 0,
    })
    expect(observations).toBe(2)
    await expect(
      waitForOwnedProcessExit(snapshot, { timeoutMs: 0, isAlive: pid => pid === 102 })
    ).rejects.toThrow('Owned application processes survived shutdown: 102')
  })

  test('distinguishes a surviving executor from a new process that reused its PID', async () => {
    const { processInstanceMatches } = await loadProcessLifecycle()
    const original = {
      Id: 321,
      ProcessName: 'wegent-executor',
      StartedAt: '2026-01-01T00:00:00.0000000Z',
    }

    expect(processInstanceMatches(original, { ...original })).toBe(true)
    expect(processInstanceMatches(original, null)).toBe(false)
    expect(
      processInstanceMatches(original, { ...original, StartedAt: '2026-01-01T00:01:00.0000000Z' })
    ).toBe(false)
    expect(processInstanceMatches(original, { ...original, ProcessName: 'powershell' })).toBe(false)
  })

  test('rejects incomplete process identity instead of treating it as an exited executor', async () => {
    const { processInstanceMatches } = await loadProcessLifecycle()
    const original = {
      Id: 321,
      ProcessName: 'wegent-executor',
      StartedAt: '2026-01-01T00:00:00.0000000Z',
    }

    expect(() => processInstanceMatches(original, { ...original, StartedAt: '' })).toThrow(
      'creation time'
    )
    expect(() => processInstanceMatches({ ...original, StartedAt: '' }, null)).toThrow(
      'creation time'
    )
  })
  test('treats Linux zombie and dead process states as exited', async () => {
    const { processIsAliveFromLinuxStat } = await loadProcessLifecycle()

    expect(processIsAliveFromLinuxStat('321 (wegent-executor) Z 1 321 321 0 -1 0')).toBe(false)
    expect(processIsAliveFromLinuxStat('321 (wegent-executor) X 1 321 321 0 -1 0')).toBe(false)
    expect(processIsAliveFromLinuxStat('321 (wegent-executor) S 1 321 321 0 -1 0')).toBe(true)
    expect(processIsAliveFromLinuxStat('invalid stat')).toBeNull()
  })

  test('treats a Linux process group with only zombie members as exited', async () => {
    const { processGroupHasLiveMembersFromLinuxStats } = await loadProcessLifecycle()
    const stats = [
      '321 (wework) Z 1 321 321 0 -1 0',
      '442 (WebKit (Network)) X 1 321 321 0 -1 0',
      '900 (unrelated) S 1 900 900 0 -1 0',
    ]

    expect(processGroupHasLiveMembersFromLinuxStats(stats, 321)).toBe(false)
  })

  test('terminates the complete Windows child process tree', async () => {
    const { windowsTaskkillArguments } = await loadProcessLifecycle()

    expect(windowsTaskkillArguments(321)).toEqual(['/PID', '321', '/T', '/F'])
  })

  test.each(['degraded', 'unowned', 'missing identity', 'future identity', 'stale'])(
    'rejects a %s crash snapshot before signaling any process',
    async invalid => {
      const { crashOwnedProcessTree } = await loadProcessLifecycle()
      const snapshot = {
        applicationPid: 42,
        platform: process.platform,
        capturedAt: Date.now(),
        degraded: [] as string[],
        processes: [
          { pid: 42, parentPid: 1, startedAt: 1 },
          { pid: 43, parentPid: 42, startedAt: 1 },
        ],
      }
      if (invalid === 'degraded') snapshot.degraded.push('system-process-table-failed')
      if (invalid === 'unowned') snapshot.processes[1]!.parentPid = 900
      if (invalid === 'missing identity') snapshot.processes[1]!.startedAt = 0
      if (invalid === 'future identity') snapshot.processes[1]!.startedAt = Date.now() + 60_000
      if (invalid === 'stale') snapshot.capturedAt -= 60_000
      const kill = vi.spyOn(process, 'kill')
      try {
        await expect(crashOwnedProcessTree({ pid: 42 } as ChildProcess, snapshot)).rejects.toThrow()
        expect(kill).not.toHaveBeenCalled()
      } finally {
        kill.mockRestore()
      }
    }
  )

  test('crashes an owned descendant in a separate process group without graceful termination', async () => {
    const { crashOwnedProcessTree } = await loadProcessLifecycle()
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const script = \"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\"",
          "const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })",
          "child.stdout.once('data', () => console.log(child.pid))",
          "process.on('SIGTERM', () => {})",
          'setInterval(() => {}, 1000)',
        ].join(';'),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    ownedProcessGroups.add(parent.pid!)
    const childPid = await readChildPid(parent)
    ownedProcesses.add(childPid)
    const kill = vi.spyOn(process, 'kill')
    try {
      await crashOwnedProcessTree(parent, {
        applicationPid: parent.pid,
        platform: process.platform,
        capturedAt: Date.now() - 1_000,
        degraded: [],
        processes: [
          { pid: parent.pid, parentPid: process.pid, startedAt: Date.now() - 500 },
          { pid: childPid, parentPid: parent.pid, startedAt: Date.now() - 500 },
        ],
      })
      expect(await waitForProcessToStop(childPid, 1_000)).toBe(true)
      expect(kill.mock.calls.some(([, signal]) => signal === 'SIGTERM')).toBe(false)
      if (process.platform !== 'win32') {
        const signals = kill.mock.calls.filter(([, signal]) => signal !== 0)
        expect(signals).toEqual([
          [parent.pid, 'SIGSTOP'],
          [childPid, 'SIGSTOP'],
          [childPid, 'SIGKILL'],
          [parent.pid, 'SIGKILL'],
        ])
      }
      ownedProcessGroups.delete(parent.pid!)
    } finally {
      kill.mockRestore()
    }
  })

  test('resolves npm harness shims with the native Windows extension', async () => {
    const { localHarnessCliPath } = await loadLocalHarnessCli()

    expect(localHarnessCliPath('D:\\repo\\node_modules\\.bin', 'claude', 'win32')).toBe(
      'D:\\repo\\node_modules\\.bin\\claude.cmd'
    )
    expect(localHarnessCliPath('/repo/node_modules/.bin', 'claude', 'linux')).toBe(
      '/repo/node_modules/.bin/claude'
    )
  })

  test('keeps waiting while a Linux process group has a live member', async () => {
    const { processGroupHasLiveMembersFromLinuxStats } = await loadProcessLifecycle()
    const stats = [
      '321 (wework) Z 1 321 321 0 -1 0',
      '442 (WebKitNetworkProcess) S 1 321 321 0 -1 0',
    ]

    expect(processGroupHasLiveMembersFromLinuxStats(stats, 321)).toBe(true)
    expect(processGroupHasLiveMembersFromLinuxStats(stats, 999)).toBeNull()
  })

  test('does not wait for a process group that is no longer signalable', async () => {
    const { stopProcessGroup } = await loadProcessLifecycle()
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -42 && signal === 0) {
        const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
        throw error
      }
      return true
    })

    try {
      await expect(
        stopProcessGroup({ pid: 42, exitCode: 0, signalCode: null } as ChildProcess)
      ).resolves.toBeUndefined()

      expect(kill).toHaveBeenCalledWith(-42, 'SIGTERM')
    } finally {
      kill.mockRestore()
    }
  })

  test('observes a process that exits while the exit listener is being installed', async () => {
    const { stopProcessGroup } = await loadProcessLifecycle()
    const child = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      once: vi.fn(function (this: { exitCode: number | null }) {
        this.exitCode = 0
        return this
      }),
      off: vi.fn(),
    } as unknown as ChildProcess
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -42 && signal === 0) {
        const error = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
        throw error
      }
      return true
    })

    try {
      await expect(stopProcessGroup(child)).resolves.toBeUndefined()
      expect(child.once).toHaveBeenCalledWith('exit', expect.any(Function))
      expect(child.off).toHaveBeenCalledWith('exit', expect.any(Function))
    } finally {
      kill.mockRestore()
    }
  })

  test.each([true, false])(
    'requires a native exit after a macOS teardown signal is denied: exits=%s',
    async exits => {
      const { stopProcessGroup } = await loadProcessLifecycle()
      let processId = process.pid
      // macOS inspects the real group after EPERM. Keep an owned live group
      // so this fixture represents a rejected signal rather than an absent group.
      if (process.platform === 'darwin') {
        const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        })
        expect(owned.pid).toBeTypeOf('number')
        processId = owned.pid!
        ownedProcessGroups.add(processId)
      }
      const child = Object.assign(new EventEmitter(), {
        pid: processId,
        exitCode: null as number | null,
        signalCode: null,
      })
      const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      let signalDenied = false
      vi.useFakeTimers()
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -processId && signal === 'SIGKILL') {
          signalDenied = true
          if (exits) {
            setTimeout(() => {
              child.exitCode = 0
              child.emit('exit', 0, null)
            }, 1)
          }
          throw denied
        }
        if (pid === -processId && signal === 0) throw denied
        if (pid === processId && signal === 0 && signalDenied)
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
        return true
      })
      try {
        const result = stopProcessGroup(child as unknown as ChildProcess).then(
          () => undefined,
          (error: unknown) => error
        )
        await vi.advanceTimersByTimeAsync(20_100)
        expect(await result).toBe(exits ? undefined : denied)
        expect(kill).toHaveBeenCalledWith(-processId, 'SIGKILL')
        expect(child.listenerCount('exit')).toBe(0)
      } finally {
        kill.mockRestore()
        vi.useRealTimers()
      }
    }
  )

  test('stops descendants that inherit an owned process group', async () => {
    const { stopProcessGroup } = await loadProcessLifecycle()
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const childScript = \"process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\"",
          "const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'ignore'] })",
          "child.stdout.once('data', () => console.log(child.pid))",
          'setInterval(() => {}, 1000)',
        ].join(';'),
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )
    expect(parent.pid).toBeTypeOf('number')
    ownedProcessGroups.add(parent.pid!)
    const childPid = await readChildPid(parent)

    await stopProcessGroup(parent)

    expect(await waitForProcessToStop(childPid, 1_000)).toBe(true)
    ownedProcessGroups.delete(parent.pid!)
  })
})
