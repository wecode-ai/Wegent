import { createServer } from 'node:net'
import { expect, test, vi } from 'vitest'
import { LocalNevisSandboxService } from '../../e2e/desktop/modules/cloud-environment.mjs'
import { reservePort } from '../../e2e/desktop/port-reservation.mjs'

vi.mock('../../e2e/desktop/port-reservation.mjs', async importOriginal => {
  const original = await importOriginal<typeof import('../../e2e/desktop/port-reservation.mjs')>()
  return { ...original, reservePort: vi.fn(original.reservePort) }
})

test('Nevis binds atomically when a parallel service takes a released reservation', async () => {
  const competingServer = createServer()
  const { reservePort: originalReservePort } = await vi.importActual<
    typeof import('../../e2e/desktop/port-reservation.mjs')
  >('../../e2e/desktop/port-reservation.mjs')
  vi.mocked(reservePort).mockImplementationOnce(async () => {
    const port = await originalReservePort()
    await new Promise<void>((resolve, reject) => {
      competingServer.once('error', reject)
      competingServer.listen(port, '127.0.0.1', resolve)
    })
    return port
  })
  const service = new LocalNevisSandboxService()
  try {
    await service.start()
    expect(service.server.address().port).toBe(service.port)
    const response = await fetch(
      `${service.endpoint}/apis/sandboxes/v1/managers/test-manager/sandboxes/test-sandbox/restart`,
      { method: 'POST' }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'test-sandbox', status: 'restarting' })
    expect(await service.waitForRestartRequest(0)).toEqual({
      managerId: 'test-manager',
      sandboxId: 'test-sandbox',
    })
  } finally {
    await service.stop()
    if (competingServer.listening) {
      await new Promise<void>(resolve => competingServer.close(() => resolve()))
    }
    vi.mocked(reservePort).mockReset()
  }
})

test('parallel Nevis services retain distinct listening ports until stopped', async () => {
  const services = Array.from({ length: 16 }, () => new LocalNevisSandboxService())
  try {
    await Promise.all(services.map(service => service.start()))
    expect(new Set(services.map(service => service.port)).size).toBe(services.length)
    for (const service of services) {
      const response = await fetch(`${service.endpoint}/metrics/raw_query`, { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { data: { result: [] } } })
    }
  } finally {
    await Promise.all(services.map(service => service.stop()))
  }
})
