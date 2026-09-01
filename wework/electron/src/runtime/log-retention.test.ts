import { mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { cleanupLogDirectories } from './log-retention.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('cleanupLogDirectories', () => {
  test('removes expired logs and oldest inactive logs until the total is bounded', async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), 'wework-log-retention-first-'))
    const secondDirectory = await mkdtemp(join(tmpdir(), 'wework-log-retention-second-'))
    const now = Date.UTC(2026, 7, 31)
    const expired = await logFile(firstDirectory, 'expired.log.bak', 40, now - 20 * DAY_MS)
    const oldest = await logFile(secondDirectory, 'oldest.log.1', 80, now - 2 * DAY_MS)
    const retained = await logFile(firstDirectory, 'retained.log', 80, now - DAY_MS)
    const active = await logFile(secondDirectory, 'active.log', 20, now)

    const result = await cleanupLogDirectories({
      directories: [firstDirectory, secondDirectory],
      now,
      policy: {
        activeFileGraceMs: 15 * 60 * 1000,
        maxAgeMs: 14 * DAY_MS,
        maxTotalBytes: 100,
      },
    })

    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(oldest)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(retained, 'utf8')).resolves.toHaveLength(80)
    await expect(readFile(active, 'utf8')).resolves.toHaveLength(20)
    expect(result).toMatchObject({
      failures: [],
      remainingBytes: 100,
      removedBytes: 120,
      removedFiles: 2,
      scannedFiles: 4,
    })
  })

  test('keeps recently modified files even when they temporarily exceed the cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-log-retention-active-'))
    const now = Date.UTC(2026, 7, 31)
    const active = await logFile(directory, 'active.log', 200, now)

    const result = await cleanupLogDirectories({
      directories: [directory],
      now,
      policy: {
        activeFileGraceMs: 15 * 60 * 1000,
        maxTotalBytes: 100,
      },
    })

    await expect(readFile(active, 'utf8')).resolves.toHaveLength(200)
    expect(result.remainingBytes).toBe(200)
    expect(result.removedFiles).toBe(0)
  })

  test('only manages root log files and never follows symbolic links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-log-retention-links-'))
    const outside = await mkdtemp(join(tmpdir(), 'wework-log-retention-outside-'))
    const now = Date.UTC(2026, 7, 31)
    const outsideLog = await logFile(outside, 'outside.log', 30, now - 20 * DAY_MS)
    const nonLog = await logFile(root, 'session.json', 30, now - 20 * DAY_MS)
    const nestedDirectory = join(root, 'nested')
    await mkdir(nestedDirectory)
    const nestedLog = await logFile(nestedDirectory, 'nested.log', 30, now - 20 * DAY_MS)
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await cleanupLogDirectories({
      directories: [root],
      now,
      policy: { maxAgeMs: 14 * DAY_MS },
    })

    await expect(readFile(outsideLog, 'utf8')).resolves.toHaveLength(30)
    await expect(readFile(nonLog, 'utf8')).resolves.toHaveLength(30)
    await expect(readFile(nestedLog, 'utf8')).resolves.toHaveLength(30)
    expect(result.scannedFiles).toBe(0)
  })
})

async function logFile(
  directory: string,
  name: string,
  bytes: number,
  modifiedAtMs: number
): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, 'x'.repeat(bytes))
  const modifiedAt = new Date(modifiedAtMs)
  await utimes(path, modifiedAt, modifiedAt)
  return path
}
