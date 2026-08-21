import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PullRequestAutomationSettings } from './PullRequestAutomationSettings'

describe('PullRequestAutomationSettings', () => {
  it('saves enabled state, selected failures and custom repair instructions', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <PullRequestAutomationSettings
        value={{
          enabled: false,
          statuses: ['checks_failed', 'merge_queue_failed'],
          prompt: '',
        }}
        canManage
        busy={false}
        onSave={onSave}
      />
    )

    fireEvent.click(screen.getByTestId('pull-request-automation-enabled'))
    fireEvent.click(screen.getByTestId('pull-request-automation-status-merge_conflict'))
    fireEvent.change(screen.getByTestId('pull-request-automation-prompt'), {
      target: { value: '先阅读完整失败日志' },
    })
    fireEvent.blur(screen.getByTestId('pull-request-automation-prompt'))

    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          statuses: expect.arrayContaining([
            'checks_failed',
            'merge_queue_failed',
            'merge_conflict',
          ]),
          prompt: '先阅读完整失败日志',
        })
      )
    )
  })
})
