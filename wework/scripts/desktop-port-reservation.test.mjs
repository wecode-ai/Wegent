import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { test, vi } from 'vitest'

import { reservePort } from '../e2e/desktop/port-reservation.mjs'

vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal()
  return { ...original, randomInt: vi.fn(original.randomInt) }
})

vi.mock('node:net', async importOriginal => {
  const original = await importOriginal()
  return { ...original, createServer: vi.fn(original.createServer) }
})

function assignedPort(port, requestedPort) {
  const server = {
    once: vi.fn().mockReturnThis(),
    listen: vi.fn((candidate, host, ready) => {
      assert.equal(candidate, requestedPort)
      assert.equal(host, '127.0.0.1')
      ready()
      return server
    }),
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port }),
    close: vi.fn(closed => closed()),
  }
  return server
}

test.each([2049, 4190, 6000, 6679, 10080])(
  'reserves an HTTP Fetch-safe port instead of forbidden port %i',
  async forbiddenPort => {
    const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-fetch-port-test-'))
    const server = createHttpServer((_request, response) => response.end('ready'))
    try {
      if ([2049, 6000, 10080].includes(forbiddenPort)) {
        await assert.rejects(
          fetch(`http://127.0.0.1:${forbiddenPort}/api/startup`),
          error => error.cause?.message === 'bad port'
        )
      }
      const rejected = assignedPort(forbiddenPort, forbiddenPort)
      vi.mocked(randomInt).mockReturnValueOnce(forbiddenPort - 1024)
      vi.mocked(createServer).mockReturnValueOnce(rejected)

      const port = await reservePort(registryDir, { dynamicRange: [32768, 65535] })

      assert.notEqual(port, forbiddenPort, 'The reservation returned a Fetch-forbidden port')
      assert.ok(port >= 1024 && port < 32768)
      assert.deepEqual(await readdir(registryDir), [String(port)])
      assert.equal(rejected.close.mock.calls.length, 1)
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolvePromise)
      })
      const response = await fetch(`http://127.0.0.1:${port}/api/startup`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'ready')
    } finally {
      if (server.listening) await new Promise(resolvePromise => server.close(resolvePromise))
      await rm(registryDir, { recursive: true, force: true })
    }
  }
)

test('rejects a forbidden port assigned by listen(0) before claiming it', async () => {
  const registryDir = await mkdtemp(join(tmpdir(), 'wework-e2e-assigned-port-test-'))
  const rejected = assignedPort(2049, 0)
  vi.mocked(createServer).mockReturnValueOnce(rejected)
  try {
    const port = await reservePort(registryDir, { dynamicRange: null })

    assert.notEqual(port, 2049)
    assert.deepEqual(await readdir(registryDir), [String(port)])
    assert.equal(rejected.close.mock.calls.length, 1)
  } finally {
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
