import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { MainProcessLog } from './main-process-log.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MainProcessLog', () => {
  test('flushes console records and keeps the bootstrap path for diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-main-process-log-'))
    roots.push(root)
    const bootstrapPath = join(root, 'bootstrap.log')
    const currentPath = join(root, 'wework-main.log')
    const log = new MainProcessLog()

    await log.setPath(bootstrapPath)
    await log.write('stderr', 'early migration failure')
    await log.setPath(currentPath)
    await log.write('stderr', 'runtime startup failed')
    await log.flush()

    expect(log.startupBootstrapPath).toBe(bootstrapPath)
    expect(log.currentPath).toBe(currentPath)
    await expect(readFile(bootstrapPath, 'utf8')).resolves.toContain('early migration failure')
    await expect(readFile(currentPath, 'utf8')).resolves.toContain('runtime startup failed')
  })

  test('an unwritable bootstrap log cannot block flushing or moving to the runtime log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-main-process-log-'))
    roots.push(root)
    const blocked = join(root, 'file-instead-of-directory')
    await writeFile(blocked, 'not a directory')
    const log = new MainProcessLog()
    await log.setPath(join(blocked, 'bootstrap.log'))
    await expect(log.write('stderr', 'startup failed')).resolves.toBeUndefined()
    await expect(log.flush()).resolves.toBeUndefined()
    const current = join(root, 'runtime.log')
    await expect(log.setPath(current)).resolves.toBeUndefined()
    await log.write('stderr', 'recovery remains available')
    await log.flush()
    expect(await readFile(current, 'utf8')).toContain('recovery remains available')
  })
})
