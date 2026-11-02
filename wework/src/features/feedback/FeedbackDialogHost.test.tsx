import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { FeedbackDialogHost } from './FeedbackDialogHost'
import { GlobalFeedbackButton } from './GlobalFeedbackButton'
import type { FeedbackApi } from './TaskFeedbackDialog'
import {
  EMPTY_FEEDBACK_DIALOG_REQUEST,
  closeFeedbackDialog,
  openFeedbackDialog,
  registerFeedbackDialogContext,
  type FeedbackDialogRequest,
} from './feedbackDialogStore'

vi.mock('./TaskFeedbackDialog', () => ({
  TaskFeedbackDialog: ({
    open,
    hasActiveTask,
    getTaskContext,
    feedbackApi,
    onClose,
  }: {
    open: boolean
    hasActiveTask: boolean
    getTaskContext: () => Promise<Record<string, unknown>>
    feedbackApi?: FeedbackApi
    onClose: () => void
  }) =>
    open ? (
      <div
        data-testid="task-feedback-dialog"
        data-active={String(hasActiveTask)}
        data-has-feedback-api={String(Boolean(feedbackApi))}
      >
        <button
          type="button"
          data-testid="read-feedback-context"
          onClick={() => void getTaskContext()}
        >
          context
        </button>
        <button type="button" data-testid="close-feedback-dialog" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}))

function createRequest(taskId: string): FeedbackDialogRequest {
  return {
    hasActiveTask: true,
    getTaskContext: async () => ({ task: { taskId } }),
  }
}

beforeEach(() => {
  closeFeedbackDialog()
  registerFeedbackDialogContext(() => EMPTY_FEEDBACK_DIALOG_REQUEST)()
})

describe('FeedbackDialogHost', () => {
  test('does not render a dialog until one is opened', () => {
    render(<FeedbackDialogHost />)

    expect(screen.queryByTestId('task-feedback-dialog')).not.toBeInTheDocument()
  })

  test('renders the request and closes through the store', async () => {
    const user = userEvent.setup()
    render(<FeedbackDialogHost />)

    act(() => openFeedbackDialog(createRequest('task-1')))
    expect(screen.getByTestId('task-feedback-dialog')).toHaveAttribute('data-active', 'true')

    await user.click(screen.getByTestId('close-feedback-dialog'))
    expect(screen.queryByTestId('task-feedback-dialog')).not.toBeInTheDocument()
  })

  test('forwards the task context and feedback API to the dialog', async () => {
    const user = userEvent.setup()
    const getTaskContext = vi.fn(async () => ({ task: { taskId: 'task-1' } }))
    const feedbackApi: FeedbackApi = { submit: vi.fn() }
    render(<FeedbackDialogHost />)

    act(() =>
      openFeedbackDialog({
        hasActiveTask: true,
        getTaskContext,
        feedbackApi,
      })
    )

    expect(screen.getByTestId('task-feedback-dialog')).toHaveAttribute(
      'data-has-feedback-api',
      'true'
    )
    await user.click(screen.getByTestId('read-feedback-context'))
    expect(getTaskContext).toHaveBeenCalledOnce()
  })

  test('keeps an open dialog when its task context is unregistered', () => {
    const unregister = registerFeedbackDialogContext(() => createRequest('task-1'))
    render(<FeedbackDialogHost />)

    act(() => openFeedbackDialog())
    unregister()

    expect(screen.getByTestId('task-feedback-dialog')).toHaveAttribute('data-active', 'true')
  })

  test('global feedback button always opens without task context', async () => {
    const user = userEvent.setup()
    registerFeedbackDialogContext(() => createRequest('task-1'))
    render(
      <>
        <GlobalFeedbackButton />
        <FeedbackDialogHost />
      </>
    )

    await user.click(screen.getByTestId('topnav-feedback-button'))

    expect(screen.getByTestId('task-feedback-dialog')).toHaveAttribute('data-active', 'false')
  })
})
