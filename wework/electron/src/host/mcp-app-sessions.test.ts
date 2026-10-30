import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { McpAppSessions } from './mcp-app-sessions.js'

const payload = { address: { taskId: 'task', deviceId: 'device' }, callId: 'call' }

describe('MCP App native ownership', () => {
  it.each(['destroyed', 'render-process-gone', 'navigation'])(
    'releases on %s after pending retain settles',
    async event => {
      let finish!: () => void
      const request = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>(resolve => {
              finish = resolve
            })
        )
        .mockResolvedValue({})
      const owner = new EventEmitter()
      const sessions = new McpAppSessions(request)
      const pending = sessions.retain('old', payload, owner as WebContents)
      await Promise.resolve()
      const cleanup = vi.fn()
      sessions.attach('old', cleanup)
      if (event === 'navigation') owner.emit('did-start-navigation', {}, 'about:blank', false, true)
      else owner.emit(event)
      expect(cleanup).toHaveBeenCalledOnce()
      expect(request).toHaveBeenCalledTimes(1)
      finish()
      await pending
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
      expect(request).toHaveBeenLastCalledWith({ ...payload, method: 'release', sessionId: 'old' })
      expect(owner.eventNames()).toEqual([])
      expect(() => sessions.attach('old', vi.fn())).toThrow('closed')
    }
  )

  it('releases each instance once and leaves its replacement alive', async () => {
    const request = vi.fn().mockResolvedValue({})
    const owner = new EventEmitter()
    const sessions = new McpAppSessions(request)
    await sessions.retain('old', payload, owner as WebContents)
    await sessions.retain('new', payload, owner as WebContents)
    await sessions.release('old')
    await sessions.release('old')
    expect(request).toHaveBeenCalledTimes(3)
    expect(() => sessions.attach('new', vi.fn())).not.toThrow()
    await sessions.release('new')
    expect(owner.eventNames()).toEqual([])
  })
})

it('restores retention only when the executor process changes', async () => {
  let pid = 1
  const request = vi.fn().mockResolvedValue({})
  const sessions = new McpAppSessions(request, () => pid)
  const owner = new EventEmitter() as WebContents
  await sessions.retain('app', payload, owner)
  await sessions.retain('app', payload, owner)
  expect(request).toHaveBeenCalledTimes(1)
  pid = 2
  await sessions.retain('app', payload, owner)
  expect(request).toHaveBeenCalledTimes(2)
  await sessions.release('app')
  expect(request).toHaveBeenLastCalledWith({ ...payload, method: 'release', sessionId: 'app' })
})

it('allows explicit cleanup to retry after a failed release', async () => {
  const request = vi.fn().mockResolvedValue({})
  const sessions = new McpAppSessions(request)
  const owner = new EventEmitter() as WebContents
  await sessions.retain('app', payload, owner)
  request.mockRejectedValueOnce(new Error('Transport closed'))
  await expect(sessions.release('app')).rejects.toThrow('Transport closed')
  expect(sessions.ids()).toEqual(['app'])
  await sessions.release('app')
  expect(sessions.ids()).toEqual([])
  expect(owner.eventNames()).toEqual([])
})

it('releases all instances before native shutdown and rejects later acquisition', async () => {
  const request = vi.fn().mockResolvedValue({})
  const sessions = new McpAppSessions(request)
  const owner = new EventEmitter() as WebContents
  await sessions.retain('first', payload, owner)
  await sessions.retain('second', payload, owner)
  await sessions.dispose()
  expect(sessions.ids()).toEqual([])
  expect(request.mock.calls.filter(([data]) => data.method === 'release')).toHaveLength(2)
  await expect(sessions.retain('third', payload, owner)).rejects.toThrow('shutting down')
})

it('can restore a live instance after a failed executor reconnection', async () => {
  let pid = 1
  const request = vi.fn().mockResolvedValue({})
  const sessions = new McpAppSessions(request, () => pid)
  const owner = new EventEmitter() as WebContents
  await sessions.retain('app', payload, owner)
  pid = 2
  request.mockRejectedValueOnce(new Error('Executor restarting'))
  await expect(sessions.retain('app', payload, owner)).rejects.toThrow('Executor restarting')
  await sessions.retain('app', payload, owner)
  expect(request).toHaveBeenCalledTimes(3)
  await sessions.dispose()
})

it('keeps ownership during subframe navigation and same-document routing', async () => {
  const request = vi.fn().mockResolvedValue({})
  const sessions = new McpAppSessions(request)
  const owner = new EventEmitter()
  await sessions.retain('app', payload, owner as WebContents)
  owner.emit('did-start-navigation', {}, 'about:blank', false, false)
  owner.emit('did-start-navigation', {}, 'https://workbench/#task', true, true)
  expect(sessions.ids()).toEqual(['app'])
  expect(request).toHaveBeenCalledTimes(1)
  await sessions.dispose()
})
