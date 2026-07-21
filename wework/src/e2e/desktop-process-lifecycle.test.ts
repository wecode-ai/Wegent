import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

interface ProcessLifecycle {
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
  test('stops descendants that inherit an owned process group', async () => {
    const { stopProcessGroup } = await loadProcessLifecycle()
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
          'console.log(child.pid)',
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
