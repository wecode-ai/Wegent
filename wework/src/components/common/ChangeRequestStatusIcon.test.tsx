import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { ChangeRequestStatusIcon } from './ChangeRequestStatusIcon'

describe('ChangeRequestStatusIcon', () => {
  it('renders merged change requests with a violet icon', () => {
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
        state: 'merged',
        draft: false,
        checks: 'success',
        mergeability: 'mergeable',
        mergeQueue: 'not_queued',
      },
      fetchedAt: '2026-08-21T00:00:00Z',
      stale: false,
      error: null,
    }

    render(<ChangeRequestStatusIcon snapshot={snapshot} testId="merged-change-request" />)

    expect(screen.getByTestId('merged-change-request').querySelector('svg')).toHaveClass(
      'text-violet-500'
    )
  })

  it('renders merge queue change requests with yellow icons', () => {
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
        title: 'Wait for merge queue',
        state: 'open',
        draft: false,
        checks: 'pending',
        mergeability: 'mergeable',
        mergeQueue: 'queued',
      },
      fetchedAt: '2026-08-21T00:00:00Z',
      stale: false,
      error: null,
    }

    render(<ChangeRequestStatusIcon snapshot={snapshot} testId="queued-change-request" />)

    expect(screen.getByTestId('queued-change-request').querySelectorAll('svg')).toHaveLength(2)
    expect(screen.getByTestId('queued-change-request').querySelectorAll('svg')[0]).toHaveClass(
      'text-amber-500'
    )
    expect(
      screen.getByTestId('queued-change-request').querySelectorAll('svg')[1].parentElement
    ).toHaveClass('text-amber-500')
  })

  it('renders the popover in the document layer so parent overflow cannot clip it', async () => {
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
        checks: 'pending',
        mergeability: 'unknown',
        mergeQueue: 'not_queued',
      },
      fetchedAt: '2026-08-21T00:00:00Z',
      stale: false,
      error: null,
    }

    render(
      <ChangeRequestStatusIcon
        snapshot={snapshot}
        testId="positioned-change-request"
        className="-ml-7 mr-1"
        popoverAlign="left"
      />
    )

    const trigger = screen.getByTestId('positioned-change-request')
    expect(trigger.parentElement?.parentElement).toHaveClass('-ml-7', 'mr-1')

    await userEvent.click(trigger)

    const popover = screen.getByTestId('positioned-change-request-popover')
    expect(popover.parentElement).toBe(document.body)
    expect(popover).toHaveClass('fixed', 'z-system-popover')
  })

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
