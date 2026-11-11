import { act, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type {
  RuntimeTaskSummary,
  RuntimeTranscriptResponse,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '../workbenchServices'
import {
  cacheRuntimeConversationQueuedMessages,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationMessages,
} from '../runtimeConversationCache'
import { synchronizeRuntimeConversation } from '../runtimeConversationSynchronization'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleStreamCoordinator } from './RuntimeTaskLifecycleStreamCoordinator'

const address = (taskId: string) => ({
  deviceId: 'responsive-device',
  taskId,
  runtime: 'codex',
  workspacePath: '/workspace',
})
const task = (taskId: string, running: boolean): RuntimeTaskSummary => ({
  taskId,
  title: taskId,
  runtime: 'codex',
  workspacePath: '/workspace',
  running,
  status: running ? 'active' : 'done',
  completedAt: running ? null : 100,
})
const work = (running: boolean): RuntimeWorkListResponse => ({
  projects: [],
  chats: [
    {
      deviceId: 'responsive-device',
      workspacePath: '/workspace',
      available: true,
      tasks: [task('slow', running), task('fast', running)],
    },
  ],
  totalTasks: 2,
})
const transcript = (taskId: string): RuntimeTranscriptResponse => ({
  runtime: 'codex',
  workspacePath: '/workspace',
  running: false,
  messages: [],
  turns: [
    {
      id: `${taskId}-turn`,
      status: 'completed',
      items: [{ id: `${taskId}-answer`, type: 'assistant_text', content: 'Complete answer' }],
    },
  ],
})

afterEach(clearRuntimeConversationCacheForTests)

test('one stalled history repair does not block another task or its authoritative state', async () => {
  const store = new RuntimeTaskLifecycleStore('independent-repair')
  store.syncRuntimeWork(work(true))
  let handlers: ChatStreamHandlers = {}
  let release!: (response: RuntimeTranscriptResponse) => void
  const getRuntimeTranscript = vi.fn((request: { taskId: string }) =>
    request.taskId === 'slow'
      ? new Promise<RuntimeTranscriptResponse>(resolve => {
          release = resolve
        })
      : Promise.resolve(transcript(request.taskId))
  )
  const services = {
    chatStream: {
      subscribe: (next: ChatStreamHandlers) => {
        handlers = next
        return () => {}
      },
    },
    executorClient: {
      runtime: { listRuntimeWork: vi.fn().mockResolvedValue(work(false)), getRuntimeTranscript },
    },
  } as unknown as WorkbenchServices
  render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
  await act(async () => {
    handlers.onRuntimeEventLagged?.({ skipped: 10 })
  })
  await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(store.getTask(address('fast'))?.turn.latestId).toBe('fast-turn'))
  expect(store.getTask(address('slow'))?.execution.phase).toBe('idle')
  const requests = getRuntimeTranscript.mock.calls.map(([request]) => request)
  expect(requests).toMatchObject([
    { taskId: 'slow', limit: 5 },
    { taskId: 'fast', limit: 5 },
  ])
  for (const request of requests) {
    expect(request).not.toHaveProperty('includeFullContent')
    expect(request).not.toHaveProperty('refresh')
  }
  await act(async () => {
    release(transcript('slow'))
  })
})

test('a complete live turn and authoritative terminal task do not read history again', async () => {
  const store = new RuntimeTaskLifecycleStore('complete-live-turn')
  store.syncRuntimeWork(work(true))
  store.turnStarted(address('fast'), 'fast-turn')
  await synchronizeRuntimeConversation(async () => transcript('fast'), address('fast'))
  let handlers: ChatStreamHandlers = {}
  const getRuntimeTranscript = vi.fn()
  const services = {
    chatStream: {
      subscribe: (next: ChatStreamHandlers) => {
        handlers = next
        return () => {}
      },
    },
    executorClient: { runtime: { getRuntimeTranscript } },
  } as unknown as WorkbenchServices
  render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
  await act(async () => {
    handlers.onChatDone?.({
      taskId: 'fast',
      deviceId: 'responsive-device',
      subtaskId: 'fast-turn',
      task: task('fast', false),
      result: {},
    })
  })
  expect(getRuntimeTranscript).not.toHaveBeenCalled()
  expect(store.getTask(address('fast'))?.execution.phase).toBe('idle')
  expect(store.getTask(address('fast'))?.turn.outcome).toBe('succeeded')
})

test('repairs a cancelled history snapshot when the native turn subsequently succeeds', async () => {
  const store = new RuntimeTaskLifecycleStore('conflicting-terminal-history')
  store.syncRuntimeWork(work(true))
  store.turnStarted(address('fast'), 'fast-turn')
  await synchronizeRuntimeConversation(
    async () => ({
      ...transcript('fast'),
      running: true,
      turns: [{ id: 'fast-turn', status: 'cancelled', items: [] }],
    }),
    address('fast')
  )
  let handlers: ChatStreamHandlers = {}
  const getRuntimeTranscript = vi.fn().mockResolvedValue(transcript('fast'))
  const services = {
    chatStream: {
      subscribe: (next: ChatStreamHandlers) => {
        handlers = next
        return () => {}
      },
    },
    executorClient: { runtime: { getRuntimeTranscript } },
  } as unknown as WorkbenchServices
  render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
  await act(async () => {
    handlers.onChatDone?.({
      taskId: 'fast',
      deviceId: 'responsive-device',
      subtaskId: 'fast-turn',
      task: task('fast', false),
      result: {},
    })
  })
  expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
  expect(getRuntimeConversationMessages(address('fast')).at(-1)).toMatchObject({
    content: 'Complete answer',
    status: 'done',
  })
  expect(store.getTask(address('fast'))?.turn.outcome).toBe('succeeded')
})

