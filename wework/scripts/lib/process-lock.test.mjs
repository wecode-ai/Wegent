import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'

import { acquireProcessLock } from './process-lock.mjs'

async function temporaryDirectory() {
  const directory = join(tmpdir(), `wework-process-lock-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  return directory
}

describe('process lock', () => {
  test('serializes concurrent owners', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    const releaseFirst = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })
    let acquiredSecond = false
    const second = acquireProcessLock(lockPath, { pollIntervalMs: 5 }).then(release => {
      acquiredSecond = true
      return release
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(acquiredSecond).toBe(false)

    await releaseFirst()
    const releaseSecond = await second
    expect(acquiredSecond).toBe(true)
    await releaseSecond()
    await rm(directory, { recursive: true, force: true })
  })

  test('reclaims a lock owned by a stopped process', async () => {
    const directory = await temporaryDirectory()
    const lockPath = join(directory, 'prepare.lock')
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }))

    const release = await acquireProcessLock(lockPath, { pollIntervalMs: 5 })

    await release()
    await rm(directory, { recursive: true, force: true })
  })
})
