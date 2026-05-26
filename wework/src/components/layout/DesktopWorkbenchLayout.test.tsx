import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DesktopWorkbenchLayout } from './DesktopWorkbenchLayout'

describe('DesktopWorkbenchLayout', () => {
  const baseProps = {
    state: {
      user: null,
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
    },
    messages: [],
    onSelectProject: vi.fn(),
    onOpenTask: vi.fn(),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
  }

  test('renders projects, recent tasks, and empty prompt', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
    expect(screen.getByText('我们该做什么？')).toBeInTheDocument()
  })

  test('collapses and expands the sidebar', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
      />,
    )

    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.queryByText('新对话')).not.toBeInTheDocument()
    expect(document.querySelector('aside')).not.toBeInTheDocument()
    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))

    expect(screen.getByText('新对话')).toBeInTheDocument()
    expect(document.querySelector('aside')).toBeInTheDocument()
  })
})
