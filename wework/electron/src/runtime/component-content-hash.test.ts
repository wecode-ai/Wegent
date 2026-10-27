import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

const reads = vi.hoisted(() => ({ active: 0, peak: 0 }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      reads.active += 1
      reads.peak = Math.max(reads.peak, reads.active)
      stream.once('close', () => {
        reads.active -= 1
      })
      return stream
    },
  }
})

import { hashComponentPath } from './component-content-hash.js'

test('bounds concurrent file reads while preserving the canonical digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-component-hash-'))
  try {
    const entries = Array.from({ length: 40 }, (_, index) => `${index}.txt`).sort((a, b) =>
      a.localeCompare(b)
    )
    await Promise.all(entries.map(name => writeFile(join(root, name), name)))
    const expected = createHash('sha256')
    for (const name of entries) {
      const contentHash = createHash('sha256').update(name).digest('hex')
      expected.update(`file:${name}\0${contentHash}\0`)
    }

    await expect(hashComponentPath(root)).resolves.toBe(expected.digest('hex'))
    expect(reads.peak).toBeGreaterThan(1)
    expect(reads.peak).toBeLessThanOrEqual(8)
    expect(reads.active).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports every scanned file relative to the component root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-component-hash-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'nested', 'b.txt'), 'b')
    const visited: string[] = []

    await hashComponentPath(root, file => visited.push(file))

    expect(visited.sort()).toEqual(['a.txt', join('nested', 'b.txt')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
