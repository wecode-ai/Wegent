import { fireEvent, render, screen } from '@testing-library/react'
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
    onLogout: vi.fn(),
  }

  test('renders projects, recent tasks, and empty prompt', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
    expect(screen.getByText('我们该做什么？')).toBeInTheDocument()
  })

  test('renders project-specific empty prompt after selecting a project', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: { id: 1, name: 'gitlab-wegent', tasks: [] },
        }}
      />
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '我们应该在 gitlab-wegent 中构建什么？'
    )
  })

  test('keeps the empty composer at the intended desktop proportion', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('desktop-empty-composer-frame')).toHaveClass(
      'w-[min(90%,62rem)]',
      'max-w-full',
    )
  })

  test('restores and stores sidebar width in localStorage', () => {
    localStorage.setItem('wework.desktop.sidebar.width', '320')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '320px' })

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 360 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '360px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('360')
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

  test('opens the settings menu from the sidebar', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByText('个人账户')).toBeInTheDocument()
    expect(screen.getAllByText('设置')).toHaveLength(2)
    expect(screen.getByText('剩余用量')).toBeInTheDocument()
    expect(screen.getByText('退出登录')).toBeInTheDocument()
  })

  test('opens the independent connection settings page from the settings menu', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('settings-menu-button'))

    expect(screen.getByTestId('wework-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-back-button')).toHaveTextContent('返回')
    expect(screen.queryByText('返回应用')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '连接' })).toBeInTheDocument()
    expect(screen.getByText('连接设备')).toBeInTheDocument()
    expect(screen.queryByText('连接这台设备')).not.toBeInTheDocument()
    expect(screen.queryByText('链接这台设备')).not.toBeInTheDocument()
    expect(screen.queryByText('控制其他设备')).not.toBeInTheDocument()
    expect(screen.queryByText('SSH')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-connections')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-projects')).toBeInTheDocument()
    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-general')).not.toBeInTheDocument()
    expect(screen.queryByText('Personal Devices')).not.toBeInTheDocument()
    expect(screen.queryByText('Linux-Device-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.getByText('可连接的设备')).toBeInTheDocument()
    expect(screen.queryByText('可连接这台设备的云设备')).not.toBeInTheDocument()
    expect(screen.getByText('云设备')).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-device-icon-24a59054-4638-4744-983d-372706c30fcd'),
    ).toHaveClass('text-[#3c4043]')
    expect(
      screen.getByTestId('connection-device-icon-24a59054-4638-4744-983d-372706c30fcd'),
    ).not.toHaveClass('bg-[#f7f7f8]')
    expect(screen.getByText('yunpeng7-executor-372706c30fcd')).toBeInTheDocument()
    expect(screen.getByText('v1.712')).toBeInTheDocument()
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('Online')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('connection-terminal-button-24a59054-4638-4744-983d-372706c30fcd'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-code-server-button-24a59054-4638-4744-983d-372706c30fcd'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-vnc-button-24a59054-4638-4744-983d-372706c30fcd'),
    ).toBeInTheDocument()
    expect(screen.getByText('终端')).toBeInTheDocument()
    expect(screen.getByText('IDE')).toBeInTheDocument()
    expect(screen.getByText('桌面')).toBeInTheDocument()
    expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    expect(screen.queryByText('Code Server')).not.toBeInTheDocument()
    expect(screen.queryByText('桌面 VNC')).not.toBeInTheDocument()
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('MEM')).toBeInTheDocument()
    expect(screen.getByText('磁盘')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('68%')).toBeInTheDocument()
    expect(screen.getByText('57%')).toBeInTheDocument()
    expect(screen.getByTestId('connection-scale-wiki')).toBeInTheDocument()
    expect(screen.getByText('说明')).toBeInTheDocument()
    expect(screen.queryByText('扩容 Wiki')).not.toBeInTheDocument()
    expect(screen.getByText(/持续超过 80%/)).toBeInTheDocument()
    expect(screen.queryByText('a8791aa3-4e8a-4076-b9a6-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.queryByText('Nevis')).not.toBeInTheDocument()
    expect(screen.queryByText('Cloud computing powered by Nevis')).not.toBeInTheDocument()
    expect(screen.queryByText('其他设置')).not.toBeInTheDocument()
    expect(screen.queryByText('Start Task')).not.toBeInTheDocument()
  })

  test('opens and resizes the right workspace panel', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const panel = screen.getByTestId('right-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByText('浏览器')).toBeInTheDocument()
    expect(screen.getByText('终端')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 700 })
    fireEvent.pointerMove(document, { clientX: 640 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ width: '480px' })
  })

  test('opens and resizes the bottom workspace panel', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByText('浏览器')).toBeInTheDocument()
    expect(screen.getByText('终端')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('bottom-workspace-resize-handle'), { clientY: 700 })
    fireEvent.pointerMove(document, { clientY: 620 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ height: '400px' })
  })
})
