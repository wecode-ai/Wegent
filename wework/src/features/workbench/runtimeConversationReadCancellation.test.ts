import { describe, expect, test, vi } from 'vitest'
import type { RuntimeTranscriptRequest, RuntimeTranscriptResponse } from '@/types/api'
import {
  SupersededConversationRead,
  synchronizeRuntimeConversation,
} from './runtimeConversationSynchronization'

const response: RuntimeTranscriptResponse = {
  runtime: 'codex',
  workspacePath: '/workspace',
  messages: [],
  turns: [],
}

describe('shared transcript cancellation', () => {
  test('receipt queries share only when their requested identities match', async () => {
    const address = { deviceId: 'cancel-device', taskId: 'receipt-scope' }
    const read = vi.fn(async (request: RuntimeTranscriptRequest) => ({
      ...response,
      acceptedClientUserMessageIds: request.reconcileClientUserMessageIds,
    }))
    const first = synchronizeRuntimeConversation(read, address, {
      reconcileClientUserMessageIds: ['accepted-a', 'accepted-b'],
    })
    const equivalent = synchronizeRuntimeConversation(read, address, {
      reconcileClientUserMessageIds: ['accepted-b', 'accepted-a'],
    })
    const other = synchronizeRuntimeConversation(read, address, {
      reconcileClientUserMessageIds: ['accepted-c'],
    })
    expect(equivalent).toBe(first)
    expect(other).not.toBe(first)
    await expect(first).resolves.toMatchObject({
      acceptedClientUserMessageIds: ['accepted-a', 'accepted-b'],
    })
    await expect(other).resolves.toMatchObject({ acceptedClientUserMessageIds: ['accepted-c'] })
    expect(read).toHaveBeenCalledTimes(2)
  })
  test('a replaced thread never queues behind its abandoned background read', async () => {
    const address = { deviceId: 'cancel-device', taskId: 'replaced-thread' }
    let oldSignal: AbortSignal | undefined
    const oldRead = vi.fn((_request, options?: { signal?: AbortSignal }) => {
      oldSignal = options?.signal
      return new Promise<RuntimeTranscriptResponse>(() => {})
    })
    const old = synchronizeRuntimeConversation(oldRead, { ...address, threadId: 'old' })
    const rejected = expect(old).rejects.toBeInstanceOf(SupersededConversationRead)
    await vi.waitFor(() => expect(oldRead).toHaveBeenCalledTimes(1))
    const queued = synchronizeRuntimeConversation(
      oldRead,
      { ...address, threadId: 'old' },
      {
        beforeCursor: 'older',
      }
    )
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(SupersededConversationRead)
    const current = vi.fn(async () => ({ ...response, threadId: 'new' }))
    await expect(
      synchronizeRuntimeConversation(current, { ...address, threadId: 'new' })
    ).resolves.toMatchObject({ turns: [] })
    await rejected
    await queuedRejected
    expect(oldSignal?.aborted).toBe(true)
    expect(oldRead).toHaveBeenCalledTimes(1)
    expect(current).toHaveBeenCalledTimes(1)
  })
  test('keeps a shared provider alive until its last viewer leaves', async () => {
    const first = new AbortController()
    const second = new AbortController()
    let providerSignal: AbortSignal | undefined
    let resolve!: (value: RuntimeTranscriptResponse) => void
    const read = vi.fn((_request, options?: { signal?: AbortSignal }) => {
      providerSignal = options?.signal
      return new Promise<RuntimeTranscriptResponse>(done => {
        resolve = done
      })
    })
    const address = { deviceId: 'cancel-device', taskId: 'shared-viewers' }
    const one = synchronizeRuntimeConversation(read, address, { signal: first.signal })
    const two = synchronizeRuntimeConversation(read, address, { signal: second.signal })
    const cancelled = expect(one).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    first.abort()
    await cancelled
    expect(providerSignal?.aborted).toBe(false)
    resolve(response)
    await expect(two).resolves.toMatchObject({ turns: [] })
  })

  test('cancels the provider and releases a serial writer when its last viewer leaves', async () => {
    const controller = new AbortController()
    let providerSignal: AbortSignal | undefined
    const address = { deviceId: 'cancel-device', taskId: 'last-viewer' }
    const read = vi.fn((_request, options?: { signal?: AbortSignal }) => {
      providerSignal = options?.signal
      return new Promise<RuntimeTranscriptResponse>(() => {})
    })
    const one = synchronizeRuntimeConversation(read, address, { signal: controller.signal })
    const cancelled = expect(one).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    controller.abort()
    await cancelled
    expect(providerSignal?.aborted).toBe(true)
    const recovery = vi.fn(async () => response)
    await expect(synchronizeRuntimeConversation(recovery, address)).resolves.toMatchObject({
      turns: [],
    })
    expect(recovery).toHaveBeenCalledTimes(1)
  })

  test('never dispatches an abandoned queued page', async () => {
    const address = { deviceId: 'cancel-device', taskId: 'queued-read' }
    let resolve!: (value: RuntimeTranscriptResponse) => void
    const read = vi.fn(
      () =>
        new Promise<RuntimeTranscriptResponse>(done => {
          resolve = done
        })
    )
    const first = synchronizeRuntimeConversation(read, address, { limit: 5 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = synchronizeRuntimeConversation(read, address, {
      beforeCursor: 'older',
      signal: controller.signal,
    })
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await cancelled
    resolve(response)
    await first
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('a cancelled queued page cannot let a later page bypass the active writer', async () => {
    const address = { deviceId: 'cancel-device', taskId: 'queued-barrier' }
    let resolve!: (value: RuntimeTranscriptResponse) => void
    const read = vi.fn(
      () =>
        new Promise<RuntimeTranscriptResponse>(done => {
          resolve = done
        })
    )
    const first = synchronizeRuntimeConversation(read, address, { limit: 5 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    const controller = new AbortController()
    const queued = synchronizeRuntimeConversation(read, address, {
      beforeCursor: 'older',
      signal: controller.signal,
    })
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await cancelled
    const laterRead = vi.fn(async () => response)
    const later = synchronizeRuntimeConversation(laterRead, address, { beforeCursor: 'oldest' })
    await Promise.resolve()
    await Promise.resolve()
    expect(laterRead).not.toHaveBeenCalled()
    resolve(response)
    await first
    await later
    expect(laterRead).toHaveBeenCalledOnce()
  })
})
