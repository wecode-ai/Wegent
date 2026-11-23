import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { StandInProcessingNotice } from './StandInProcessingNotice'

it('offers connection settings only for a verified owner-mismatch failure', () => {
  const onOpenConnectionSettings = vi.fn()
  const props = {
    api: undefined,
    userId: 0,
    deviceId: 'mac',
    onOpen: vi.fn(),
    onOpenConnectionSettings,
  }
  const snapshot = {
    status: {
      pendingCount: 1,
      running: false,
      actions: [],
      error: {
        code: 'permission_denied',
        message: 'The requested owner must match the connected account',
      },
    },
    error: null,
    setStatus: vi.fn(),
    setError: vi.fn(),
  }
  const { rerender } = render(<StandInProcessingNotice {...props} snapshot={snapshot} />)

  expect(screen.getByRole('alert').textContent).toContain('本地助理的后台评估被拒绝')
  fireEvent.click(screen.getByRole('button', { name: '检查云端连接' }))
  expect(onOpenConnectionSettings).toHaveBeenCalledOnce()

  rerender(
    <StandInProcessingNotice
      {...props}
      snapshot={{
        ...snapshot,
        status: {
          ...snapshot.status,
          error: { code: 'permission_denied', message: 'Project access denied' },
        },
      }}
    />
  )
  expect(screen.queryByRole('button', { name: '检查云端连接' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('无权执行此操作')
})
