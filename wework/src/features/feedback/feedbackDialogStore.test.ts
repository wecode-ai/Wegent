import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
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

    expect(result.current).toBe(request)
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

    expect(result.current).toBe(request)
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

    expect(view.result.current).toBe(second)
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
