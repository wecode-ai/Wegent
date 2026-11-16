import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ChangeRequestStatusIcon } from './ChangeRequestStatusIcon'

describe('ChangeRequestStatusIcon', () => {
  it('closes the popover on outside pointer down and Escape', async () => {
    const snapshot: TaskChangeRequestSnapshot = {
      target: {
        deviceId: 'local',
        taskId: 'task-48',
        workspacePath: '/workspace',
        remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
        branch: 'feature/pr-status',
      },
      changeRequest: {
        provider: 'github',
        number: 48,
        url: 'https://github.com/wecode-ai/Wegent/pull/48',
        title: 'Show PR status',
        state: 'open',
        draft: false,
        checks: 'failure',
        mergeability: 'conflicting',
        mergeQueue: 'not_queued',
      },
      fetchedAt: '2026-08-21T00:00:00Z',
      stale: false,
      error: null,
    }

    render(
      <div>
        <ChangeRequestStatusIcon snapshot={snapshot} testId="dismissible-change-request" />
        <button type="button">Outside</button>
      </div>
    )

    const trigger = screen.getByTestId('dismissible-change-request')
    await userEvent.click(trigger)
    expect(screen.getByTestId('dismissible-change-request-popover')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByTestId('dismissible-change-request-popover')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('dismissible-change-request-popover')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
