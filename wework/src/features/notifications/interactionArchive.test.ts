import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { persistInteractionArchive } from './interactionArchive'
import type { InteractionHistory } from './RuntimeInteractionsContext'

const host = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: host.request }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

const entry = (id: string): InteractionHistory => ({
  id,
  title: id,
  question: id,
  source: 'project',
  dismissed: true,
  originalUrl: `wework://boards/local/12/issues/${id}`,
  answeredAt: 1,
})

beforeEach(() => {
  localStorage.clear()
  host.request.mockReset()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_key: string, callback: () => unknown) => callback() },
  })
})
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks')
})

it('does not publish a rejected archive or overwrite another window on recovery', async () => {
  const durable: Record<string, string> = {}
  let fail = true
  host.request.mockImplementation(async (method: string, params) => {
    if (method === 'rendererStorage.initialize') return { ...durable }
    if (fail) throw new Error('Disk unavailable')
    Object.assign(durable, params.changes)
  })
  const published = vi.fn()
  await expect(persistInteractionArchive('history', entry('failed'), published)).rejects.toThrow(
    'Disk unavailable'
  )
  expect(localStorage.getItem('history')).toBeNull()
  expect(published).not.toHaveBeenCalled()
  // Another window commits after the failed transaction; this window's cache stays stale.
  durable.history = JSON.stringify([entry('other-window')])
  fail = false
  await persistInteractionArchive('history', entry('recovered'), published)
  expect(JSON.parse(durable.history).map((row: InteractionHistory) => row.id)).toEqual([
    'other-window',
    'recovered',
  ])
  expect(published).toHaveBeenCalledWith([entry('other-window'), entry('recovered')])
})
