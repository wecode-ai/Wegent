import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { reservePort } from './port-reservation.mjs'

test('reserves unique ports across parallel checkpoint processes', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-port-test-'))
  try {
    const ports = await Promise.all(Array.from({ length: 32 }, () => reservePort(registryDir)))
    assert.equal(new Set(ports).size, ports.length)
  } finally {
    await rm(registryDir, { recursive: true, force: true })
  }
})
