import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/api'
import type { RuntimeTranscriptLoader } from '@/types/workbench'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import { synchronizeRuntimeConversation } from '@/features/workbench/runtimeConversationSynchronization'
import { useRuntimePaneTranscriptReader } from './useRuntimePaneTranscriptReader'

const address = { deviceId: 'pane-device', taskId: 'pane-task' }
const addressKey = (value: RuntimeTaskAddress) => `${value.deviceId}:${value.taskId}`

afterEach(clearRuntimeConversationCacheForTests)

describe('pane transcript read ownership', () => {
  test.each([addressKey(address), null])(
    'owns cross-conversation reference reads from pane %s',
    async targetKey => {
      const read = vi.fn<RuntimeTranscriptLoader>(() => new Promise(() => {}))
      const view = renderHook(() => useRuntimePaneTranscriptReader(read, targetKey, 0))
      const reference = { ...address, taskId: 'referenced-conversation' }
      const request = view.result.current.read(reference, { conversationContextOnly: true })
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      expect(read).toHaveBeenCalledWith(reference, {
        conversationContextOnly: true,
        signal: expect.any(AbortSignal),
      })
      const signal = read.mock.calls[0][1]?.signal
      view.unmount()
      await rejected
      expect(signal?.aborted).toBe(true)
    }
  )

  test.each([
    ['initial', { limit: 5 }],
    ['older page', { beforeCursor: 'older', limit: 5 }],
    ['navigation', { navigationOnly: true }],
    ['turn jump', { beforeCursor: 'turn:old', limit: 5 }],
    ['gap', { afterCursor: 'offset:5', limit: 5 }],
    ['search context', { isolated: true, beforeCursor: 'match', limit: 5 }],
    ['export', { includeFullContent: true, refresh: true }],
  ] as const)(
    'releases an in-flight %s subscription when its pane leaves',
    async (_kind, options) => {
      const read = vi.fn<RuntimeTranscriptLoader>(() => new Promise(() => {}))
      const view = renderHook(() => useRuntimePaneTranscriptReader(read, addressKey(address), 0))
      const request = view.result.current.read(address, options)
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      const signal = read.mock.calls[0][1]?.signal
      expect(signal?.aborted).toBe(false)
      view.unmount()
      await rejected
      expect(signal?.aborted).toBe(true)
    }
  )

  test.each(['replace', 'reload'] as const)(
    'cancels old reads and stale callbacks on %s, including a previously loaded pane',
    async change => {
      const read = vi.fn<RuntimeTranscriptLoader>(() => new Promise(() => {}))
      const view = renderHook(
        ({ key, revision }) => useRuntimePaneTranscriptReader(read, key, revision),
        { initialProps: { key: addressKey(address), revision: 0 } }
      )
      const staleScope = view.result.current
      const staleReader = staleScope.read
      const request = staleReader(address, { beforeCursor: 'older' })
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      const nextAddress = change === 'replace' ? { ...address, taskId: 'next-task' } : address
      view.rerender({ key: addressKey(nextAddress), revision: 1 })
      await rejected
      expect(staleScope.isCurrent()).toBe(false)
      expect(view.result.current.isCurrent()).toBe(true)
      await expect(staleReader(address)).rejects.toMatchObject({ name: 'AbortError' })
      expect(read).toHaveBeenCalledOnce()
      read.mockResolvedValueOnce({ messages: [], turns: [] })
      await expect(view.result.current.read(nextAddress)).resolves.toMatchObject({ turns: [] })
    }
  )

  test('uses a replaced transport without abandoning the same pane scope', async () => {
    const first = vi.fn<RuntimeTranscriptLoader>().mockResolvedValue({ messages: [], turns: [] })
    const next = vi.fn<RuntimeTranscriptLoader>().mockResolvedValue({ messages: [], turns: [] })
    const view = renderHook(
      ({ read }) => useRuntimePaneTranscriptReader(read, addressKey(address), 0),
      { initialProps: { read: first } }
    )
    const initialReader = view.result.current.read
    await initialReader(address)
    const signal = first.mock.calls[0][1]?.signal
    view.rerender({ read: next })
    expect(view.result.current.read).toBe(initialReader)
    await initialReader(address)
    expect(next).toHaveBeenCalledOnce()
    expect(next.mock.calls[0][1]?.signal).toBe(signal)
    expect(signal?.aborted).toBe(false)
  })

  test('keeps a shared provider alive until both pane subscriptions leave', async () => {
    let providerSignal: AbortSignal | undefined
    const provider = vi.fn((_request, options?: { signal?: AbortSignal }) => {
      providerSignal = options?.signal
      return new Promise<RuntimeTranscriptResponse>(() => {})
    })
    const read: RuntimeTranscriptLoader = (target, options) =>
      synchronizeRuntimeConversation(provider, target, options)
    const mount = () =>
      renderHook(() => useRuntimePaneTranscriptReader(read, addressKey(address), 0))
    const first = mount()
    const second = mount()
    const one = first.result.current.read(address, { beforeCursor: 'shared-older' })
    const two = second.result.current.read(address, { beforeCursor: 'shared-older' })
    const oneRejected = expect(one).rejects.toMatchObject({ name: 'AbortError' })
    const twoRejected = expect(two).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(provider).toHaveBeenCalledOnce())
    first.unmount()
    await oneRejected
    expect(providerSignal?.aborted).toBe(false)
    second.unmount()
    await twoRejected
    await waitFor(() => expect(providerSignal?.aborted).toBe(true))
  })

  test('combines search cancellation with the pane scope and survives Strict Mode cleanup', async () => {
    const read = vi.fn<RuntimeTranscriptLoader>(() => new Promise(() => {}))
    const view = renderHook(() => useRuntimePaneTranscriptReader(read, addressKey(address), 0), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    })
    const search = new AbortController()
    const request = view.result.current.read(address, { isolated: true, signal: search.signal })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(false)
    act(() => search.abort())
    await rejected
    read.mockResolvedValueOnce({ messages: [], turns: [] })
    await expect(view.result.current.read(address)).resolves.toMatchObject({ turns: [] })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      view.result.current.read(address, { signal: cancelled.signal })
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(read).toHaveBeenCalledTimes(2)
  })
})
