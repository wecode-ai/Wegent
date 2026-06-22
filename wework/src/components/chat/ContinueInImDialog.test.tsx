import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { IMPrivateSession } from '@/types/api'
import { ContinueInImDialog } from './ContinueInImDialog'

function createSession(
  index: number,
  displayName: string,
  channelLabel = 'WeCom'
): IMPrivateSession {
  return {
    session_key: `session-${index}`,
    channel_type: 'wecom',
    channel_label: channelLabel,
    channel_id: 100 + index,
    conversation_id: `conversation-${index}`,
    sender_id: `sender-${index}`,
    display_name: displayName,
    mode: index % 2 === 0 ? 'task' : 'chat',
    state: 'idle',
    active_task_id: null,
    last_seen_at: '2026-06-20T00:00:00.000Z',
  }
}

describe('ContinueInImDialog', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('shows the empty binding guide with slash bind command', () => {
    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('continue-im-empty-guide')).toHaveTextContent('/bind')
  })

  test('preselects the first available private IM session', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice'), createSession(2, 'Bob')]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    expect(screen.getByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('continue-im-session-session-2')).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['session-1']))
  })

  test('submits selected session keys', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice'), createSession(2, 'Bob')]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    await userEvent.click(screen.getByTestId('continue-im-session-session-2'))
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['session-1', 'session-2']))
  })

  test('remembers submitted private IM sessions for the next open', async () => {
    const firstSubmit = vi.fn().mockResolvedValue(undefined)
    const { unmount } = render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice'), createSession(2, 'Bob')]}
        onClose={vi.fn()}
        onSubmit={firstSubmit}
      />
    )

    await userEvent.click(screen.getByTestId('continue-im-session-session-1'))
    await userEvent.click(screen.getByTestId('continue-im-session-session-2'))
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    await waitFor(() => expect(firstSubmit).toHaveBeenCalledWith(['session-2']))
    unmount()

    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice'), createSession(2, 'Bob')]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('continue-im-session-session-2')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  test('shows channel labels in session rows', () => {
    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice', 'Telegram')]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    const session = screen.getByTestId('continue-im-session-session-1')
    expect(session).toHaveTextContent('Alice')
    expect(session).toHaveTextContent('Telegram')
  })

  test('does not close from backdrop or Escape while submitting', async () => {
    const onClose = vi.fn()

    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting
        sessions={[createSession(1, 'Alice')]}
        onClose={onClose}
        onSubmit={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('continue-im-dialog-overlay'))
    await userEvent.keyboard('{Escape}')

    expect(onClose).not.toHaveBeenCalled()
  })

  test('focuses the close button and traps tab focus while open', async () => {
    render(
      <ContinueInImDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice')]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByTestId('continue-im-close-button')).toHaveFocus()

    screen.getByTestId('continue-im-close-button').focus()
    await userEvent.tab({ shift: true })
    expect(screen.getByTestId('continue-im-submit-button')).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByTestId('continue-im-close-button')).toHaveFocus()
  })
})
