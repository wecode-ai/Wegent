import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeTranscriptSearchResponse } from '@wegent/chat-core/runtime'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { useConversationFind } from './useConversationFind'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const response: RuntimeTranscriptSearchResponse = {
  matches: [{ itemId: 'item-a', occurrence: 0, cursor: 'cursor-a' }],
  totalMatches: 1,
  isCapped: false,
}
const visible: WorkbenchMessage = {
  id: 'visible',
  role: 'assistant',
  content: 'needle',
  status: 'done',
  createdAt: '',
  runtimeDisplayItems: [{ id: 'item-a', type: 'assistant_text', content: 'needle' }],
}
type Find = ReturnType<typeof useConversationFind>
async function search(result: { current: Find }) {
  act(() => {
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    result.current.changeQuery('needle')
  })
  await act(() => vi.advanceTimersByTimeAsync(150))
}

test('replacing a search provider aborts its old read and ignores its late result', async () => {
  const old = held<RuntimeTranscriptSearchResponse>()
  let signal!: AbortSignal
  const first = vi.fn((_query: string, current: AbortSignal) => {
    signal = current
    return old.promise
  })
  const next = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false })
  const props: Parameters<typeof useConversationFind>[0] = {
    conversationKey: 'a',
    messages: [],
    onSearchTranscript: first,
  }
  const hook = renderHook(props => useConversationFind(props, true), { initialProps: props })
  await search(hook.result)
  await act(async () => hook.rerender({ ...props, onSearchTranscript: next }))
  expect(signal.aborted).toBe(true)
  expect(next).toHaveBeenCalledOnce()
  await act(async () => {
    old.resolve(response)
    await old.promise
  })
  expect(hook.result.current.result.matches).toBe(0)
  expect(hook.result.current.failure).toBeNull()
})

test('visible projection may arrive before hydration settles without aborting its owner', async () => {
  const load = held<void>()
  let signal!: AbortSignal
  const hydrate = vi.fn((_match: unknown, current: AbortSignal) => {
    signal = current
    return load.promise
  })
  const props: Parameters<typeof useConversationFind>[0] = {
    messages: [],
    onSearchTranscript: vi.fn().mockResolvedValue(response),
    onEnsureSearchMatch: hydrate,
  }
  const hook = renderHook(props => useConversationFind(props, true), { initialProps: props })
  await search(hook.result)
  hook.rerender({ ...props, messages: [visible] })
  expect(signal.aborted).toBe(false)
  expect(hook.result.current.isLoading).toBe(true)
  await act(async () => {
    load.resolve()
    await load.promise
  })
  expect(signal.aborted).toBe(false)
  expect(hydrate).toHaveBeenCalledOnce()
  expect(hook.result.current.searchTarget?.messageId).toBe('visible')
  expect(hook.result.current.isLoading).toBe(false)
})

test('a replaced hydration owner cannot clear the new failure or participate in its retry', async () => {
  const old = held<void>()
  let signal!: AbortSignal
  const hydrate = vi.fn((_match: unknown, current: AbortSignal) => {
    signal = current
    return old.promise
  })
  const next = vi.fn().mockRejectedValueOnce(new Error('new failure')).mockResolvedValue(undefined)
  const props: Parameters<typeof useConversationFind>[0] = {
    messages: [],
    onSearchTranscript: vi.fn().mockResolvedValue(response),
    onEnsureSearchMatch: hydrate,
  }
  const hook = renderHook(props => useConversationFind(props, true), { initialProps: props })
  await search(hook.result)
  await act(async () => {
    hook.rerender({ ...props, onEnsureSearchMatch: next })
  })
  expect(signal.aborted).toBe(true)
  expect(hook.result.current.failure).toBe('load')
  await act(async () => {
    old.resolve()
    await old.promise
  })
  expect(hook.result.current.failure).toBe('load')
  await act(async () => hook.result.current.retry())
  expect(next).toHaveBeenCalledTimes(2)
  expect(hydrate).toHaveBeenCalledOnce()
  expect(hook.result.current.failure).toBeNull()
})

test('reactivating a pane with the projected match does not restart a cancelled hydration', async () => {
  const pending = held<void>()
  let signal!: AbortSignal
  const hydrate = vi.fn((_match: unknown, current: AbortSignal) => {
    signal = current
    return pending.promise
  })
  const props: Parameters<typeof useConversationFind>[0] & { active: boolean } = {
    active: true,
    messages: [],
    onSearchTranscript: vi.fn().mockResolvedValue(response),
    onEnsureSearchMatch: hydrate,
  }
  const hook = renderHook(({ active, ...props }) => useConversationFind(props, active), {
    initialProps: props,
  })
  await search(hook.result)
  hook.rerender({ ...props, active: false, messages: [visible] })
  expect(signal.aborted).toBe(true)
  await act(async () => {
    hook.rerender({ ...props, messages: [visible] })
  })
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
  expect(hydrate).toHaveBeenCalledOnce()
  expect(hook.result.current.searchTarget?.messageId).toBe('visible')
  expect(hook.result.current.isLoading).toBe(false)
})

test.each([
  { from: 1, to: '1' },
  { from: null, to: undefined },
])('retains distinct conversation identities across $from and $to', async ({ from, to }) => {
  const old = held<RuntimeTranscriptSearchResponse>()
  let signal!: AbortSignal
  const request = vi
    .fn()
    .mockImplementationOnce((_query: string, current: AbortSignal) => {
      signal = current
      return old.promise
    })
    .mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false })
  const props: Parameters<typeof useConversationFind>[0] = {
    conversationKey: from,
    messages: [],
    onSearchTranscript: request,
  }
  const hook = renderHook(props => useConversationFind(props, true), { initialProps: props })
  await search(hook.result)
  hook.rerender({ ...props, conversationKey: to })
  expect(signal.aborted).toBe(true)
  expect(hook.result.current.open).toBe(false)
  await search(hook.result)
  await act(async () => {
    old.resolve(response)
    await old.promise
  })
  expect(request).toHaveBeenCalledTimes(2)
  expect(hook.result.current.result.matches).toBe(0)
  expect(hook.result.current.failure).toBeNull()
})

test('batched retries of one failed transcript request start only one replacement read', async () => {
  const pending = held<RuntimeTranscriptSearchResponse>()
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockReturnValue(pending.promise)
  const hook = renderHook(() =>
    useConversationFind({ messages: [], onSearchTranscript: request }, true)
  )
  await search(hook.result)
  expect(hook.result.current.failure).toBe('request')
  const retry = hook.result.current.retry
  act(() => {
    retry()
    retry()
  })
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => {
    pending.resolve({ matches: [], totalMatches: 0, isCapped: false })
    await pending.promise
  })
  expect(hook.result.current.failure).toBeNull()
})

test('batched retries of one failed match load start only one replacement hydration', async () => {
  const pending = held<void>()
  const hydrate = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockReturnValue(pending.promise)
  const request = vi.fn().mockResolvedValue(response)
  const hook = renderHook(() =>
    useConversationFind(
      { messages: [], onSearchTranscript: request, onEnsureSearchMatch: hydrate },
      true
    )
  )
  await search(hook.result)
  expect(hook.result.current.failure).toBe('load')
  const retry = hook.result.current.retry
  act(() => {
    retry()
    retry()
  })
  expect(hydrate).toHaveBeenCalledTimes(2)
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
  expect(hook.result.current.failure).toBeNull()
})
