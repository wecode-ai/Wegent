import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

interface ProcessLifecycle {
  processGroupHasLiveMembersFromLinuxStats: (
    stats: string[],
    processGroupId: number
  ) => boolean | null
  stopProcessGroup: (child: ChildProcess) => Promise<void>
}

const ownedProcessGroups = new Set<number>()

async function loadProcessLifecycle(): Promise<ProcessLifecycle> {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-lifecycle.mjs')
  ).href
  return import(/* @vite-ignore */ moduleUrl) as Promise<ProcessLifecycle>
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
  test('treats a Linux process group with only zombie members as exited', async () => {
    const { processGroupHasLiveMembersFromLinuxStats } = await loadProcessLifecycle()
    const stats = [
      '321 (wework) Z 1 321 321 0 -1 0',
      '442 (WebKit (Network)) X 1 321 321 0 -1 0',
      '900 (unrelated) S 1 900 900 0 -1 0',
    ]

    expect(processGroupHasLiveMembersFromLinuxStats(stats, 321)).toBe(false)
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
