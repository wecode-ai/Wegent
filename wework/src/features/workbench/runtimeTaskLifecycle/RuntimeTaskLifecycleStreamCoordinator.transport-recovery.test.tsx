import { act, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimeTaskSummary, RuntimeTranscriptResponse } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '../workbenchServices'
import {
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
} from '../runtimeConversationCache'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleStreamCoordinator } from './RuntimeTaskLifecycleStreamCoordinator'
import {
  runtimeTaskAddress,
  runtimeTranscript,
  runtimeWork,
} from './RuntimeTaskLifecycleStreamCoordinator.fixtures'

const address = runtimeTaskAddress()

function nativeTask(running: boolean, revision: string, turnId = 'turn-1'): RuntimeTaskSummary {
  return {
    ...runtimeWork(running).chats[0]!.tasks[0]!,
    executionState: {
      revision,
      phase: running ? 'running' : 'idle',
      turnId: running ? turnId : null,
      latestTurnId: turnId,
      outcome: running ? null : 'succeeded',
    },
  }
}

function setup() {
  const store = new RuntimeTaskLifecycleStore('transport-recovery')
  store.syncRuntimeWork(runtimeWork(true))
  store.setCurrentTask(address)
  let handlers: ChatStreamHandlers = {}
  let resume = () => {}
  window.weworkElectronLifecycle = {
    onSystemResume(listener) {
      resume = listener
      return () => {
        resume = () => {}
      }
    },
  }
  const runtime = {
    listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork(false)),
    getRuntimeTask: vi.fn().mockResolvedValue(null),
    getRuntimeTranscript: vi.fn().mockResolvedValue(runtimeTranscript(false)),
  }
  const services = {
    executorClient: { runtime },
    recoverRuntimeConnections: vi.fn().mockResolvedValue(undefined),
    chatStream: {
      subscribe(next: ChatStreamHandlers) {
        handlers = next
        return () => {}
      },
    },
  } as unknown as WorkbenchServices
  return {
    store,
    runtime,
    services,
    resume: () => resume(),
    recover: () => handlers.onRuntimeEventLagged?.({ skipped: 0 }),
    startTurn: (turnId = 'turn-1') =>
      handlers.onChatStart?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: turnId,
      }),
    finishTurn: (turnId, failed = false, task?: RuntimeTaskSummary) =>
      failed
        ? handlers.onChatError?.({
            taskId: address.taskId,
            deviceId: address.deviceId,
            subtaskId: turnId,
            error: 'superseded turn failed',
            ...(task ? { task } : {}),
          } as never)
        : handlers.onChatDone?.({
            taskId: address.taskId,
            deviceId: address.deviceId,
            subtaskId: turnId,
            result: {},
            ...(task ? { task } : {}),
          } as never),
    mount: () =>
      render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />),
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearRuntimeConversationCacheForTests()
  delete window.weworkElectronLifecycle
})

test('reconciles a completed turn when its terminal stream event is lost', async () => {
  vi.useFakeTimers()
  const { store, runtime, mount, startTurn } = setup()
  runtime.getRuntimeTask.mockResolvedValue(nativeTask(false, '2'))
  mount()

  await act(async () => startTurn())
  expect(store.getTask(address)?.turn.phase).toBe('streaming')
  expect(runtime.getRuntimeTask).not.toHaveBeenCalled()

  await act(() => vi.advanceTimersByTimeAsync(5_000))

  expect(runtime.getRuntimeTask).toHaveBeenCalledExactlyOnceWith(address, {
    signal: expect.any(AbortSignal),
  })
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledOnce()
  expect(store.getTask(address)?.turn.phase).toBe('idle')
  expect(getRuntimeConversationMessages(address).at(-1)?.content).toBe('已恢复的 AI 输出')

  await act(() => vi.advanceTimersByTimeAsync(30_000))
  expect(runtime.getRuntimeTask).toHaveBeenCalledOnce()
})

test('keeps checking an active turn without loading its transcript early', async () => {
  vi.useFakeTimers()
  const { store, runtime, mount, startTurn } = setup()
  runtime.getRuntimeTask
    .mockResolvedValueOnce(nativeTask(true, '2'))
    .mockResolvedValueOnce(nativeTask(false, '3'))
  mount()

  await act(async () => startTurn())
  await act(() => vi.advanceTimersByTimeAsync(5_000))

  expect(runtime.getRuntimeTask).toHaveBeenCalledOnce()
  expect(runtime.getRuntimeTranscript).not.toHaveBeenCalled()
  expect(store.getTask(address)?.turn.phase).toBe('streaming')

  await act(() => vi.advanceTimersByTimeAsync(5_000))

  expect(runtime.getRuntimeTask).toHaveBeenCalledTimes(2)
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledOnce()
  expect(store.getTask(address)?.turn.phase).toBe('idle')
})

