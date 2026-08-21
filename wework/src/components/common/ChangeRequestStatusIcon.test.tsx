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

  it('supports positioning the trigger and opening the popover toward the content area', async () => {
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

    expect(screen.getByTestId('positioned-change-request-popover')).toHaveClass('left-0')
    expect(screen.getByTestId('positioned-change-request-popover')).not.toHaveClass('right-0')
  })
})
