// @vitest-environment node

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

interface NativeIdentity {
  pid: number
  startedAt: number | null
  precisionMs: number
  parentPid?: number
  processGroupId?: number
  instanceToken?: string
}

interface ProcessLifecycle {
  processIsAlive: (pid: number) => boolean
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
  stopOwnedProcessTree: (
    child: ChildProcess,
    snapshot: unknown,
    options?: { readIdentity: (pid: number) => NativeIdentity | null }
  ) => Promise<void>
  windowsTaskkillArguments: (processId: number) => string[]
  waitForOwnedProcessExit: (
    snapshot: unknown,
    options: {
      timeoutMs?: number
      isAlive?: (pid: number) => boolean
      readIdentity?: (pid: number) => NativeIdentity | null
    }
  ) => Promise<void>
}

interface LocalHarnessCli {
  localHarnessCliPath: (binDirectory: string, name: string, platform?: NodeJS.Platform) => string
}

const ownedProcessGroups = new Set<number>()
const ownedProcesses = new Set<number>()
// These new process-group regressions exercise POSIX signals; Windows owns a
// separate taskkill tree path. The original platform coverage remains unchanged.
const posixTest = test.runIf(process.platform !== 'win32')

async function loadProcessIdentity() {
  return import(
    /* @vite-ignore */ pathToFileURL(
      resolve(import.meta.dirname, '../../e2e/desktop/process-identity.mjs')
    ).href
  )
}