test.each([
  ['completion', false],
  ['error', true],
] as const)('keeps the new turn check after a stale %s event', async (_label, failed) => {
  vi.useFakeTimers()
  const { store, runtime, mount, startTurn, finishTurn } = setup()
  runtime.getRuntimeTask.mockResolvedValue(nativeTask(false, '2', 'turn-2'))
  runtime.getRuntimeTranscript.mockResolvedValue({
    ...runtimeTranscript(false),
    turns: [{ ...runtimeTranscript(false).turns[0]!, id: 'turn-2' }],
  })
  mount()

  await act(async () => {
    startTurn('turn-1')
    startTurn('turn-2')
    finishTurn('turn-1', failed, nativeTask(false, '1', 'turn-1'))
  })

  expect(store.getTask(address)?.turn.id).toBe('turn-2')
  expect(store.getTask(address)?.turn.phase).toBe('streaming')
  expect(runtime.getRuntimeTask).not.toHaveBeenCalled()

  await act(() => vi.advanceTimersByTimeAsync(5_000))

  expect(runtime.getRuntimeTask).toHaveBeenCalledOnce()
  expect(store.getTask(address)?.turn.phase).toBe('idle')
})

test('checks a restored active turn without waiting for another start event', async () => {
  vi.useFakeTimers()
  const { store, runtime, mount } = setup()
  store.turnStarted(address, 'restored-turn')
  runtime.getRuntimeTask.mockResolvedValue(nativeTask(false, '2', 'restored-turn'))
  runtime.getRuntimeTranscript.mockResolvedValue({
    ...runtimeTranscript(false),
    turns: [{ ...runtimeTranscript(false).turns[0]!, id: 'restored-turn' }],
  })
  mount()

  await act(() => vi.advanceTimersByTimeAsync(5_000))

  expect(runtime.getRuntimeTask).toHaveBeenCalledOnce()
  expect(store.getTask(address)?.turn.phase).toBe('idle')
})

test('refreshes the cloud owner state even while the local list and transcript are pending', async () => {
  const { store, runtime, mount, recover } = setup()
  store.syncRuntimeTask(address, nativeTask(true, '1'))
  let releaseList!: (value: ReturnType<typeof runtimeWork>) => void
  let releaseTranscript!: (value: RuntimeTranscriptResponse) => void
  runtime.listRuntimeWork.mockImplementation(
    () =>
      new Promise(resolve => {
        releaseList = resolve
      })
  )
  runtime.getRuntimeTranscript.mockImplementation(
    () =>
      new Promise(resolve => {
        releaseTranscript = resolve
      })
  )
  runtime.getRuntimeTask.mockResolvedValue(nativeTask(false, '2'))
  mount()

  await act(async () => recover())

  expect(runtime.getRuntimeTask).toHaveBeenCalledExactlyOnceWith(address, {
    signal: expect.any(AbortSignal),
  })
  expect(store.getTask(address)?.execution.phase).toBe('idle')
  expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
  await act(async () => {
    releaseTranscript(runtimeTranscript(false))
    releaseList({ projects: [], chats: [], totalTasks: 0 })
  })
  expect(getRuntimeConversationMessages(address).at(-1)?.content).toBe('已恢复的 AI 输出')
})

test('retries a failed cloud transcript after resume even after its task becomes idle', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { store, runtime, mount, resume } = setup()
  runtime.getRuntimeTranscript.mockRejectedValueOnce(new Error('VPN is not ready'))
  mount()
  await act(async () => resume())
  expect(store.getTask(address)?.execution.phase).toBe('idle')
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(1)

  await act(() => vi.advanceTimersByTimeAsync(999))
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(1))

  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(2)
  expect(getRuntimeConversationMessages(address).at(-1)?.content).toBe('已恢复的 AI 输出')
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(2)
})

