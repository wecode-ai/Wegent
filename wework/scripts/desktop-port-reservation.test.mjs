import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test } from 'vitest'

import { reservePort } from '../e2e/desktop/port-reservation.mjs'

test('reserves unique ports across parallel checkpoint processes', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-port-test-'))
  try {
    const ports = await Promise.all(Array.from({ length: 32 }, () => reservePort(registryDir)))
    assert.equal(new Set(ports).size, ports.length)
    if (process.platform === 'linux') {
      const [first, last] = (await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8'))
        .trim()
        .split(/\s+/)
        .map(Number)
      assert.ok(ports.every(port => port < first || port > last))
    }
  } finally {
    await rm(registryDir, { recursive: true, force: true })
  }
})

test('reserves bindable service ports outside the configured dynamic allocation range', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-service-port-test-'))
  const dynamicRange = [32768, 65535]
  const server = createServer()
  try {
    const port = await reservePort(registryDir, { dynamicRange })
    assert.ok(port >= 1024 && port < dynamicRange[0])
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolvePromise)
    })
    assert.equal(server.address().port, port)
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise))
    await rm(registryDir, { recursive: true, force: true })
  }
})

test('keeps explicit service reservations unique across parallel checkpoint processes', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-service-pool-test-'))
  try {
    const ports = await Promise.all(
      Array.from({ length: 32 }, () => reservePort(registryDir, { dynamicRange: [32768, 65535] }))
    )
    assert.equal(new Set(ports).size, ports.length)
    assert.ok(ports.every(port => port >= 1024 && port < 32768))
  } finally {
    await rm(registryDir, { recursive: true, force: true })
  }
})

test('fails instead of allocating in an exhausted dynamic-only port range', async () => {
  await assert.rejects(
    reservePort(undefined, { dynamicRange: [1024, 65535] }),
    /No E2E service ports available outside the kernel dynamic range/
  )
})
