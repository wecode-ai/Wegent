import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { GlobalFeedbackButton } from './GlobalFeedbackButton'
import {
  EMPTY_FEEDBACK_DIALOG_REQUEST,
  closeFeedbackDialog,
  registerFeedbackDialogContext,
  useFeedbackDialogRequest,
} from './feedbackDialogStore'

beforeEach(() => {
  closeFeedbackDialog()
  registerFeedbackDialogContext(() => EMPTY_FEEDBACK_DIALOG_REQUEST)()
})

test('opens the feedback dialog with the active surface context', () => {
  const request = {
    hasActiveTask: true,
    deviceId: 'device-1',
    taskId: 'task-1',
    getTaskContext: vi.fn(async () => ({ task: { taskId: 'task-1' } })),
  }
  registerFeedbackDialogContext(() => request)
  const view = renderHook(() => useFeedbackDialogRequest())
  render(<GlobalFeedbackButton />)

  fireEvent.click(screen.getByTestId('topnav-feedback-button'))

  expect(view.result.current).toBe(request)
})