test('retains only failed background tasks for retry after every task has completed', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { store, runtime, mount, recover } = setup()
  const work = runtimeWork(true)
  work.chats[0]!.tasks.push({ ...work.chats[0]!.tasks[0]!, taskId: 'background' })
  store.syncRuntimeWork(work)
  runtime.listRuntimeWork.mockResolvedValue({
    ...work,
    chats: work.chats.map(chat => ({
      ...chat,
      tasks: chat.tasks.map(task => ({ ...task, running: false, status: 'done' })),
    })),
  })
  let failed = false
  runtime.getRuntimeTranscript.mockImplementation(async request => {
    if (request.taskId === 'background' && !failed) {
      failed = true
      throw new Error('Connection closed')
    }
    return runtimeTranscript(false)
  })
  mount()
  await act(async () => recover())
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(2)
  expect(store.getSnapshot().runningTaskKeys.size).toBe(0)

  await act(() => vi.advanceTimersByTimeAsync(1_000))

  expect(runtime.getRuntimeTranscript.mock.calls.map(([request]) => request.taskId)).toEqual([
    address.taskId,
    'background',
    'background',
  ])
})

test('recovers cloud history despite a failed local catalog and retries the catalog independently', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { runtime, mount, recover } = setup()
  runtime.listRuntimeWork.mockRejectedValueOnce(new Error('Local runtime unavailable'))
  mount()

  await act(async () => recover())

  expect(getRuntimeConversationMessages(address).at(-1)?.content).toBe('已恢复的 AI 输出')
  await act(() => vi.advanceTimersByTimeAsync(1_000))
  expect(runtime.listRuntimeWork).toHaveBeenCalledTimes(2)
})

test('retries failed owner lookups even when transcript recovery succeeds', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { store, runtime, mount, recover } = setup()
  store.syncRuntimeTask(address, nativeTask(true, '1'))
  runtime.listRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
  runtime.getRuntimeTask
    .mockRejectedValueOnce(new Error('Owner route unavailable'))
    .mockResolvedValue(nativeTask(false, '2'))
  mount()
  await act(async () => recover())
  expect(store.getTask(address)?.execution.phase).toBe('running')

  await act(() => vi.advanceTimersByTimeAsync(1_000))

  expect(runtime.getRuntimeTask).toHaveBeenCalledTimes(2)
  expect(store.getTask(address)?.execution.phase).toBe('idle')
})

test('preserves a pending catalog retry when services change during backoff', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { store, runtime, services, mount, recover } = setup()
  runtime.listRuntimeWork.mockRejectedValueOnce(new Error('Local runtime restarting'))
  const view = mount()
  await act(async () => recover())
  expect(runtime.listRuntimeWork).toHaveBeenCalledTimes(1)

  const replacement = { ...services, executorClient: { ...services.executorClient! } }
  await act(async () => {
    view.rerender(<RuntimeTaskLifecycleStreamCoordinator services={replacement} store={store} />)
  })

  expect(runtime.listRuntimeWork).toHaveBeenCalledTimes(2)
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(runtime.listRuntimeWork).toHaveBeenCalledTimes(2)
})

test('does not overwrite a newer native turn with a delayed recovery snapshot', async () => {
  const { store, runtime, mount, recover } = setup()
  store.syncRuntimeTask(address, nativeTask(true, '1'))
  runtime.listRuntimeWork.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
  let release!: (task: RuntimeTaskSummary) => void
  runtime.getRuntimeTask.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  mount()
  await act(async () => recover())
  act(() => store.syncRuntimeTask(address, nativeTask(true, '3', 'new-turn')))

  await act(async () => release(nativeTask(false, '2')))

  expect(store.getTask(address)?.turn.id).toBe('new-turn')
  expect(store.getTask(address)?.execution.phase).toBe('running')
})

test('backs off persistent failures, caps retry frequency and cancels recovery on unmount', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { runtime, mount, recover } = setup()
  runtime.getRuntimeTranscript.mockRejectedValue(new Error('Offline'))
  const view = mount()
  await act(async () => recover())
  let attempts = 1
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await act(() => vi.advanceTimersByTimeAsync(delay - 1))
    expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(attempts)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(++attempts)
  }
  view.unmount()
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(attempts)
})

test('does not retry an explicitly permanent rejection', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { runtime, mount, recover } = setup()
  runtime.getRuntimeTranscript.mockRejectedValue(
    Object.assign(new Error('Access denied'), { retryable: false })
  )
  mount()
  await act(async () => recover())

  await act(() => vi.advanceTimersByTimeAsync(60_000))

  expect(runtime.getRuntimeTranscript).toHaveBeenCalledTimes(1)
})
