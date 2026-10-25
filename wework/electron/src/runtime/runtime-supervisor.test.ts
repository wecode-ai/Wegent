import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { RuntimeSupervisor, terminateProcessTree } from './runtime-supervisor.js'

vi.mock('node:fs/promises', { spy: true })

const crashThenStayAlive = `
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.argv[1]
let count = 0
try { count = Number(readFileSync(path, 'utf8')) } catch {}
count += 1
writeFileSync(path, String(count))
if (count < 3) setTimeout(() => process.exit(23), 20)
console.log('ready token=top-secret')
setInterval(() => {}, 1000)
`

const supervisors = new Set<RuntimeSupervisor>()

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled([...supervisors].map(supervisor => supervisor.stop()))
  supervisors.clear()
})

describe('RuntimeSupervisor', () => {
  test('stops when a Linux process group contains only orphaned dead members', async () => {
    await withLinuxProcessGroup(
      () => [linuxStat(12, 'Z'), linuxStat(13, 'X'), linuxStat(14, 'x')],
      async (child, kill) => {
        await terminateProcessTree(child, 100)

        expect(kill).toHaveBeenCalledWith(-42, 'SIGTERM')
        expect(kill).not.toHaveBeenCalledWith(-42, 'SIGKILL')
      }
    )
  })

  test('kills a live Linux group member before accepting its zombie state', async () => {
    await withLinuxProcessGroup(
      killed => [linuxStat(12, killed ? 'Z' : 'S')],
      async (child, kill) => {
        await terminateProcessTree(child, 100)

        expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL')
      }
    )
  })

  test('rejects when Linux process-group members cannot be inspected', async () => {
    await withLinuxProcessGroup(
      () => {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      },
      async child => {
        await expect(terminateProcessTree(child, 25)).rejects.toMatchObject({
          code: 'EACCES',
        })
      }
    )
  })

  test('kills a Linux child that appears after a zombie-only process-group scan', async () => {
    vi.useFakeTimers()
    let scans = 0
    await withLinuxProcessGroup(
      killed => {
        scans += 1
        return scans === 1
          ? [linuxStat(12, 'Z')]
          : [linuxStat(12, 'Z'), linuxStat(13, killed ? 'Z' : 'S')]
      },
      async (child, kill) => {
        const stopped = terminateProcessTree(child, 50)
        await vi.advanceTimersByTimeAsync(75)
        await stopped

        expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL')
      }
    )
  })

  test('does not accept a first zombie-only observation at the Linux shutdown deadline', async () => {
    vi.useFakeTimers()
    let scansAfterKill = 0
    await withLinuxProcessGroup(
      killed => {
        if (!killed) return [linuxStat(12, 'S')]
        scansAfterKill += 1
        return [linuxStat(12, scansAfterKill === 1 ? 'S' : 'Z')]
      },
      async (child, kill) => {
        const stopped = expect(terminateProcessTree(child, 25)).rejects.toThrow(
          'Timed out waiting for process group 42 to exit'
        )
        await vi.advanceTimersByTimeAsync(50)
        await stopped

        expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL')
      }
    )
  })

  test.each(['live', 'unknown'])(
    'resets Linux dead-member confirmation after a %s process-group observation',
    async observation => {
      vi.useFakeTimers()
      let scans = 0
      await withLinuxProcessGroup(
        killed => {
          if (!killed && scans === 2 && observation === 'live') {
            return [linuxStat(12, 'S')]
          }
          return [linuxStat(12, 'Z')]
        },
        async (child, kill) => {
          const stopped = terminateProcessTree(child, 50)
          await vi.advanceTimersByTimeAsync(75)
          await stopped

          expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL')
        },
        killed => {
          scans += 1
          if (!killed && scans === 2 && observation === 'unknown') {
            throw Object.assign(new Error('Permission denied'), { code: 'EPERM' })
          }
        }
      )
    }
  )

  test('restarts crashed processes with backoff and stops without another restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-supervisor-'))
    const counter = join(directory, 'count')
    const states: string[] = []
    const supervisor = track(
      new RuntimeSupervisor({
        command: process.execPath,
        args: ['--input-type=module', '-e', crashThenStayAlive, counter],
        name: 'restart-test',
        baseRestartDelayMs: 5,
        maxRestartDelayMs: 10,
        maxCrashes: 3,
        crashWindowMs: 5_000,
        stableAfterMs: 50,
        log: { path: join(directory, 'runtime.log') },
      })
    )
    supervisor.on('state', state => states.push(state))

    await supervisor.start()
    await vi.waitFor(async () => expect(await readFile(counter, 'utf8')).toBe('3'), {
      timeout: 3_000,
    })
    await vi.waitFor(() => expect(supervisor.state()).toBe('ready'))
    await supervisor.stop()
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(await readFile(counter, 'utf8')).toBe('3')
    expect(states).toContain('backoff')
    expect(supervisor.state()).toBe('stopped')
    expect(await readFile(join(directory, 'runtime.log'), 'utf8')).not.toContain('top-secret')
  })

  test('enters failed state after the crash threshold', async () => {
    const failed = vi.fn()
    const supervisor = track(
      new RuntimeSupervisor({
        command: process.execPath,
        args: ['-e', 'process.exit(9)'],
        name: 'crash-loop',
        baseRestartDelayMs: 5,
        maxCrashes: 1,
        crashWindowMs: 5_000,
      })
    )
    supervisor.on('failed', failed)

    await supervisor.start()
    await vi.waitFor(() => expect(supervisor.state()).toBe('failed'), {
      timeout: 3_000,
    })
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('crashed 2 times') })
    )
    await supervisor.stop()
  })

  test('cancels readiness work when the managed process exits during startup', async () => {
    let probeSignal: AbortSignal | undefined
    const supervisor = track(
      new RuntimeSupervisor({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(9), 20)'],
        name: 'failed-readiness',
        maxCrashes: 0,
        probe: (_child, signal) => {
          probeSignal = signal
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      })
    )
    await expect(supervisor.start()).rejects.toThrow('exited during startup')
    expect(probeSignal?.aborted).toBe(true)
  })

  test('rejects startup when the executable cannot be spawned', async () => {
    const supervisor = track(
      new RuntimeSupervisor({
        command: join(tmpdir(), 'wework-missing-runtime-executable'),
        name: 'missing-runtime',
        maxCrashes: 0,
      })
    )

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.waitFor(() => expect(supervisor.state()).toBe('failed'))
    await supervisor.stop()
  })

  test('stops the complete child process tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-process-tree-'))
    const pidPath = join(directory, 'grandchild.pid')
    const script = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      })
      writeFileSync(process.argv[1], String(child.pid))
      setInterval(() => {}, 1000)
    `
    const supervisor = track(
      new RuntimeSupervisor({
        command: process.execPath,
        args: ['-e', script, pidPath],
        name: 'process-tree',
      })
    )

    await supervisor.start()
    let grandchildPid = 0
    await vi.waitFor(
      async () => {
        grandchildPid = Number(await readFile(pidPath, 'utf8'))
        expect(grandchildPid).toBeGreaterThan(0)
      },
      { timeout: 3_000 }
    )
    await supervisor.stop()
    await vi.waitFor(() => expect(processIsAlive(grandchildPid)).toBe(false), {
      timeout: 3_000,
    })
  })

  test.skipIf(process.platform === 'win32')(
    'kills surviving process-group members after the leader exits',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-process-group-'))
      const pidPath = join(directory, 'grandchild.pid')
      const script = `
        const { spawn } = require('node:child_process')
        const childScript = [
          'process.on("SIGTERM", () => {})',
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid))',
          'setInterval(() => {}, 1000)',
        ].join('; ')
        spawn(
          process.execPath,
          ['-e', childScript, process.argv[1]],
          { stdio: 'ignore' }
        )
        setInterval(() => {}, 1000)
      `
      const supervisor = track(
        new RuntimeSupervisor({
          command: process.execPath,
          args: ['-e', script, pidPath],
          name: 'surviving-process-group-member',
          stopTimeoutMs: 100,
        })
      )

      await supervisor.start()
      let grandchildPid = 0
      await vi.waitFor(
        async () => {
          grandchildPid = Number(await readFile(pidPath, 'utf8'))
          expect(grandchildPid).toBeGreaterThan(0)
        },
        { timeout: 3_000 }
      )
      await supervisor.stop()

      await vi.waitFor(() => expect(processIsAlive(grandchildPid)).toBe(false), {
        timeout: 3_000,
      })
    }
  )
})

function track(supervisor: RuntimeSupervisor): RuntimeSupervisor {
  supervisors.add(supervisor)
  return supervisor
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(')')
      if (commandEnd === -1) return true
      const state = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[0]
      return state !== 'Z' && state !== 'X' && state !== 'x'
    } catch {
      // Keep waiting when the process state cannot be determined.
      return true
    }
  }
  return true
}

function linuxStat(pid: number, state: string): string {
  return `${pid} (child (with parentheses)) ${state} 1 42 0 0 0`
}

async function withLinuxProcessGroup(
  stats: (killed: boolean) => string[],
  check: (
    child: ChildProcessWithoutNullStreams,
    kill: MockInstance<typeof process.kill>
  ) => Promise<void>,
  inspect?: (killed: boolean) => void
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams
  let killed = false
  let snapshot: string[] = []
  const list = vi.spyOn(fsPromises, 'readdir').mockImplementation(async () => {
    snapshot = stats(killed)
    // Include an unrelated live group and a process that disappears during inspection.
    return ['1', ...snapshot.map(stat => stat.split(' ')[0]), '15'] as unknown as Awaited<
      ReturnType<typeof fsPromises.readdir>
    >
  })
  const read = vi.spyOn(fsPromises, 'readFile').mockImplementation(async path => {
    const pid = Number(String(path).split('/')[2])
    if (pid === 1) return '1 (init) S 0 1 0 0 0'
    const stat = snapshot.find(value => value.startsWith(`${pid} `))
    if (stat) return stat
    throw Object.assign(new Error('Process exited'), { code: 'ENOENT' })
  })
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) inspect?.(killed)
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0, null))
    if (signal === 'SIGKILL') killed = true
    return true
  })
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    await check(child, kill)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    kill.mockRestore()
    read.mockRestore()
    list.mockRestore()
  }
}
