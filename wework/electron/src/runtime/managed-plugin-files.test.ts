import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { copyManagedPlugin } from './managed-plugin-files.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('copies Windows trees concurrently without preserving linked directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-managed-copy-'))
  roots.push(root)
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  const shared = join(root, 'shared')
  await mkdir(join(source, 'nested'), { recursive: true })
  await mkdir(shared)
  await writeFile(join(source, 'nested', 'owned.txt'), 'owned content\n')
  await writeFile(join(shared, 'linked.txt'), 'linked content\n')
  await symlink(shared, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

  await copyManagedPlugin(source, destination, { platform: 'win32', concurrency: 2 })

  expect(await readFile(join(destination, 'nested', 'owned.txt'), 'utf8')).toBe('owned content\n')
  expect(await readFile(join(destination, 'linked', 'linked.txt'), 'utf8')).toBe('linked content\n')
  expect((await lstat(join(destination, 'linked'))).isSymbolicLink()).toBe(false)
})

test('rejects an invalid Windows copy concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-managed-copy-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await expect(
    copyManagedPlugin(source, join(root, 'destination'), { platform: 'win32', concurrency: 0 })
  ).rejects.toThrow('positive integer')
})
