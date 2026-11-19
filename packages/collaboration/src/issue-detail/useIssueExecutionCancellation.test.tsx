// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useIssueExecutionCancellation } from './useIssueExecutionCancellation'

it('shares stop state, rejects duplicate clicks, retries failures and isolates Issue changes', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div')
  const root = createRoot(node)
  let controls!: ReturnType<typeof useIssueExecutionCancellation>
  let reject!: (error: Error) => void
  const cancel = vi.fn(
    () =>
      new Promise<void>((_resolve, rejectRequest) => {
        reject = rejectRequest
      })
  )
  function Harness({ scope }: { scope: string }) {
    controls = useIssueExecutionCancellation(scope, cancel, 'Stop failed')
    return null
  }
  const address = { deviceId: 'device', taskId: 'task' }
  try {
    await act(async () => root.render(<Harness scope="issue-one" />))
    let pending!: Promise<void>
    act(() => {
      pending = controls.stop('message-one', address)
    })
    expect(controls.stoppingMessageId).toBe('message-one')
    await controls.stop('message-two', address)
    expect(cancel).toHaveBeenCalledTimes(1)
    await act(async () => {
      reject(new Error('offline'))
      await pending
    })
    expect(controls.error).toBe('offline')
    expect(controls.stoppingMessageId).toBeNull()
    act(() => {
      pending = controls.stop('message-one', address)
    })
    expect(controls.error).toBeNull()
    await act(async () => root.render(<Harness scope="issue-two" />))
    await act(async () => {
      reject(new Error('old Issue error'))
      await pending
    })
    expect(controls.error).toBeNull()
    expect(controls.stoppingMessageId).toBeNull()
    cancel.mockImplementation(async () => {})
    await act(async () =>
      controls.stop('new-message', {
        deviceId: 'other-device',
        taskId: 'other-task',
      })
    )
    expect(cancel).toHaveBeenLastCalledWith({
      deviceId: 'other-device',
      taskId: 'other-task',
    })
    expect(controls.error).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})

it('isolates an earlier visit even after returning to the same Issue', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.createElement('div'))
  let controls!: ReturnType<typeof useIssueExecutionCancellation>
  const failures: ((error: Error) => void)[] = []
  const cancel = vi.fn(() => new Promise<void>((_resolve, reject) => failures.push(reject)))
  function Harness({ scope }: { scope: string }) {
    controls = useIssueExecutionCancellation(scope, cancel, 'Stop failed')
    return null
  }
  try {
    await act(async () => root.render(<Harness scope="a" />))
    let earlier!: Promise<void>
    act(() => {
      earlier = controls.stop('earlier', {
        deviceId: 'device',
        taskId: 'task',
      })
    })
    await act(async () => root.render(<Harness scope="b" />))
    await act(async () => root.render(<Harness scope="a" />))
    let current!: Promise<void>
    act(() => {
      current = controls.stop('current', {
        deviceId: 'device',
        taskId: 'task',
      })
    })
    await act(async () => {
      failures[0](new Error('old visit'))
      await earlier
    })
    expect(controls.stoppingMessageId).toBe('current')
    expect(controls.error).toBeNull()
    await act(async () => {
      failures[1](new Error('current visit'))
      await current
    })
    expect(controls.stoppingMessageId).toBeNull()
    expect(controls.error).toBe('current visit')
  } finally {
    await act(async () => root.unmount())
  }
})
