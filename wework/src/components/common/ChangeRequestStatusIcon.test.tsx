import { render, screen } from '@testing-library/react'
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
})
