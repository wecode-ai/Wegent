import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  EMPTY_FEEDBACK_DIALOG_REQUEST,
  closeFeedbackDialog,
  openFeedbackDialog,
  registerFeedbackDialogContext,
  useFeedbackDialogRequest,
  useRegisteredFeedbackDialogContext,
  type FeedbackDialogRequest,
} from './feedbackDialogStore'

function createRequest(taskId: string): FeedbackDialogRequest {
  return {
    hasActiveTask: true,
    deviceId: 'device-1',
    taskId,
    getTaskContext: async () => ({ task: { taskId } }),
  }
}

beforeEach(() => {
  closeFeedbackDialog()
  // Replace and immediately release any registration left by a previous test.
  registerFeedbackDialogContext(() => EMPTY_FEEDBACK_DIALOG_REQUEST)()
})

describe('feedback dialog store', () => {
  test('opens with the empty request by default', () => {
    const { result } = renderHook(() => useFeedbackDialogRequest())

    act(() => openFeedbackDialog())

    expect(result.current).toBe(EMPTY_FEEDBACK_DIALOG_REQUEST)
  })

  test('uses the registered task context when no request is passed', () => {
    const request = createRequest('task-1')
    registerFeedbackDialogContext(() => request)
    const { result } = renderHook(() => useFeedbackDialogRequest())

    act(() => openFeedbackDialog())

    expect(result.current).toMatchObject({
      hasActiveTask: true,
      deviceId: 'device-1',
      taskId: 'task-1',
    })
  })

  test('prefers an explicit request over the registered context', () => {
    const registered = createRequest('registered')
    const explicit = createRequest('explicit')
    registerFeedbackDialogContext(() => registered)
    const { result } = renderHook(() => useFeedbackDialogRequest())

    act(() => openFeedbackDialog(explicit))

    expect(result.current).toBe(explicit)
  })

  test('falls back to the empty request after the context is unregistered', () => {
    const request = createRequest('task-1')
    const unregister = registerFeedbackDialogContext(() => request)
    const { result } = renderHook(() => useFeedbackDialogRequest())

    unregister()
    act(() => openFeedbackDialog())

    expect(result.current).toBe(EMPTY_FEEDBACK_DIALOG_REQUEST)
  })

  test('freezes the open request when the context is unregistered', () => {
    const request = createRequest('task-1')
    const unregister = registerFeedbackDialogContext(() => request)
    const { result } = renderHook(() => useFeedbackDialogRequest())

    act(() => openFeedbackDialog())
    unregister()

    expect(result.current).toMatchObject({
      hasActiveTask: true,
      deviceId: 'device-1',
      taskId: 'task-1',
    })
  })

  test('does not replace a dialog that is already open', () => {
    const first = createRequest('first')
    const second = createRequest('second')
    const { result } = renderHook(() => useFeedbackDialogRequest())

    act(() => openFeedbackDialog(first))
    act(() => openFeedbackDialog(second))

    expect(result.current).toBe(first)
  })

  test('clears the active request when the dialog closes', () => {
    const { result } = renderHook(() => useFeedbackDialogRequest())

    act(() => openFeedbackDialog(createRequest('task-1')))
    act(() => closeFeedbackDialog())

    expect(result.current).toBeNull()
  })

  test('registers the latest request while the surface is active', () => {
    const first = createRequest('first')
    const second = createRequest('second')
    const view = renderHook(
      ({ active, request }) => {
        useRegisteredFeedbackDialogContext(active, request)
        return useFeedbackDialogRequest()
      },
      { initialProps: { active: true, request: first } }
    )

    view.rerender({ active: true, request: second })
    act(() => openFeedbackDialog())

    expect(view.result.current).toMatchObject({
      hasActiveTask: true,
      deviceId: 'device-1',
      taskId: 'second',
    })
  })

  test('uses the latest getter for the same task while the dialog is open', async () => {
    const firstGetter = vi.fn(async () => ({ version: 1 }))
    const secondGetter = vi.fn(async () => ({ version: 2 }))
    const first = { ...createRequest('task-1'), getTaskContext: firstGetter }
    const second = { ...createRequest('task-1'), getTaskContext: secondGetter }
    const view = renderHook(
      ({ request }) => {
        useRegisteredFeedbackDialogContext(true, request)
        return useFeedbackDialogRequest()
      },
      { initialProps: { request: first } }
    )

    act(() => openFeedbackDialog())
    view.rerender({ request: second })

    await act(async () => {
      await expect(view.result.current?.getTaskContext()).resolves.toEqual({ version: 2 })
    })
    expect(secondGetter).toHaveBeenCalledOnce()
    expect(firstGetter).not.toHaveBeenCalled()
  })

  test('retains the opened getter when the task changes while the dialog is open', async () => {
    const firstGetter = vi.fn(async () => ({ version: 1 }))
    const secondGetter = vi.fn(async () => ({ version: 2 }))
    const first = { ...createRequest('task-1'), getTaskContext: firstGetter }
    const second = { ...createRequest('task-2'), getTaskContext: secondGetter }
    const view = renderHook(
      ({ request }) => {
        useRegisteredFeedbackDialogContext(true, request)
        return useFeedbackDialogRequest()
      },
      { initialProps: { request: first } }
    )

    act(() => openFeedbackDialog())
    view.rerender({ request: second })

    await act(async () => {
      await expect(view.result.current?.getTaskContext()).resolves.toEqual({ version: 1 })
    })
    expect(firstGetter).toHaveBeenCalledOnce()
    expect(secondGetter).not.toHaveBeenCalled()
  })

  test('unregisters the context when the surface becomes inactive', () => {
    const request = createRequest('task-1')
    const view = renderHook(
      ({ active }) => {
        useRegisteredFeedbackDialogContext(active, request)
        return useFeedbackDialogRequest()
      },
      { initialProps: { active: true } }
    )

    act(() => closeFeedbackDialog())
    view.rerender({ active: false })
    act(() => openFeedbackDialog())

    expect(view.result.current).toBe(EMPTY_FEEDBACK_DIALOG_REQUEST)
  })
})