test('confirms execution idle through a point lookup while history is still pending', async () => {
  const store = new RuntimeTaskLifecycleStore('terminal-point-lookup')
  store.syncRuntimeWork(work(true))
  store.turnStarted(address('fast'), 'fast-turn')
  let handlers: ChatStreamHandlers = {}
  let release!: (response: RuntimeTranscriptResponse) => void
  const getRuntimeTranscript = vi.fn(
    () =>
      new Promise<RuntimeTranscriptResponse>(resolve => {
        release = resolve
      })
  )
  const getRuntimeTask = vi.fn().mockResolvedValue(task('fast', false))
  const services = {
    chatStream: {
      subscribe: (next: ChatStreamHandlers) => {
        handlers = next
        return () => {}
      },
    },
    executorClient: { runtime: { getRuntimeTranscript, getRuntimeTask } },
  } as unknown as WorkbenchServices
  render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
  await act(async () => {
    handlers.onChatDone?.({
      taskId: 'fast',
      deviceId: 'responsive-device',
      subtaskId: 'fast-turn',
      result: {},
    })
  })
  await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
  expect(getRuntimeTask).toHaveBeenCalledWith(
    expect.objectContaining({
      deviceId: 'responsive-device',
      taskId: 'fast',
      workspacePath: '/workspace',
    }),
    { signal: expect.any(AbortSignal) }
  )
  expect(store.getTask(address('fast'))?.execution.phase).toBe('idle')
  expect(store.getTask(address('fast'))?.turn.outcome).toBe('succeeded')
  await act(async () => {
    release(transcript('fast'))
  })
})

test('releases a terminal history subscriber when its coordinator is disposed', async () => {
  const store = new RuntimeTaskLifecycleStore('terminal-dispose')
  store.syncRuntimeWork(work(true))
  let handlers: ChatStreamHandlers = {}
  let providerSignal: AbortSignal | undefined
  const getRuntimeTranscript = vi.fn((_request, options?: { signal?: AbortSignal }) => {
    providerSignal = options?.signal
    return new Promise<RuntimeTranscriptResponse>(() => {})
  })
  const services = {
    chatStream: {
      subscribe: (next: ChatStreamHandlers) => {
        handlers = next
        return () => {}
      },
    },
    executorClient: { runtime: { getRuntimeTranscript } },
  } as unknown as WorkbenchServices
  const view = render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
  await act(async () => {
    handlers.onChatDone?.({
      taskId: 'fast',
      deviceId: 'responsive-device',
      subtaskId: 'fast-turn',
      result: {},
    })
  })
  await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
  view.unmount()
  await waitFor(() => expect(providerSignal?.aborted).toBe(true))
})

test.each(
  [
    { accepted: ['accepted-before-tail'], expected: [] },
    { accepted: [], expected: [expect.objectContaining({ status: 'sending' })] },
    { accepted: undefined, expected: [expect.objectContaining({ status: 'sending' })] },
    { accepted: ['unqueried-id'], expected: [expect.objectContaining({ status: 'sending' })] },
  ].flatMap(testCase =>
    ['event_lagged', 'runtime_replaced'].map(reason => ({ ...testCase, reason }))
  )
)(
  '$reason uses explicit message receipts when the tail has no user item: $accepted',
  async ({ accepted, expected, reason }) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const store = new RuntimeTaskLifecycleStore('replacement-receipts')
      store.syncRuntimeWork(work(true))
      cacheRuntimeConversationQueuedMessages(address('fast'), [
        {
          id: 'accepted-before-tail',
          content: 'Original prompt outside the loaded tail',
          status: 'sending',
          createdAt: '2026-11-03T00:00:00.000Z',
        },
      ])
      let handlers: ChatStreamHandlers = {}
      const getRuntimeTranscript = vi.fn(async (request: { taskId: string }) => ({
        ...transcript(request.taskId),
        ...(request.taskId === 'fast' && accepted !== undefined
          ? { acceptedClientUserMessageIds: accepted }
          : {}),
      }))
      const services = {
        chatStream: {
          subscribe(next: ChatStreamHandlers) {
            handlers = next
            return () => {}
          },
        },
        executorClient: {
          runtime: {
            listRuntimeWork: vi.fn().mockResolvedValue(work(false)),
            getRuntimeTranscript,
          },
        },
      } as unknown as WorkbenchServices
      render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
      await act(async () => {
        if (reason === 'event_lagged') {
          handlers.onRuntimeEventLagged?.({ skipped: 1 })
        } else {
          handlers.onRuntimeTransportReplaced?.({
            previousRuntimeInstanceId: 'old',
            runtimeInstanceId: 'new',
          })
        }
      })
      await waitFor(() =>
        expect(getRuntimeTranscript).toHaveBeenCalledWith(
          expect.objectContaining({
            taskId: 'fast',
            reconcileClientUserMessageIds: ['accepted-before-tail'],
            limit: 5,
          }),
          { signal: expect.any(AbortSignal) }
        )
      )
      await waitFor(() => expect(store.getTask(address('fast'))?.turn.latestId).toBe('fast-turn'))
      expect(getRuntimeConversationQueuedMessages(address('fast'))).toEqual(expected)
      if (!accepted?.length || accepted.includes('unqueried-id')) {
        expect(warning).toHaveBeenCalledWith(
          '[Wework] Runtime message receipt confirmation unavailable',
          expect.objectContaining({ taskId: 'fast' })
        )
      }
    } finally {
      warning.mockRestore()
    }
  }
)
