import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test, vi } from 'vitest'

import { reservePort } from '../e2e/desktop/port-reservation.mjs'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, randomInt: vi.fn(actual.randomInt) }
})

test('reserves a port reachable by fetch when the candidate starts at IRC port 6667', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-fetch-port-test-'))
  const server = createHttpServer((_request, response) => response.end('ready'))
  try {
    vi.mocked(randomInt).mockReturnValueOnce(6667 - 1024)
    const port = await reservePort(registryDir, { dynamicRange: [32768, 65535] })
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolvePromise)
    })
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ready')
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise))
    await rm(registryDir, { recursive: true, force: true })
  }
})

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

test('excludes the pinned MinIO console port from API service allocation', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-minio-port-test-'))
  const server = createServer()
  try {
    vi.mocked(randomInt).mockReturnValueOnce(13333 - 1024)
    const port = await reservePort(registryDir, {
      dynamicRange: [32768, 65535],
      excludedPorts: [13333],
    })
    assert.notEqual(port, 13333)
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