async function sqliteProcesses(ignoreTerm = false, ignoreApplicationTerm = false) {
  const lifecycle = await loadProcessLifecycle()
  const home = await mkdtemp(join(tmpdir(), 'wework-owned-sqlite-review-'))
  const application = spawn(
    process.execPath,
    [
      resolve(import.meta.dirname, '../../e2e/desktop/fixtures/owned-sqlite-writer.mjs'),
      'application',
      home,
      String(ignoreTerm),
      String(ignoreApplicationTerm),
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  ownedProcessGroups.add(application.pid!)
  const [detail] = (await once(application, 'message')) as [
    { writerPid: number; writerStartedAt: number; applicationStartedAt: number },
  ]
  ownedProcesses.add(detail.writerPid)
  const snapshot = {
    applicationPid: application.pid!,
    platform: process.platform,
    capturedAt: Date.now(),
    degraded: [] as string[],
    processes: [
      {
        pid: application.pid!,
        parentPid: process.pid,
        startedAt: detail.applicationStartedAt,
        instanceToken: undefined as string | undefined,
      },
      {
        pid: detail.writerPid,
        parentPid: application.pid!,
        startedAt: detail.writerStartedAt,
        instanceToken: undefined as string | undefined,
      },
    ],
  }
  return {
    application,
    writerPid: detail.writerPid,
    snapshot,
    home,
    async cleanup() {
      for (const pid of [detail.writerPid, application.pid!]) {
        if (lifecycle.processIsAlive(pid)) process.kill(pid, 'SIGKILL')
      }
      await lifecycle.waitForOwnedProcessExit(
        { ...snapshot, capturedAt: Date.now(), degraded: [] },
        { timeoutMs: 3000, isAlive: lifecycle.processIsAlive }
      )
      await rm(home, { recursive: true, force: true })
      ownedProcesses.delete(detail.writerPid)
      ownedProcessGroups.delete(application.pid!)
    },
  }
}

async function loadDesktopStop() {
  const url = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/modules/shared.mjs')
  ).href
  return (await import(/* @vite-ignore */ url)).stopDesktopAppProcess
}

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
  test('native identity preserves timestamp precision and rejects unknown metadata', async () => {
    const { ownedProcessIdentityMatches } = await loadProcessIdentity()
    const expected = { pid: 42, startedAt: 1000.25 }
    expect(
      ownedProcessIdentityMatches(expected, { pid: 42, startedAt: 1000.25, precisionMs: 1 })
    ).toBe(true)
    expect(
      ownedProcessIdentityMatches(expected, { pid: 42, startedAt: 1000.5, precisionMs: 1 })
    ).toBe(false)
    expect(
      ownedProcessIdentityMatches(
        { ...expected, source: 'electron' },
        { pid: 42, startedAt: 1000, precisionMs: 1000 }
      )
    ).toBe(true)
    expect(
      ownedProcessIdentityMatches(
        { pid: 42, startedAt: 2001, source: 'electron' },
        { pid: 42, startedAt: 1000, precisionMs: 1000 }
      )
    ).toBe(false)
    expect(() =>
      ownedProcessIdentityMatches(expected, { pid: 42, startedAt: null, precisionMs: 1000 })
    ).toThrow('unknown creation time')
    expect(() =>
      ownedProcessIdentityMatches(expected, { pid: 42, startedAt: 1000, precisionMs: Infinity })
    ).toThrow('unknown creation time')
  })

  test.each(['linux', 'darwin'])(
    'native %s query reports stable seconds and propagates failed/malformed reads',
    async platform => {
      const { readNativeProcessIdentity } = await loadProcessIdentity()
      const started = 'Tue Oct 20 00:15:30 2026'
      const readLinux = () => ({
        instanceToken: '1234',
        parentPid: process.ppid,
        processGroupId: process.pid,
      })
      const execute = () => `${process.pid} ${process.ppid} ${process.pid} S ${started}\n`
      const identity = readNativeProcessIdentity(process.pid, { platform, readLinux, execute })
      expect(identity.startedAt).toBe(Date.parse(started))
      expect(identity.precisionMs).toBe(1000)
      if (platform === 'darwin') {
        expect(
          readNativeProcessIdentity(process.pid, {
            platform,
            readLinux,
            execute: () => `${process.pid} ${process.ppid} ${process.pid} Z ${started}\n`,
          })
        ).toBeNull()
      } else {
        expect(
          readNativeProcessIdentity(process.pid, { platform, readLinux: () => null, execute })
        ).toBeNull()
      }
      for (const code of ['EACCES', 'ENOENT', 'ETIMEDOUT']) {
        const failure = Object.assign(new Error(`query ${code}`), { code })
        expect(() =>
          readNativeProcessIdentity(process.pid, {
            platform,
            readLinux,
            execute: () => {
              throw failure
            },
          })
        ).toThrow('Could not verify process')
      }
      expect(() =>
        readNativeProcessIdentity(process.pid, { platform, readLinux, execute: () => 'malformed' })
      ).toThrow('Could not verify process')
      let reads = 0
      if (platform === 'linux') {
        expect(() =>
          readNativeProcessIdentity(process.pid, {
            platform,
            execute,
            readLinux: () => ({ ...readLinux(), instanceToken: String(reads++) }),
          })
        ).toThrow('Could not verify process')
      }
    }
  )

  posixTest(
    'native shutdown capture drains the complete real tree without a renderer client',
    async () => {
      const fixture = await sqliteProcesses(true)
      const { readNativeProcessIdentity } = await loadProcessIdentity()
      const moduleUrl = pathToFileURL(
        resolve(import.meta.dirname, '../../e2e/desktop/modules/shared.mjs')
      ).href
      const { createNativeShutdownCapture, stopDesktopAppProcess } = await import(
        /* @vite-ignore */ moduleUrl
      )
      try {
        const capture = createNativeShutdownCapture(fixture.application, fixture.home)
        const snapshot = await capture()
        expect(snapshot.degraded).toEqual([])
        expect(snapshot.processes.map((record: { pid: number }) => record.pid).sort()).toEqual(
          [fixture.application.pid!, fixture.writerPid].sort()
        )
        if (process.platform === 'linux')
          expect(
            snapshot.processes.every((record: { instanceToken?: string }) => record.instanceToken)
          ).toBe(true)
        Object.assign(fixture.application, { captureShutdownSnapshot: capture })
        await stopDesktopAppProcess(fixture.application)
        expect(readNativeProcessIdentity(fixture.writerPid)).toBeNull()
      } finally {
        await fixture.cleanup()
      }
    },
    20_000
  )

  posixTest(
    'native capture diagnostic write failure cannot replace the valid snapshot or leave writers alive',
    async () => {
      const fixture = await sqliteProcesses()
      const { processIsAlive } = await loadProcessLifecycle()
      const url = pathToFileURL(
        resolve(import.meta.dirname, '../../e2e/desktop/modules/shared.mjs')
      ).href
      const { createNativeShutdownCapture, stopDesktopAppProcess } = await import(
        /* @vite-ignore */ url
      )
      const diagnostics: NodeJS.ErrnoException[] = []
      try {
        Object.assign(fixture.application, {
          captureShutdownSnapshot: createNativeShutdownCapture(
            fixture.application,
            join(fixture.home, 'state_5.sqlite'),
            {
              reportError: (_label: string, error: NodeJS.ErrnoException) =>
                diagnostics.push(error),
            }
          ),
        })
        await stopDesktopAppProcess(fixture.application)
        expect(diagnostics[0]?.code).toBe('ENOTDIR')
        expect(processIsAlive(fixture.writerPid)).toBe(false)
      } finally {
        await fixture.cleanup()
      }
    },
    20_000
  )

  posixTest.each(['unknown time', 'query denied'])(
    'unverifiable writer identity retains its home and fails shutdown: %s',
    async invalid => {
      const fixture = await sqliteProcesses()
      const { readNativeProcessIdentity } = await loadProcessIdentity()
      const { stopOwnedProcessTree, processIsAlive } = await loadProcessLifecycle()
      const denied = new Error('identity query denied')
      const readIdentity = (pid: number) => {
        if (pid !== fixture.writerPid) return readNativeProcessIdentity(pid)
        if (invalid === 'query denied') throw denied
        return { pid, startedAt: null, precisionMs: 1000 }
      }
      try {
        const failure = await stopOwnedProcessTree(fixture.application, fixture.snapshot, {
          readIdentity,
        }).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(String(failure)).toContain(
          invalid === 'query denied' ? denied.message : 'unknown creation time'
        )
        expect(processIsAlive(fixture.writerPid)).toBe(true)
        await expect(access(fixture.home)).resolves.toBeUndefined()
      } finally {
        await fixture.cleanup()
      }
    },
    20_000
  )

  test.runIf(process.platform === 'linux')(
    'identity-aware waiting treats a reused kernel generation as exited without signaling it',
    async () => {
      const fixture = await sqliteProcesses()
      const { readNativeProcessIdentity } = await loadProcessIdentity()
      const { stopProcessGroup, waitForOwnedProcessExit, processIsAlive } =
        await loadProcessLifecycle()
      const writer = readNativeProcessIdentity(fixture.writerPid)
      fixture.snapshot.processes[1]!.instanceToken = writer.instanceToken
      let reads = 0
      try {
        await stopProcessGroup(fixture.application)
        await waitForOwnedProcessExit(fixture.snapshot, {
          timeoutMs: 250,
          readIdentity: pid => {
            if (pid !== fixture.writerPid) return readNativeProcessIdentity(pid)
            return {
              ...writer,
              instanceToken: reads++ === 0 ? writer.instanceToken : `${writer.instanceToken}-new`,
            }
          },
        })
        expect(processIsAlive(fixture.writerPid)).toBe(true)
      } finally {
        await fixture.cleanup()
      }
    },
    20_000
  )

  test('native capture rejects incomplete, cyclic, and changed application snapshots', async () => {
    const { captureOwnedProcessSnapshot } = await loadProcessIdentity()
    const started = 'Tue Oct 20 00:15:30 2026'
    const application = { pid: 42, startedAt: Date.parse(started) }
    const table = `42 7 42 S ${started}\n43 42 99 S ${started}\n88 7 88 S ${started}\n`
    const snapshot = captureOwnedProcessSnapshot(application, {
      platform: 'darwin',
      execute: () => table,
    })
    expect(snapshot.processes.map((record: { pid: number }) => record.pid)).toEqual([42, 43])
    expect(snapshot.degraded).toEqual([])
    expect(() =>
      captureOwnedProcessSnapshot(application, { platform: 'darwin', execute: () => 'malformed' })
    ).toThrow('incomplete')
    expect(() =>
      captureOwnedProcessSnapshot(application, {
        platform: 'darwin',
        execute: () => `42 43 42 S ${started}\n43 42 99 S ${started}\n`,
      })
    ).toThrow('cycle')
    expect(() =>
      captureOwnedProcessSnapshot(
        { ...application, startedAt: application.startedAt - 1000 },
        { platform: 'darwin', execute: () => table }
      )
    ).toThrow('changed identity')
    const denied = Object.assign(new Error('native read denied'), { code: 'EACCES' })
    expect(() =>
      captureOwnedProcessSnapshot(application, {
        platform: 'linux',
        execute: () => table,
        readLinux: () => {
          throw denied
        },
      })
    ).toThrow(denied)
    const timeout = Object.assign(new Error('native read timeout'), { code: 'ETIMEDOUT' })
    expect(() =>
      captureOwnedProcessSnapshot(application, {
        platform: 'darwin',
        execute: () => {
          throw timeout
        },
      })
    ).toThrow(timeout)
    expect(Object.keys(snapshot.processes[0]).sort()).toEqual([
      'parentPid',
      'pid',
      'processGroupId',
      'startedAt',
    ])
  })

  posixTest(
    'capture rejection and known group rejection preserve both original failures',
    async () => {
      const fixture = await sqliteProcesses()
      const stopDesktopAppProcess = await loadDesktopStop()
      const captureError = new Error('Native collection incomplete')
      const groupError = Object.assign(new Error('Known group rejected cleanup'), { code: 'EPERM' })
      Object.assign(fixture.application, {
        captureShutdownSnapshot: async () => {
          throw captureError
        },
      })
      const nativeKill = process.kill.bind(process)
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -fixture.application.pid! && signal === 'SIGTERM') throw groupError
        return nativeKill(pid, signal)
      })
      try {
        const failure = await stopDesktopAppProcess(fixture.application).catch(
          (error: unknown) => error
        )
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([captureError, groupError])
      } finally {
        kill.mockRestore()
        await fixture.cleanup()
      }
    },
    20_000
  )

  posixTest(
    'degraded shutdown snapshot stops the known group without trusting omitted writers',
    async () => {
      const { processIsAlive } = await loadProcessLifecycle()
      const stopDesktopAppProcess = await loadDesktopStop()
      const fixture = await sqliteProcesses()
      fixture.snapshot.degraded.push('system-process-table-failed')
      try {
        const failure = await stopDesktopAppProcess(fixture.application, {
          shutdownSnapshot: fixture.snapshot,
        }).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('complete owned process snapshot')
        expect(
          processIsAlive(fixture.application.pid!),
          'Known application group survived a rejected snapshot'
        ).toBe(false)
        expect(
          processIsAlive(fixture.writerPid),
          'A degraded snapshot must not authorize independent PID signals'
        ).toBe(true)
        await expect(access(fixture.home)).resolves.toBeUndefined()
      } finally {
        await fixture.cleanup()
      }
    },
    20_000
  )

  posixTest(
    'stale owned PID identity cannot signal the current SQLite writer or delay cleanup',
    async () => {
      const { processIsAlive } = await loadProcessLifecycle()
      const stopDesktopAppProcess = await loadDesktopStop()
      const fixture = await sqliteProcesses()
      fixture.snapshot.processes[1]!.startedAt -= 60_000
      try {
        await stopDesktopAppProcess(fixture.application, { shutdownSnapshot: fixture.snapshot })
        expect(
          processIsAlive(fixture.writerPid),
          'A different creation time must not authorize a PID signal'
        ).toBe(true)
        expect(processIsAlive(fixture.application.pid!)).toBe(false)
      } finally {
        await fixture.cleanup()
      }
    },
    20_000
  )

  posixTest.each([false, true])(
    'group rejection still escalates independent writers and retains every error: deny KILL=%s',
    async denyKill => {
      const { stopOwnedProcessTree, processIsAlive } = await loadProcessLifecycle()
      const fixture = await sqliteProcesses(true, true)
      const groupError = Object.assign(new Error('Owned group signal denied'), { code: 'EPERM' })
      const writerError = Object.assign(new Error('Owned writer KILL denied'), { code: 'EPERM' })
      const nativeKill = process.kill.bind(process)
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -fixture.application.pid! && signal === 'SIGTERM') throw groupError
        if (denyKill && pid === fixture.writerPid && signal === 'SIGKILL') throw writerError
        return nativeKill(pid, signal)
      })
      try {
        const failure = await stopOwnedProcessTree(fixture.application, fixture.snapshot).catch(
          (error: unknown) => error
        )
        if (denyKill) {
          expect(failure).toBeInstanceOf(AggregateError)
          expect((failure as AggregateError).errors).toEqual([groupError, writerError])
        } else {
          expect(failure).toBe(groupError)
          expect(
            processIsAlive(fixture.writerPid),
            'Group rejection skipped independent writer escalation'
          ).toBe(false)
        }
      } finally {
        kill.mockRestore()
        await fixture.cleanup()
      }
    },
    20_000
  )

  test.each([false, true])(
    'normal application shutdown stops independent SQLite writers before removing their home: ignores TERM=%s',
    async ignoreTerm => {
      const { processIsAlive, waitForOwnedProcessExit } = await loadProcessLifecycle()
      const moduleUrl = pathToFileURL(
        resolve(import.meta.dirname, '../../e2e/desktop/modules/shared.mjs')
      ).href
      const { stopDesktopAppProcess } = await import(/* @vite-ignore */ moduleUrl)
      const home = await mkdtemp(join(tmpdir(), 'wework-owned-sqlite-'))
      const application = spawn(
        process.execPath,
        [
          resolve(import.meta.dirname, '../../e2e/desktop/fixtures/owned-sqlite-writer.mjs'),
          'application',
          home,
          String(ignoreTerm),
        ],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
      ) as ChildProcess & { captureShutdownSnapshot?: () => Promise<unknown> }
      ownedProcessGroups.add(application.pid!)
      const [detail] = (await once(application, 'message')) as [
        { writerPid: number; writerStartedAt: number; applicationStartedAt: number },
      ]
      ownedProcesses.add(detail.writerPid)
      const snapshot = {
        applicationPid: application.pid,
        platform: process.platform,
        capturedAt: Date.now(),
        degraded: [],
        processes: [
          { pid: application.pid, parentPid: process.pid, startedAt: detail.applicationStartedAt },
          { pid: detail.writerPid, parentPid: application.pid, startedAt: detail.writerStartedAt },
        ],
      }
      application.captureShutdownSnapshot = async () => {
        expect(processIsAlive(application.pid!)).toBe(true)
        return snapshot
      }
      try {
        await stopDesktopAppProcess(application)

        expect(
          processIsAlive(detail.writerPid),
          'Owned Codex SQLite writer survived teardown'
        ).toBe(false)
        await rm(home, { recursive: true, force: true })
        await expect(access(home)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        for (const pid of [detail.writerPid, application.pid!]) {
          if (processIsAlive(pid)) process.kill(pid, 'SIGKILL')
        }
        await waitForOwnedProcessExit(snapshot, { timeoutMs: 3000, isAlive: processIsAlive })
        await rm(home, { recursive: true, force: true })
        ownedProcesses.delete(detail.writerPid)
        ownedProcessGroups.delete(application.pid!)
      }
    },
    20_000
  )

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

  test('preserves Windows application arguments containing spaces, quotes and trailing slashes', async () => {
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, '../../e2e/desktop/windows-owned-process.mjs')
    ).href
    const { windowsApplicationCommandLine } = await import(/* @vite-ignore */ moduleUrl)
    const executable = String.raw`C:\Program Files\Wework\wework.exe`
    expect(
      windowsApplicationCommandLine(executable, [
        '',
        'space value',
        '中文',
        'C:\\work\\',
        'say"hello',
        String.raw`before\"after`,
      ])
    ).toBe(
      String.raw`"C:\Program Files\Wework\wework.exe" "" "space value" "中文" "C:\work\\" "say\"hello" "before\\\"after"`
    )
    expect(() => windowsApplicationCommandLine(executable, ['bad\0argument'])).toThrow('NUL')
  })

  test.each(['degraded', 'unowned', 'missing identity', 'future identity', 'stale'])(
    'rejects a %s crash snapshot before signaling any process',
    async invalid => {
      const { crashOwnedProcessTree, stopOwnedProcessTree } = await loadProcessLifecycle()
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
        await expect(stopOwnedProcessTree({ pid: 42 } as ChildProcess, snapshot)).rejects.toThrow()
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
