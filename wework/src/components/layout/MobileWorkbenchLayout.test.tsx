import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { MobileWorkbenchLayout } from './MobileWorkbenchLayout'

const baseState = {
  user: { id: 1, user_name: 'MI', email: 'mi@example.com' },
  defaultTeam: null,
  projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
  recentTasks: [
    {
      id: 3,
      title: '远程连接 Claude Code',
      status: 'COMPLETED',
      task_type: 'code' as const,
      created_at: '2026-05-25T00:00:00.000Z',
    },
  ],
  currentProject: null,
  currentTask: null,
  input: '',
  isBootstrapping: false,
  isSending: false,
  error: null,
}

describe('MobileWorkbenchLayout', () => {
  test('opens drawer with projects and recent tasks', async () => {
    render(
      <MobileWorkbenchLayout
        state={baseState}
        messages={[]}
        onSelectProject={vi.fn()}
        onOpenTask={vi.fn()}
        onInputChange={vi.fn()}
        onSend={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('open-mobile-drawer-button'))

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
  })
})
