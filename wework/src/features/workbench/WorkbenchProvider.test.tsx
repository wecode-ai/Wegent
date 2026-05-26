import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'

function Probe() {
  const { state } = useWorkbench()
  return (
    <div data-testid="probe">
      {state.isBootstrapping ? 'loading' : state.user?.user_name}
    </div>
  )
}

describe('WorkbenchProvider', () => {
  test('bootstraps current user, default team, projects, and recent tasks', async () => {
    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          projectApi: { listProjects: vi.fn().mockResolvedValue({ items: [] }) },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <Probe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('alice')
    )
  })
})
