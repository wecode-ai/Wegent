import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { describe, expect, test, vi } from 'vitest'

const fileSystemHooks = vi.hoisted(() => ({
  readFile: null,
  unlink: null,
  rmdir: null,
  rename: null,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    readFile: (...args) => (fileSystemHooks.readFile ?? actual.readFile)(...args),
    unlink: (...args) => (fileSystemHooks.unlink ?? actual.unlink)(...args),
    rmdir: (...args) => (fileSystemHooks.rmdir ?? actual.rmdir)(...args),
    rename: (...args) => (fileSystemHooks.rename ?? actual.rename)(...args),
  }
})

import { acquireProcessLock } from './process-lock.mjs'

const actualFileSystem = await vi.importActual('node:fs/promises')

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function ownerIdentity(lockPath) {
  try {
    const metadata = await actualFileSystem.stat(lockPath)
    return {
      device: metadata.dev,
      inode: metadata.ino,
      owner: metadata.isDirectory()
        ? (await actualFileSystem.readdir(lockPath)).sort()
        : await actualFileSystem.readFile(lockPath, 'utf8'),
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function temporaryDirectory() {
  const directory = join(tmpdir(), `wework-process-lock-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  return directory
}

describe('process lock', () => {
  test.each(['file', 'directory'])(
    'a late stale-%s observer cannot remove the replacement owner',
    async kind => {
      const directory = await temporaryDirectory()
      const lockPath = join(directory, 'prepare.lock')
      const ownerPath = kind === 'file' ? lockPath : join(lockPath, 'owner-stale.json')
      const staleOwner = JSON.stringify({ pid: 2_147_483_647, token: 'stale' })
      if (kind === 'directory') await mkdir(lockPath)
      await writeFile(ownerPath, staleOwner)
      const firstRead = deferred()
      const secondRead = deferred()
      const allowFirst = deferred()
      const allowSecond = deferred()
      const lateCleanup = deferred()
      let staleReads = 0
      let removals = 0
      let first
      let second
      fileSystemHooks.readFile = async (...args) => {
        const content = await actualFileSystem.readFile(...args)
        if (args[0] === ownerPath && content === staleOwner && staleReads < 2) {
          staleReads += 1
          if (staleReads === 1) {
            firstRead.resolve()
            await allowFirst.promise
          } else {
            secondRead.resolve()
            await allowSecond.promise
          }
        }
        return content
      }
      fileSystemHooks.unlink = async (...args) => {
        const removal = args[0] === ownerPath ? ++removals : null
        try {
          return await actualFileSystem.unlink(...args)
        } finally {
          if (removal === 2) lateCleanup.resolve()
        }
      }

      try {
        first = acquireProcessLock(lockPath, { pollIntervalMs: 5 })
        await firstRead.promise
        second = acquireProcessLock(lockPath, { pollIntervalMs: 5 })
        await secondRead.promise
        allowFirst.resolve()
        await first
        const activeOwner = await ownerIdentity(lockPath)
        expect(activeOwner).not.toBeNull()

        allowSecond.resolve()
        await lateCleanup.promise

        expect(await ownerIdentity(lockPath)).toEqual(activeOwner)
      } finally {
        allowFirst.resolve()
        allowSecond.resolve()
        if (first) await (await first)()
        if (second) await (await second)()
        fileSystemHooks.readFile = null
        fileSystemHooks.unlink = null
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('serializes concurrent owners', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    const releaseFirst = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
    let acquiredSecond = false
    const second = acquireProcessLock(lockPath, { pollIntervalMs: 5 }).then(release => {
      acquiredSecond = true
      return release
    })

    const observedOwner = deferred()
    fileSystemHooks.readFile = async (...args) => {
      const content = await actualFileSystem.readFile(...args)
      if (String(args[0]).startsWith(lockPath)) observedOwner.resolve()
      return content
    }
    try {
      await observedOwner.promise
      expect(acquiredSecond).toBe(false)

      await releaseFirst()
      const releaseSecond = await second
      expect(acquiredSecond).toBe(true)
      await releaseSecond()
    } finally {
      await releaseFirst()
      await (
        await second
      )()
      fileSystemHooks.readFile = null
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('keeps waiting when a legacy file becomes a directory before its owner is read', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }))
    const beforeRead = deferred()
    const allowRead = deferred()
    const readFinished = deferred()
    let paused = false
    let pending
    let releaseWinner
    fileSystemHooks.readFile = async (...args) => {
      if (args[0] !== lockPath || paused) return actualFileSystem.readFile(...args)
      paused = true
      beforeRead.resolve()
      await allowRead.promise
      try {
        return await actualFileSystem.readFile(...args)
      } finally {
        readFinished.resolve()
      }
    }
    try {
      pending = acquireProcessLock(lockPath, { pollIntervalMs: 5 }).then(
        release => ({ release }),
        error => ({ error })
      )
      await beforeRead.promise
      releaseWinner = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
      const activeOwner = await ownerIdentity(lockPath)

      allowRead.resolve()
      await readFinished.promise

      expect(await ownerIdentity(lockPath)).toEqual(activeOwner)
      await releaseWinner()
      const result = await pending
      expect(result.error).toBeUndefined()
      await result.release()
    } finally {
      allowRead.resolve()
      await releaseWinner?.()
      if (pending) await (await pending).release?.()
      fileSystemHooks.readFile = null
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reclaims a lock owned by a stopped process', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }))

    const release = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })

    await release()
    await rm(directory, { recursive: true, force: true })
  })

  test('a late directory release cannot remove the replacement owner', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    const releaseFirst = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
    const beforeRemoval = deferred()
    const allowRemoval = deferred()
    let canonicalRemovals = 0
    let releasingFirst
    let second
    fileSystemHooks.rmdir = async (...args) => {
      if (args[0] === lockPath && ++canonicalRemovals === 1) {
        beforeRemoval.resolve()
        await allowRemoval.promise
      }
      return actualFileSystem.rmdir(...args)
    }

    try {
      releasingFirst = releaseFirst()
      await beforeRemoval.promise
      expect(await actualFileSystem.readdir(lockPath)).toEqual([])
      await actualFileSystem.utimes(lockPath, new Date(0), new Date(0))
      second = acquireProcessLock(lockPath, { pollIntervalMs: 5 })
      await second
      const activeOwner = await ownerIdentity(lockPath)

      allowRemoval.resolve()
      await releasingFirst

      expect(await ownerIdentity(lockPath)).toEqual(activeOwner)
      expect((await actualFileSystem.readdir(lockPath)).length).toBe(1)
    } finally {
      allowRemoval.resolve()
      if (releasingFirst) await releasingFirst
      if (second) await (await second)()
      fileSystemHooks.rmdir = null
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reclaims a directory owned by a stopped process', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    await mkdir(lockPath)
    await writeFile(
      join(lockPath, 'owner-stale.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'stale' })
    )
    let release
    try {
      release = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
      expect(await actualFileSystem.readdir(lockPath)).not.toContain('owner-stale.json')
    } finally {
      await release?.()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reclaims an abandoned empty directory', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    await mkdir(lockPath)
    await actualFileSystem.utimes(lockPath, new Date(0), new Date(0))
    let release
    try {
      release = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
      expect((await actualFileSystem.readdir(lockPath)).length).toBe(1)
    } finally {
      await release?.()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('publishes after a permission-shaped collision disappears', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    const releaseFirst = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
    const firstOwner = await ownerIdentity(lockPath)
    let releaseSecond
    let attempts = 0
    fileSystemHooks.rename = async (...args) => {
      if (args[1] === lockPath && ++attempts === 1) {
        await releaseFirst()
        throw Object.assign(new Error('The previous directory disappeared'), { code: 'EPERM' })
      }
      return actualFileSystem.rename(...args)
    }
    try {
      releaseSecond = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
      expect(attempts).toBe(2)
      expect(await ownerIdentity(lockPath)).not.toEqual(firstOwner)
      expect((await actualFileSystem.readdir(lockPath)).length).toBe(1)
    } finally {
      await releaseFirst()
      await releaseSecond?.()
      fileSystemHooks.rename = null
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reports a persistent permission error on a vacant path and removes its private directory', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    const denied = Object.assign(new Error('Publishing is denied'), { code: 'EPERM' })
    let attempts = 0
    fileSystemHooks.rename = async (...args) => {
      if (args[1] !== lockPath) return actualFileSystem.rename(...args)
      attempts += 1
      throw denied
    }
    try {
      await expect(acquireProcessLock(lockPath, { pollIntervalMs: 5 })).rejects.toBe(denied)
      expect(attempts).toBe(2)
      expect(await actualFileSystem.readdir(directory)).toEqual([])
    } finally {
      fileSystemHooks.rename = null
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('allows at most one active owner across real Node processes', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    const journalPath = join(directory, 'critical-sections.jsonl')
    const workers = Array.from({ length: 3 }, (_, index) =>
      startLockWorker(lockPath, journalPath, index)
    )
    try {
      await Promise.all(workers.map(worker => worker.ready))
      for (const worker of workers) worker.process.stdin.end('start\n')
      const results = await Promise.all(workers.map(worker => worker.closed))
      for (const result of results) expect(result).toEqual({ code: 0, signal: null, stderr: '' })
      const events = (await actualFileSystem.readFile(journalPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      let active = 0
      let maximum = 0
      for (const event of events) {
        active += event.type === 'enter' ? 1 : -1
        maximum = Math.max(maximum, active)
        expect(active).toBeGreaterThanOrEqual(0)
      }
      expect(events).toHaveLength(18)
      expect(active).toBe(0)
      expect(maximum).toBe(1)
    } finally {
      for (const worker of workers) {
        if (worker.process.exitCode === null && worker.process.signalCode === null) {
          worker.process.kill('SIGKILL')
        }
      }
      await Promise.all(workers.map(worker => worker.closed))
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function startLockWorker(lockPath, journalPath, workerId) {
  const source = `
    import { appendFileSync } from 'node:fs'
    import { once } from 'node:events'
    const [moduleUrl, lockPath, journalPath, workerId] = process.argv.slice(1)
    const { acquireProcessLock } = await import(moduleUrl)
    process.stdout.write('ready\\n')
    await once(process.stdin, 'data')
    process.stdin.destroy()
    for (let round = 0; round < 3; round += 1) {
      const release = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
      try {
        appendFileSync(journalPath, JSON.stringify({ type: 'enter', workerId }) + '\\n')
        await new Promise(setImmediate)
        appendFileSync(journalPath, JSON.stringify({ type: 'exit', workerId }) + '\\n')
      } finally {
        await release()
      }
    }
  `
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      source,
      new URL('./process-lock.mjs', import.meta.url).href,
      lockPath,
      journalPath,
      String(workerId),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const ready = deferred()
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (stdout.includes('ready\n')) ready.resolve()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const closed = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, stderr: error.message }))
    child.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  return {
    process: child,
    closed,
    ready: Promise.race([
      ready.promise,
      closed.then(result => {
        throw new Error(`Lock worker exited before readiness: ${JSON.stringify(result)}`)
      }),
    ]),
  }
}
