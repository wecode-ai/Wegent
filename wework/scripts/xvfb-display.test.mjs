// @vitest-environment node

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  createXvfbDisplayAllocator,
  prepareXvfbSocketDirectory,
} from '../e2e/desktop/xvfb-display.mjs'

test('prepares one sticky shared socket directory before parallel X servers launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-x11-sockets-'))
  try {
    const directory = join(root, '.X11-unix')
    await Promise.all(Array.from({ length: 32 }, () => prepareXvfbSocketDirectory(directory)))
    const metadata = await stat(directory)
    assert.equal(metadata.isDirectory(), true)
    if (process.platform !== 'win32') assert.equal(metadata.mode & 0o1777, 0o1777)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preserves an existing socket directory permissions and ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-existing-x11-'))
  try {
    const directory = join(root, '.X11-unix')
    await mkdir(directory)
    await chmod(directory, 0o700)
    const before = await stat(directory)
    await prepareXvfbSocketDirectory(directory)
    const after = await stat(directory)
    assert.equal(after.mode, before.mode)
    assert.equal(after.uid, before.uid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reserves distinct displays before parallel X servers create their lock files', async () => {
  const allocate = createXvfbDisplayAllocator(() => false)
  const displays = await Promise.all(Array.from({ length: 32 }, async () => allocate()))

  assert.equal(new Set(displays).size, displays.length)
})

test('skips occupied displays and never reuses a checkpoint display after cleanup', () => {
  const occupied = new Set([99, 101])
  const allocate = createXvfbDisplayAllocator(number => occupied.has(number))

  assert.equal(allocate(), 100)
  occupied.delete(99)
  assert.equal(allocate(), 102)
  occupied.add(103)
  assert.equal(allocate(), 104)
})
