import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  findRuntimeWorkTask,
  hasRunningRuntimeTaskSnapshot,
  waitForCompletedRuntimeTaskThread,
} from '../e2e/desktop/modules/runtime-task-evidence.mjs'
import { waitForWorkbenchDebugState } from '../e2e/desktop/modules/workspace-flows.mjs'

const selectedTaskId = 'runtime-selected'
const threadId = '01a1388e-17ed-74a1-a926-28d723f9dab4'
const stepTimeoutMs = 10_000

function ownerWork(tasks) {
  return { workspaces: [{ workspacePath: '/workspace', tasks }] }
}

function ownerControl(snapshots) {
  let index = 0
  return {
    command: vi.fn(async () => JSON.stringify(snapshots[Math.min(index++, snapshots.length - 1)])),
  }
}

describe('running executor snapshot evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => vi.useRealTimers())

  function snapshot(task = { taskId: selectedTaskId, running: true, completedAt: null }) {
    return {
      workbench: {
        currentRuntimeTask: { taskId: selectedTaskId },
        activeLifecycle: { execution: { running: true }, task },
      },
    }
  }

  test('waits for the wire summary after a start event has already made execution running', async () => {
    const previousCompletion = 1_792_998_868_321
    const pending = snapshot({
      taskId: selectedTaskId,
      running: false,
      completedAt: previousCompletion,
    })
    const running = snapshot()
    const control = ownerControl([pending, running])
    const ready = waitForWorkbenchDebugState(
      control,
      state => hasRunningRuntimeTaskSnapshot(state, selectedTaskId),
      'The correction summary did not arrive',
      stepTimeoutMs
    )

    await vi.advanceTimersByTimeAsync(99)
    expect(control.command).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(ready).resolves.toEqual(running)
    expect(control.command).toHaveBeenCalledTimes(2)
    expect(control.command).toHaveBeenNthCalledWith(1, 'getWorkbenchDebugSnapshot', 'body')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('does not use completion clearance as readiness and hide a broken wire summary', () => {
    const broken = snapshot({ taskId: selectedTaskId, running: true, completedAt: 123 })

    expect(hasRunningRuntimeTaskSnapshot(broken, selectedTaskId)).toBe(true)
    expect(broken.workbench.activeLifecycle.task.completedAt).not.toBeNull()
  })

  test.each(['active task', 'wire task'])('does not accept another %s', source => {
    const other = snapshot()
    if (source === 'active task') other.workbench.currentRuntimeTask.taskId = 'other-task'
    else other.workbench.activeLifecycle.task.taskId = 'other-task'

    expect(hasRunningRuntimeTaskSnapshot(other, selectedTaskId)).toBe(false)
  })

  test('fails at the shared deadline if only the execution event arrived', async () => {
    const control = ownerControl([
      snapshot({ taskId: selectedTaskId, running: false, completedAt: 123 }),
    ])
    const failure = waitForWorkbenchDebugState(
      control,
      state => hasRunningRuntimeTaskSnapshot(state, selectedTaskId),
      'The correction summary did not arrive',
      stepTimeoutMs
    ).catch(error => error)

    await vi.advanceTimersByTimeAsync(stepTimeoutMs)

    expect(await failure).toMatchObject({
      message: expect.stringContaining('The correction summary did not arrive'),
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('owning executor task evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test.each(['array', 'record'])('finds the exact task ID in %s workspaces', shape => {
    const selected = { taskId: selectedTaskId, threadId, running: false }
    const workspace = ownerWork([
      { taskId: `${selectedTaskId}-other`, title: 'Same title', threadId: 'other-thread' },
      selected,
    ]).workspaces[0]
    const work = { workspaces: shape === 'array' ? [workspace] : { '/workspace': workspace } }

    expect(findRuntimeWorkTask(work, selectedTaskId)).toBe(selected)
    expect(findRuntimeWorkTask(work, 'missing-task')).toBeUndefined()
  })

  test('preserves exact snake-case task identity lookup', () => {
    const selected = { task_id: selectedTaskId }
    expect(findRuntimeWorkTask(ownerWork([selected]), selectedTaskId)).toBe(selected)
  })

  test('queries the real owner command for the selected task instead of another ready task', async () => {
    const control = ownerControl([
      ownerWork([
        { taskId: 'other-task', threadId: 'other-thread', running: false },
        { taskId: selectedTaskId, threadId: ` ${threadId} `, running: false },
      ]),
    ])

    await expect(
      waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)
    ).resolves.toBe(threadId)
    expect(control.command).toHaveBeenCalledExactlyOnceWith('getLocalRuntimeWork', 'body')
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([undefined, null, 23, '   '])('waits for a valid thread after %s', async pendingId => {
    const control = ownerControl([
      ownerWork([{ taskId: selectedTaskId, threadId: pendingId, running: false }]),
      ownerWork([{ taskId: selectedTaskId, threadId, running: false }]),
    ])
    const ready = waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)

    await vi.advanceTimersByTimeAsync(99)
    expect(control.command).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(ready).resolves.toBe(threadId)
    expect(control.command).toHaveBeenCalledTimes(2)
  })

  test('waits for explicit owner completion even when the thread already exists', async () => {
    const control = ownerControl(
      [undefined, true, false].map(running =>
        ownerWork([{ taskId: selectedTaskId, threadId, running }])
      )
    )
    const ready = waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)

    await vi.advanceTimersByTimeAsync(100)
    expect(control.command).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    await expect(ready).resolves.toBe(threadId)
    expect(control.command).toHaveBeenCalledTimes(3)
  })

  test('fails missing exact task evidence at the shared step deadline', async () => {
    const control = ownerControl([
      ownerWork([{ taskId: 'other-task', threadId: 'other-thread', running: false }]),
    ])
    const failure = waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs).catch(
      error => error
    )

    await vi.advanceTimersByTimeAsync(stepTimeoutMs)
    expect(await failure).toBeInstanceOf(Error)
    expect((await failure).message).toContain(selectedTaskId)
    expect(control.command).toHaveBeenCalledTimes(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(control.command).toHaveBeenCalledTimes(100)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('does not include runtime handles in timeout diagnostics', async () => {
    const control = ownerControl([
      ownerWork([
        {
          taskId: selectedTaskId,
          threadId: null,
          running: true,
          runtimeHandle: { apiKey: 'sensitive-value' },
        },
      ]),
    ])
    const failure = waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs).catch(
      error => error
    )

    await vi.advanceTimersByTimeAsync(stepTimeoutMs)
    expect((await failure).message).toContain('"running":true')
    expect((await failure).message).not.toContain('sensitive-value')
    expect((await failure).message).not.toContain('runtimeHandle')
  })

  test('bounds an owner request that never returns by the same step deadline', async () => {
    const control = { command: vi.fn(() => new Promise(() => {})) }
    const failure = waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs).catch(
      error => error
    )

    await vi.advanceTimersByTimeAsync(stepTimeoutMs)
    expect(await failure).toBeInstanceOf(Error)
    expect((await failure).message).toContain(selectedTaskId)
    expect(control.command).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('accepts completed owner evidence returned just before the shared step deadline', async () => {
    const control = {
      command: vi.fn(async () => {
        vi.setSystemTime(stepTimeoutMs - 1)
        return JSON.stringify(ownerWork([{ taskId: selectedTaskId, threadId, running: false }]))
      }),
    }

    await expect(
      waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)
    ).resolves.toBe(threadId)
    expect(control.command).toHaveBeenCalledExactlyOnceWith('getLocalRuntimeWork', 'body')
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([stepTimeoutMs, stepTimeoutMs + 1])(
    'rejects completed owner evidence returned at %ims without extending the shared step deadline',
    async responseTimeMs => {
      const control = {
        command: vi.fn(async () => {
          vi.setSystemTime(responseTimeMs)
          return JSON.stringify(ownerWork([{ taskId: selectedTaskId, threadId, running: false }]))
        }),
      }

      await expect(
        waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)
      ).rejects.toThrow(
        `The owning executor did not expose a completed Codex thread for task ${selectedTaskId} within ${stepTimeoutMs}ms`
      )
      expect(control.command).toHaveBeenCalledExactlyOnceWith('getLocalRuntimeWork', 'body')
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  test('rejects duplicate task IDs from different owner workspaces', async () => {
    const control = ownerControl([
      {
        workspaces: [
          { tasks: [{ taskId: selectedTaskId, threadId, running: false }] },
          { tasks: [{ taskId: selectedTaskId, threadId: 'other-thread', running: false }] },
        ],
      },
    ])

    await expect(
      waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)
    ).rejects.toThrow(`Duplicate owning executor task ID: ${selectedTaskId}`)
    expect(control.command).toHaveBeenCalledTimes(1)
  })

  test('propagates owner query failure without polling it again', async () => {
    const failure = new Error('Executor disconnected')
    const control = { command: vi.fn(async () => Promise.reject(failure)) }

    await expect(
      waitForCompletedRuntimeTaskThread(control, selectedTaskId, stepTimeoutMs)
    ).rejects.toBe(failure)
    expect(control.command).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
