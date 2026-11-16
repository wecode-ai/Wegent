import '@/i18n'
import type { IMPrivateSession } from '@/types/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ImSessionPickerDialog } from './ImSessionPickerDialog'

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
    mode: index % 2 === 0 ? 'stand_in' : 'chat',
    last_seen_at: '2026-06-20T00:00:00.000Z',
  }
}

describe('ImSessionPickerDialog', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('preselects the first available private IM session', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <ImSessionPickerDialog
        open
        loading={false}
        submitting={false}
        sessions={[createSession(1, 'Alice'), createSession(2, 'Bob')]}
        autoSubmitSingle
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
    expect(onSubmit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['session-1']))
  })

  test('submits selected session keys', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)

    render(
      <ImSessionPickerDialog
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
})
