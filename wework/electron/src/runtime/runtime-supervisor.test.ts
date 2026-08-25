import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RuntimeSupervisor } from './runtime-supervisor.js'

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
  await Promise.allSettled([...supervisors].map(supervisor => supervisor.stop()))
  supervisors.clear()
})

describe('RuntimeSupervisor', () => {
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
    await vi.waitFor(async () => {
      grandchildPid = Number(await readFile(pidPath, 'utf8'))
      expect(grandchildPid).toBeGreaterThan(0)
    })
    await supervisor.stop()
    await vi.waitFor(() => expect(processExists(grandchildPid)).toBe(false), {
      timeout: 3_000,
    })
  })
})

function track(supervisor: RuntimeSupervisor): RuntimeSupervisor {
  supervisors.add(supervisor)
  return supervisor
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
