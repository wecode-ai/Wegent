import assert from 'node:assert/strict'
import test from 'node:test'

import { createXvfbDisplayAllocator } from '../e2e/desktop/xvfb-display.mjs'

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
