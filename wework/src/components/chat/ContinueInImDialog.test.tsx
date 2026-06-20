import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { IMPrivateSession } from '@/types/api'
import { ContinueInImDialog } from './ContinueInImDialog'

function createSession(id: number, displayName: string): IMPrivateSession {
  return {
    id,
    channel_type: 'wecom',
    channel_label: 'WeCom',
    channel_id: 100 + id,
    conversation_id: `conversation-${id}`,
    sender_id: `sender-${id}`,
    display_name: displayName,
    mode: id % 2 === 0 ? 'task' : 'chat',
    state: 'idle',
    active_task_id: null,
    last_seen_at: '2026-06-20T00:00:00.000Z',
  }
}

describe('ContinueInImDialog', () => {
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

  test('submits selected session ids', async () => {
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

    await userEvent.click(screen.getByTestId('continue-im-session-1'))
    await userEvent.click(screen.getByTestId('continue-im-session-2'))
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([1, 2]))
  })
})
