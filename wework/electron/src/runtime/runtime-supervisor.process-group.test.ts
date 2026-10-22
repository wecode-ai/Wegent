import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { terminateProcessTree } from './runtime-supervisor.js'

const proc = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn() }))

vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir: proc.readdir,
  readFile: proc.readFile,
}))

const GROUP_ID = 43210
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function exitedLeader(): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), {
    pid: GROUP_ID,
    exitCode: null as number | null,
    signalCode: null,
  })
  queueMicrotask(() => {
    child.exitCode = 0
    child.emit('exit', 0, null)
  })
  return child as unknown as ChildProcessWithoutNullStreams
}

function stat(state: string, groupId = GROUP_ID): string {
  // Linux comm fields can contain spaces and closing parentheses.
  return `43211 (worker (node)) ${state} 1 ${groupId} 0 0 0 0\n`
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  proc.readdir.mockReset().mockResolvedValue(['self', String(GROUP_ID + 1)])
  proc.readFile.mockReset().mockResolvedValue(stat('Z'))
  vi.spyOn(process, 'kill').mockReturnValue(true)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
})

describe('terminateProcessTree on Linux', () => {
  test('completes when only unreaped zombies remain in the process group', async () => {
    await expect(terminateProcessTree(exitedLeader(), 50)).resolves.toBeUndefined()

    expect(process.kill).not.toHaveBeenCalledWith(-GROUP_ID, 'SIGKILL')
  })

  test('still kills a running descendant when the leader and another child have exited', async () => {
    let killed = false
    proc.readdir.mockResolvedValue(['43211', '43212', '43213'])
    proc.readFile.mockImplementation(async (path: string) => {
      if (path.includes('43211')) return stat('Z')
      if (path.includes('43212')) return stat(killed ? 'Z' : 'S')
      return stat('S', GROUP_ID + 100)
    })
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') killed = true
      return true
    })

    await expect(terminateProcessTree(exitedLeader(), 50)).resolves.toBeUndefined()

    expect(process.kill).toHaveBeenCalledWith(-GROUP_ID, 'SIGKILL')
    expect(killed).toBe(true)
  })

  test('rejects shutdown while a live group member survives SIGKILL', async () => {
    proc.readFile.mockResolvedValue(stat('S'))

    await expect(terminateProcessTree(exitedLeader(), 50)).rejects.toThrow(
      `Timed out waiting for process group ${GROUP_ID} to exit`
    )
    expect(process.kill).toHaveBeenCalledWith(-GROUP_ID, 'SIGKILL')
  })

  test.each(['ENOENT', 'ESRCH'])(
    'ignores a process that disappears with %s while reading its stat file',
    async code => {
      proc.readFile.mockRejectedValue(Object.assign(new Error('gone'), { code }))

      await expect(terminateProcessTree(exitedLeader(), 50)).resolves.toBeUndefined()
    }
  )

  test('does not treat a procfs permission failure as successful shutdown', async () => {
    proc.readFile.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))

    await expect(terminateProcessTree(exitedLeader(), 50)).rejects.toMatchObject({
      code: 'EACCES',
    })
  })

  test('does not treat an unparseable process stat as successful shutdown', async () => {
    proc.readFile.mockResolvedValue('invalid stat')

    await expect(terminateProcessTree(exitedLeader(), 50)).rejects.toThrow(
      'Invalid process stat for PID 43211'
    )
  })

  test('keeps a permission-denied process group alive instead of accepting an empty scan', async () => {
    vi.mocked(process.kill).mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      return true
    })

    await expect(terminateProcessTree(exitedLeader(), 50)).rejects.toThrow(
      `Timed out waiting for process group ${GROUP_ID} to exit`
    )
    expect(process.kill).toHaveBeenCalledWith(-GROUP_ID, 'SIGKILL')
    expect(proc.readdir).not.toHaveBeenCalled()
  })
})
