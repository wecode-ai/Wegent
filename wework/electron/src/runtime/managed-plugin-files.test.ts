import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import { copyManagedPlugin } from './managed-plugin-files.js'

const fsControl = vi.hoisted(() => ({
  slowCopy: null as null | {
    suffix: string
    started: () => void
    wait: Promise<void>
  },
}))

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    cp: async (...args: Parameters<typeof original.cp>) => {
      if (fsControl.slowCopy && String(args[0]).endsWith(fsControl.slowCopy.suffix)) {
        fsControl.slowCopy.started()
        await fsControl.slowCopy.wait
      }
      return original.cp(...args)
    },
  }
})

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

test('waits for started sibling copies before reporting a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-managed-copy-'))
  roots.push(root)
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'a-slow.txt'), 'complete sibling content\n')
  await symlink(
    join(root, 'missing-target'),
    join(source, 'b-failure'),
    process.platform === 'win32' ? 'file' : undefined
  )

  let releaseCopy!: () => void
  const wait = new Promise<void>(resolve => {
    releaseCopy = resolve
  })
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => {
    signalStarted = resolve
  })
  fsControl.slowCopy = { suffix: 'a-slow.txt', started: signalStarted, wait }
  let settled = false
  try {
    const copy = copyManagedPlugin(source, destination, {
      platform: 'win32',
      concurrency: 3,
    }).finally(() => {
      settled = true
    })
    await started
    for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)

    releaseCopy()
    await expect(copy).rejects.toThrow()
    expect(await readFile(join(destination, 'a-slow.txt'), 'utf8')).toBe(
      'complete sibling content\n'
    )
  } finally {
    releaseCopy()
    fsControl.slowCopy = null
  }
})
