import React, { createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeStream } from '@/services/runtimeStream'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/runtime'
import { useMobileTranscript } from './useMobileTranscript'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const first = { deviceId: 'device-1', taskId: 'task-1' }
const second = { deviceId: 'device-2', taskId: 'task-1' }
const page = (content: string, beforeCursor: string | null = null): RuntimeTranscriptResponse => ({
  taskId: 'task-1',
  workspacePath: '/work',
  runtime: 'codex',
  beforeCursor,
  messages: [{ id: content, role: 'user', content }],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('mobile conversation snapshots (PC hydration and cache contract)', () => {
  let renderer: ReactTestRenderer
  let state: ReturnType<typeof useMobileTranscript>
  let address = createRef<RuntimeTaskAddress | null>()
  const getTranscript = vi.fn()
  const onError = vi.fn()
  const stream = { getTranscript } as unknown as RuntimeStream

  function Harness() {
    state = useMobileTranscript(stream, address, onError)
    return null
  }

  beforeEach(async () => {
    address = createRef<RuntimeTaskAddress | null>()
    getTranscript.mockReset().mockResolvedValue(page('history', 'older'))
    onError.mockClear()
    await act(() => {
      renderer = create(<Harness />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
    vi.restoreAllMocks()
  })

  async function open(next = first) {
    await act(() => {
      address.current = next
      state.activate(next)
    })
  }
  async function load(next = first) {
    await open(next)
    await act(async () => {
      await state.reloadTranscript(next)
    })
  }

  it('binds a new draft before a terminal event starts transcript hydration', async () => {
    await act(() =>
      state.dispatchMessages({
        type: 'optimistic-user',
        id: 'user',
        content: 'Hello',
        createdAt: 1,
      })
    )
    await act(() => {
      address.current = first
      state.activate(first, { adoptDraft: true })
    })
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
      state.dispatchMessages({
        type: 'stream',
        event: {
          name: 'response.completed',
          payload: { subtaskId: 'turn', data: { output_text: 'Done' } },
        },
      })
    })
    await act(async () => {
      pending.resolve({ ...page(''), messages: [] })
      await read
    })
    expect(state.messages[0]).toMatchObject({ role: 'user', content: 'Hello' })
    expect(state.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'completed',
      content: 'Done',
    })
  })

  it('shows a cached conversation immediately while a single fresh snapshot loads', async () => {
    await load()
    await open(second)
    expect(state.messages).toEqual([])
    await open()
    expect(state.messages[0]?.content).toBe('history')
    expect(state.loading).toBe(false)
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    let one!: Promise<unknown>
    let two!: Promise<unknown>
    await act(() => {
      one = state.reloadTranscript(first)
      two = state.reloadTranscript(first)
    })
    expect(one).toBe(two)
    expect(getTranscript).toHaveBeenCalledTimes(2)
    expect(state.messages[0]?.content).toBe('history')
    await act(async () => {
      pending.resolve(page('fresh'))
      await one
    })
    expect(state.messages.map(message => message.content)).toEqual(['fresh'])
  })

  it('keeps accepted question answers across omitted and then stale history snapshots', async () => {
    const response = {
      requestId: 0,
      interactionScope: 'turn',
      answers: { choice: { answers: ['One'] } },
    }
    const questionPage: RuntimeTranscriptResponse = {
      ...page(''),
      messages: [
        {
          id: 'assistant',
          subtaskId: 'turn',
          role: 'assistant',
          content: '',
          blocks: [
            {
              id: 'question',
              type: 'tool',
              toolName: 'request_user_input',
              status: 'pending',
              renderPayload: {
                kind: 'request_user_input',
                requestId: 0,
                interactionScope: 'turn',
                questions: [{ id: 'choice', question: 'Choose' }],
              },
            },
          ],
        },
      ],
    }
    getTranscript.mockResolvedValue(questionPage)
    await load()
    await act(() => state.dispatchToAddress(first, { type: 'user-input-response', response }))
    getTranscript.mockResolvedValue({
      ...questionPage,
      messages: [{ id: 'assistant', subtaskId: 'turn', role: 'assistant', content: 'Done' }],
    })
    await act(async () => {
      await state.reloadTranscript(first)
    })
    getTranscript.mockResolvedValue(questionPage)
    await act(async () => {
      await state.reloadTranscript(first)
    })
    expect(state.messages[0]?.blocks?.[0]).toHaveProperty('renderPayload.response', response)
  })

  it('isolates devices with the same task ID and ignores a different page finishing late', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('second'))
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
    })
    await load(second)
    await act(async () => {
      pending.resolve(page('first'))
      await read
    })
    expect(state.messages[0]?.content).toBe('second')
    await open()
    expect(state.messages[0]?.content).toBe('first')
  })

  it('reuses the original read when navigating A → B → A before it finishes', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
    })
    await open(second)
    await open()
    await act(() => {
      expect(state.reloadTranscript(first)).toBe(read)
    })
    expect(getTranscript).toHaveBeenCalledOnce()
    await act(async () => {
      pending.resolve(page('first'))
      await read
    })
    expect(state.messages[0]?.content).toBe('first')
    expect(state.loading).toBe(false)
  })

  it('preserves new live events when an older snapshot finishes', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
    })
    await act(() =>
      state.dispatchMessages({
        type: 'stream',
        event: {
          name: 'response.output_text.delta',
          payload: {
            taskId: 'task-1',
            subtaskId: 'turn-new',
            data: { itemId: 'item', delta: 'Live', offset: 0 },
          },
        },
      })
    )
    await act(async () => {
      pending.resolve({
        ...page('old'),
        messages: [
          { id: 'old', role: 'user', content: 'old', subtaskId: 'turn-new', status: 'completed' },
        ],
      })
      await read
    })
    expect(state.messages.map(message => message.content)).toEqual(['old', 'Live'])
    expect(state.messages.find(message => message.role === 'assistant')?.status).toBe('streaming')
  })

  it('keeps a terminal snapshot authoritative over buffered events for that same turn', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
      state.dispatchMessages({
        type: 'stream',
        event: {
          name: 'response.output_text.delta',
          payload: { subtaskId: 'turn', data: { itemId: 'item', delta: 'Half', offset: 0 } },
        },
      })
    })
    await act(async () => {
      pending.resolve({
        ...page(''),
        messages: [
          {
            id: 'runtime-view:turn:assistant',
            role: 'assistant',
            subtaskId: 'turn',
            content: 'Complete',
            status: 'completed',
          },
        ],
      })
      await read
    })
    expect(state.messages).toMatchObject([{ content: 'Complete', status: 'completed' }])
  })

  it('uses canonical snapshot text item IDs so overlapping deltas do not duplicate text', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
      state.dispatchMessages({
        type: 'stream',
        event: {
          name: 'response.output_text.delta',
          payload: { subtaskId: 'turn', data: { itemId: 'item', delta: 'lo', offset: 3 } },
        },
      })
    })
    await act(async () => {
      pending.resolve({
        ...page(''),
        messages: [
          {
            id: 'runtime-view:turn:assistant',
            role: 'assistant',
            subtaskId: 'turn',
            content: 'Hello',
            status: 'streaming',
            runtimeItems: [{ id: 'item', type: 'assistant_text', content: 'Hello' }],
          },
        ],
      })
      await read
    })
    expect(state.messages).toMatchObject([
      { content: 'Hello', textItems: [{ id: 'item', content: 'Hello' }] },
    ])
  })

  it('loads older pages only on demand, coalesces scrolling, and retains the cursor on reopen', async () => {
    await load()
    expect(getTranscript).toHaveBeenCalledOnce()
    const older = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValueOnce(older.promise)
    let read!: Promise<unknown>
    await act(() => {
      read = state.loadMoreMessagesBefore()
      void state.loadMoreMessagesBefore()
    })
    expect(getTranscript).toHaveBeenCalledTimes(2)
    expect(state.loadingMoreMessagesBefore).toBe(true)
    await act(async () => {
      older.resolve(page('older history', 'oldest'))
      await read
    })
    await open(second)
    await open()
    expect(state.messages.map(message => message.content)).toEqual(['older history', 'history'])
    await act(async () => {
      await state.reloadTranscript(first)
    })
    getTranscript.mockResolvedValueOnce(page('oldest history'))
    await act(async () => {
      await state.loadMoreMessagesBefore()
    })
    expect(getTranscript).toHaveBeenLastCalledWith(first, { beforeCursor: 'oldest' })
    expect(state.hasMoreMessagesBefore).toBe(false)
  })

  it('keeps cached messages through a failed refresh and allows recovery', async () => {
    await load()
    getTranscript.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await expect(state.reloadTranscript(first)).rejects.toThrow('offline')
    })
    expect(state.messages[0]?.content).toBe('history')
    expect(state.loading).toBe(false)
    await act(async () => {
      await state.reloadTranscript(first)
    })
    expect(getTranscript).toHaveBeenCalledTimes(3)
  })

  it('adopts a disjoint latest page and its cursor so cached history cannot hide a gap', async () => {
    await load()
    getTranscript.mockResolvedValueOnce(page('newest page', 'new-gap'))
    await act(async () => {
      await state.reloadTranscript(first)
    })
    expect(state.messages.map(message => message.content)).toEqual(['newest page'])
    getTranscript.mockResolvedValueOnce(page('middle page', 'middle-cursor'))
    await act(async () => {
      await state.loadMoreMessagesBefore()
    })
    expect(getTranscript).toHaveBeenLastCalledWith(first, { beforeCursor: 'new-gap' })
    expect(state.messages.map(message => message.content)).toEqual(['middle page', 'newest page'])
  })

  it('clears cached server history when the authoritative transcript becomes empty', async () => {
    await load()
    getTranscript.mockResolvedValueOnce({ ...page(''), messages: [], beforeCursor: null })
    await act(async () => {
      await state.reloadTranscript(first)
    })
    expect(state.messages).toEqual([])
    expect(state.hasMoreMessagesBefore).toBe(false)
  })

  it('invalidates older pages after a disjoint refresh without clearing a newer request', async () => {
    await load()
    const stale = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValueOnce(stale.promise)
    let staleRead!: Promise<void>
    await act(() => {
      staleRead = state.loadMoreMessagesBefore()
    })
    getTranscript.mockResolvedValueOnce(page('latest', 'new-gap'))
    await act(async () => {
      await state.reloadTranscript(first)
    })
    expect(state.loadingMoreMessagesBefore).toBe(false)
    const current = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValueOnce(current.promise)
    let currentRead!: Promise<void>
    await act(() => {
      currentRead = state.loadMoreMessagesBefore()
    })
    expect(getTranscript).toHaveBeenLastCalledWith(first, { beforeCursor: 'new-gap' })
    await act(async () => {
      stale.resolve(page('stale history', 'wrong-cursor'))
      await staleRead
    })
    expect(state.messages.map(message => message.content)).toEqual(['latest'])
    expect(state.loadingMoreMessagesBefore).toBe(true)
    await act(async () => {
      current.resolve(page('middle', 'new-middle'))
      await currentRead
    })
    expect(state.messages.map(message => message.content)).toEqual(['middle', 'latest'])
    expect(state.loadingMoreMessagesBefore).toBe(false)
    await act(async () => {
      await state.loadMoreMessagesBefore()
    })
    expect(getTranscript).toHaveBeenLastCalledWith(first, { beforeCursor: 'new-middle' })
  })

  it('discards revoked-device snapshots and prevents a late read from restoring them', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
      state.retainDevices(['device-2'])
    })
    await act(async () => {
      pending.resolve(page('private'))
      expect(await read).toBeNull()
    })
    await open()
    expect(state.messages).toEqual([])
    expect(state.loading).toBe(true)
  })

  it('expires idle terminal conversations after the PC five-minute window', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    await load()
    await open(second)
    now.mockReturnValue(1000 + 5 * 60 * 1000 + 1)
    await open()
    expect(state.messages).toEqual([])
    expect(state.loading).toBe(true)
  })

  it('discards a failed old read without clearing the loading state of a newer cache entry', async () => {
    const pending = deferred<RuntimeTranscriptResponse>()
    getTranscript.mockReturnValue(pending.promise)
    await open()
    let read!: Promise<unknown>
    await act(() => {
      read = state.reloadTranscript(first)
      state.retainDevices([])
    })
    await open()
    await act(async () => {
      pending.reject(new Error('revoked'))
      expect(await read).toBeNull()
    })
    expect(state.messages).toEqual([])
    expect(state.loading).toBe(true)
  })

  it('bounds retained snapshots to the same 50 conversations as PC', async () => {
    for (let index = 0; index <= 50; index += 1)
      await load({ deviceId: 'device-1', taskId: String(index) })
    await open({ deviceId: 'device-1', taskId: '0' })
    expect(state.messages).toEqual([])
    expect(state.loading).toBe(true)
    await open({ deviceId: 'device-1', taskId: '50' })
    expect(state.messages[0]?.content).toBe('history')
    expect(state.loading).toBe(false)
  })

  it('also enforces the snapshot bound when tasks are created directly from drafts', async () => {
    for (let index = 0; index <= 50; index += 1) {
      await act(() => {
        address.current = null
        state.reset()
        state.dispatchMessages({
          type: 'optimistic-user',
          id: 'user',
          content: 'Draft',
          createdAt: 1,
        })
        address.current = { deviceId: 'device-1', taskId: String(index) }
        state.activate(address.current, { adoptDraft: true })
        state.dispatchMessages({
          type: 'stream',
          event: { name: 'response.created', payload: { subtaskId: 'turn', data: {} } },
        })
      })
    }
    await open({ deviceId: 'device-1', taskId: '0' })
    expect(state.messages).toEqual([])
    await open({ deviceId: 'device-1', taskId: '50' })
    expect(state.messages[0]?.content).toBe('Draft')
  })

  it('adopts an optimistic draft into a newly created task before its first event', async () => {
    await act(() =>
      state.dispatchMessages({
        type: 'optimistic-user',
        id: 'user',
        content: 'Draft',
        createdAt: 1,
      })
    )
    await act(() => {
      address.current = first
      state.activate(first, { adoptDraft: true })
      state.dispatchMessages({
        type: 'stream',
        event: {
          name: 'response.created',
          payload: { subtaskId: 'turn', data: {} },
        },
      })
    })
    await open(second)
    await open()
    expect(state.messages[0]?.content).toBe('Draft')
  })
})
