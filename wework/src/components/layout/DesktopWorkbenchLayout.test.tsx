import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from '@/api/devices'
import { createQuotaApi } from '@/api/quota'
import { DesktopWorkbenchLayout } from './DesktopWorkbenchLayout'

function createRect({
  left,
  top,
  width,
  height,
}: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => ({ appBasePath: '', apiBaseUrl: '/api' }),
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn(() => ({})),
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/api/quota', () => ({
  createQuotaApi: vi.fn(),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createQuotaApiMock = vi.mocked(createQuotaApi)
const fetchQuotaMock = vi.fn()

describe('DesktopWorkbenchLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    window.history.pushState({}, '', '/')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    Element.prototype.scrollIntoView = vi.fn()
    fetchQuotaMock.mockResolvedValue({
      quota: 748,
      usage: 747.74,
      remaining: 0.26,
      usage_rate: 0.9997,
      user: 'yunpeng7',
    })
    createQuotaApiMock.mockReturnValue({
      fetchQuota: fetchQuotaMock,
    })
    createDeviceApiMock.mockReturnValue({
      getHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
      getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
      listDirectories: vi.fn().mockResolvedValue([]),
      executeCommand: vi.fn(),
      getAllDevices: vi.fn().mockResolvedValue([
        {
          id: 1,
          device_id: '24a59054-4638-4744-983d-372706c30fcd',
          name: 'yunpeng7-executor-372706c30fcd',
          status: 'online',
          is_default: false,
          device_type: 'cloud',
          bind_shell: 'claudecode',
          executor_version: '1.712',
          cpu_usage: 42,
          memory_usage: 68,
          disk_usage: 57,
        },
      ]),
      startTerminal: vi.fn(),
      startCodeServer: vi.fn(),
      createCloudDevice: vi.fn(),
      renameDevice: vi.fn(),
      restartCloudDevice: vi.fn(),
      deleteCloudDevice: vi.fn(),
      getMetrics: vi.fn().mockResolvedValue({
        cpu_usage: 42,
        memory_usage: 68,
        disk_usage: 57,
      }),
      getMetricsHistory: vi.fn().mockResolvedValue({
        cpu: [],
        memory: [],
        disk: [],
      }),
      getVncConfig: vi.fn(),
    })
  })

  const baseProps = {
    state: {
      user: null,
      defaultTeam: null,
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      recentTasks: [
        {
          id: 3,
          title: '远程连接 Claude Code',
          status: 'COMPLETED',
          task_type: 'code' as const,
          created_at: '2026-05-25T00:00:00.000Z',
          updated_at: '2026-05-25T08:30:00.000Z',
        },
      ],
      currentProject: null,
      standaloneDeviceId: null,
      currentTask: null,
      input: '',
      isBootstrapping: false,
      isSending: false,
      error: null,
    },
    messages: [],
    runningTaskIds: new Set<number>(),
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
    onOpenPlugins: vi.fn(),
    projectChat: {
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      isAttachmentReadyToSend: true,
      setSelectedModel: vi.fn(),
      setSelectedModelOption: vi.fn(),
      setSelectedSkills: vi.fn(),
      toggleSkill: vi.fn(),
      handleFileSelect: vi.fn(),
      addExistingAttachment: vi.fn(),
      removeAttachment: vi.fn(),
      resetAttachments: vi.fn(),
      listLocalSkills: vi.fn().mockResolvedValue([]),
    },
    projectWork: {
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      currentProjectId: undefined,
      onSelectProject: vi.fn(),
    },
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenTask: vi.fn(),
    onSearchTaskDetail: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGitWorkspaceProject: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onArchiveAllChats: vi.fn(),
    onArchiveAllProjectChats: vi.fn(),
    onArchiveProjectChats: vi.fn(),
    onArchiveTask: vi.fn(),
    onRenameTask: vi.fn(),
    onListArchivedTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
    onUnarchiveTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onDeleteArchivedTasks: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
    onGetProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
    onListDeviceDirectories: vi.fn(),
    onCreateDeviceDirectory: vi.fn(),
    onListGitRepositories: vi.fn().mockResolvedValue([]),
    onListGitBranches: vi.fn().mockResolvedValue([]),
    onLoadEnvironmentInfo: vi.fn().mockResolvedValue({
      additions: '+173',
      deletions: '-13366',
      executionTarget: 'local' as const,
      deviceId: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
      branchName: 'human/narwhal-20260528-073440',
      createPullRequestUrl:
        'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
    }),
    onCommitEnvironmentChanges: vi.fn().mockResolvedValue(undefined),
    onListEnvironmentBranches: vi.fn().mockResolvedValue([
      'main',
      'human/chipmunk-20260603-053420',
      'human/narwhal-20260528-073440',
    ]),
    onCheckoutEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onCreateEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
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
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.queryByTestId('automation-button')).not.toBeInTheDocument()
  })

  test('collapses and expands project and chat sections from the sidebar headers', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('projects-section-chevron-down')).toHaveClass('opacity-0')
    expect(screen.getByText('github_wegent')).toBeInTheDocument()
    expect(screen.getByTestId('chats-section-chevron-down')).toHaveClass('opacity-0')
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('projects-section-toggle'))

    expect(screen.getByTestId('projects-section-chevron-right')).toHaveClass('opacity-0')
    expect(screen.queryByText('github_wegent')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('projects-section-toggle'))

    expect(screen.getByTestId('projects-section-chevron-down')).toHaveClass('opacity-0')
    expect(screen.getByText('github_wegent')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('chats-section-toggle'))

    expect(screen.getByTestId('chats-section-chevron-right')).toHaveClass('opacity-0')
    expect(screen.queryByText('远程连接 Claude Code')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('chats-section-toggle'))

    expect(screen.getByTestId('chats-section-chevron-down')).toHaveClass('opacity-0')
    expect(screen.getByText('远程连接 Claude Code')).toBeInTheDocument()
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
      'w-[min(58vw,62rem)]',
      'min-w-[32rem]',
      'max-w-[calc(100vw-4rem)]',
      '-translate-y-12',
    )
  })

  test('renders the conversation composer as a floating overlay', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />,
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass(
      'h-full',
      'overflow-y-auto',
      'pb-52',
    )
    expect(screen.getByTestId('desktop-floating-composer-backdrop')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'bottom-0',
      'z-10',
      'from-background',
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'bottom-4',
      'left-1/2',
      'z-chrome',
      '-translate-x-1/2',
    )
    expect(screen.getByTestId('desktop-floating-composer-card')).toHaveClass(
      'pointer-events-auto',
    )
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
  })

  test('positions the scroll-to-bottom button above the floating composer', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Long reply',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />,
    )

    const scroller = screen.getByTestId('desktop-chat-scroll')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })

    fireEvent.scroll(scroller)

    expect(screen.getByTestId('scroll-to-bottom-button')).toHaveClass(
      'bottom-36',
      'z-popover',
    )
  })

  test('reserves extra bottom space when queued messages are shown above the composer', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        queuedMessages={[
          {
            id: 'queued-1',
            content: '你叫什么',
            status: 'failed',
            error: '发送失败',
            createdAt: '2026-05-29T00:01:00.000Z',
          },
        ]}
      />,
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass('pb-72')
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass('pb-52')
  })

  test('restores and stores sidebar width in localStorage', () => {
    localStorage.setItem('wework.desktop.sidebar.width', '230')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '230px' })

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 235 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '235px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('235')
  })

  test('uses the selected sidebar width as the default', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '220px' })
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

  test('opens and filters the desktop search dialog from the sidebar', async () => {
    const onOpenTask = vi.fn()
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onOpenTask={onOpenTask}
        state={{
          ...baseProps.state,
          projects: [
            {
              id: 9,
              name: 'New project 5',
              tasks: [
                {
                  id: 90,
                  task_id: 90,
                  task_title: '创建OKR系统',
                  task_status: 'COMPLETED',
                  updated_at: '2026-05-31T10:00:00.000Z',
                },
              ],
            },
          ],
          recentTasks: [
            {
              id: 91,
              title: '修复 git pull 失败',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: '2026-05-30T00:00:00.000Z',
              updated_at: '2026-05-30T08:30:00.000Z',
            },
          ],
        }}
      />,
    )

    expect(screen.queryByTestId('desktop-search-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('search-button'))

    const dialog = screen.getByTestId('desktop-search-dialog')
    expect(dialog.closest('.fixed')).toHaveClass('z-critical')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByTestId('desktop-search-input')).toHaveFocus()
    expect(within(dialog).getByText('近期对话')).toBeInTheDocument()
    expect(within(dialog).getByText('创建OKR系统')).toBeInTheDocument()
    expect(within(dialog).getByText('New project 5')).toBeInTheDocument()
    expect(within(dialog).getByText('修复 git pull 失败')).toBeInTheDocument()
    expect(within(dialog).queryByText('#1')).not.toBeInTheDocument()

    await userEvent.type(screen.getByTestId('desktop-search-input'), 'okr')

    expect(within(dialog).getByText('创建OKR系统')).toBeInTheDocument()
    expect(within(dialog).queryByText('修复 git pull 失败')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('desktop-search-result-90'))

    expect(onOpenTask).toHaveBeenCalledWith(90, 9)
    expect(screen.queryByTestId('desktop-search-dialog')).not.toBeInTheDocument()
  })

  test('searches inside conversation messages from task details', async () => {
    const onOpenTask = vi.fn()
    const onSearchTaskDetail = vi.fn().mockImplementation(async (taskId: number) => ({
      id: taskId,
      title: 'hi',
      status: 'COMPLETED',
      task_type: 'code',
      created_at: '2026-05-30T00:00:00.000Z',
      updated_at: '2026-05-30T08:30:00.000Z',
      subtasks: [
        {
          id: 101,
          task_id: taskId,
          role: 'assistant',
          status: 'COMPLETED',
          result: { value: '这是关于胡云鹏的回复内容' },
          created_at: '2026-05-30T08:31:00.000Z',
        },
      ],
    }))

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onOpenTask={onOpenTask}
        onSearchTaskDetail={onSearchTaskDetail}
        state={{
          ...baseProps.state,
          recentTasks: [
            {
              id: 91,
              title: 'hi',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: '2026-05-30T00:00:00.000Z',
              updated_at: '2026-05-30T08:30:00.000Z',
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('search-button'))
    await userEvent.type(screen.getByTestId('desktop-search-input'), '胡云鹏')

    const dialog = screen.getByTestId('desktop-search-dialog')
    expect(await within(dialog).findByText('hi')).toBeInTheDocument()
    expect(onSearchTaskDetail).toHaveBeenCalledWith(91)

    await userEvent.click(screen.getByTestId('desktop-search-result-91'))

    expect(onOpenTask).toHaveBeenCalledWith(91, 0)
  })

  test('searches remote conversation content beyond loaded sidebar tasks', async () => {
    const onOpenTask = vi.fn()
    const onSearchTasks = vi.fn().mockResolvedValue({
      total: 1,
      items: [
        {
          id: 92,
          title: 'hi',
          status: 'COMPLETED',
          task_type: 'code',
          project_id: 9,
          created_at: '2026-05-30T00:00:00.000Z',
          updated_at: '2026-05-30T08:30:00.000Z',
        },
      ],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onOpenTask={onOpenTask}
        onSearchTasks={onSearchTasks}
        state={{
          ...baseProps.state,
          projects: [
            {
              id: 9,
              name: '文档',
              tasks: [],
            },
          ],
          recentTasks: [],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('search-button'))
    await userEvent.type(screen.getByTestId('desktop-search-input'), '胡云鹏')

    const dialog = screen.getByTestId('desktop-search-dialog')
    expect(await within(dialog).findByText('hi')).toBeInTheDocument()
    expect(within(dialog).getByText('文档')).toBeInTheDocument()
    expect(onSearchTasks).toHaveBeenCalledWith('胡云鹏')

    await userEvent.click(screen.getByTestId('desktop-search-result-92'))

    expect(onOpenTask).toHaveBeenCalledWith(92, 9)
  })

  test('does not load local task details when remote search is available', async () => {
    const onSearchTasks = vi.fn().mockResolvedValue({ total: 0, items: [] })
    const onSearchTaskDetail = vi.fn().mockResolvedValue({ subtasks: [] })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onSearchTasks={onSearchTasks}
        onSearchTaskDetail={onSearchTaskDetail}
        state={{
          ...baseProps.state,
          recentTasks: [
            {
              id: 91,
              title: 'hi',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: '2026-05-30T00:00:00.000Z',
              updated_at: '2026-05-30T08:30:00.000Z',
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('search-button'))
    await userEvent.type(screen.getByTestId('desktop-search-input'), 'ubuntu')

    await waitFor(() => expect(onSearchTasks).toHaveBeenCalledWith('ubuntu'))

    expect(onSearchTaskDetail).not.toHaveBeenCalled()
  })

  test('expands and scrolls to the current project task after opening from search', async () => {
    const projectTasks = Array.from({ length: 7 }, (_, index) => ({
      id: 900 + index,
      task_id: 900 + index,
      task_title: `项目会话 ${index + 1}`,
      task_status: 'COMPLETED',
      created_at: `2026-05-30T0${index}:00:00.000Z`,
      updated_at: `2026-05-30T0${index}:30:00.000Z`,
    }))
    const selectedTask = projectTasks[6]

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [
            {
              id: 9,
              name: '文档',
              tasks: projectTasks,
            },
          ],
          currentProject: {
            id: 9,
            name: '文档',
            tasks: projectTasks,
          },
          currentTask: {
            id: selectedTask.task_id,
            title: selectedTask.task_title,
            status: 'COMPLETED',
            task_type: 'code',
            project_id: 9,
            created_at: selectedTask.created_at,
            updated_at: selectedTask.updated_at,
          },
        }}
      />,
    )

    const selectedRow = await screen.findByTestId(
      `project-chat-row-${selectedTask.task_id}`,
    )

    expect(selectedRow).toHaveTextContent('项目会话 7')
    expect(selectedRow).toHaveClass('bg-[rgb(var(--color-sidebar-active))]')
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
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

  test('opens settings page from the browser path on reload', () => {
    window.history.pushState({}, '', '/settings')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('wework-settings-page')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '我们该做什么？' })).not.toBeInTheDocument()
  })

  test('closes the settings menu when clicking outside it', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('heading', { name: '我们该做什么？' }))

    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('expands remaining usage details from the settings menu', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('usage-menu-button'))

    await waitFor(() => expect(fetchQuotaMock).toHaveBeenCalledTimes(1))

    const usagePanel = await screen.findByTestId('usage-detail-panel')
    expect(usagePanel).toHaveTextContent('模型额度')
    expect(usagePanel).toHaveTextContent('747.74 / 748 元')
    expect(usagePanel).toHaveTextContent('剩余 0.26 元')
    expect(usagePanel).not.toHaveTextContent('使用率')
    expect(usagePanel).not.toHaveTextContent('总额度')
    const quotaLink = await screen.findByRole('link', {
      name: '额度与计费说明',
    })
    expect(quotaLink).toHaveAttribute(
      'href',
      'https://space.intra.weibo.com/develop/model-quota'
    )
    expect(quotaLink).toHaveClass('text-text-secondary')
    expect(quotaLink).not.toHaveClass('text-primary')
  })

  test('shows project header menus and creates a scratch project workspace', async () => {
    const onCreateProject = vi.fn().mockResolvedValue({ id: 2, name: 'alpha', tasks: [] })
    const onRememberExecutionDevice = vi.fn()
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCreateProject={onCreateProject}
        onRememberExecutionDevice={onRememberExecutionDevice}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'local-executor',
              status: 'online',
              is_default: true,
            },
            {
              id: 2,
              device_id: 'cloud-device',
              name: 'cloud-executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('projects-more-button'))
    expect(screen.getByTestId('archive-all-chats-button')).toHaveTextContent('归档所有会话')
    await userEvent.click(screen.getByTestId('archive-all-chats-button'))
    expect(baseProps.onArchiveAllProjectChats).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-start-from-scratch-button'))

    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByTestId('project-device-select'), 'local-device')
    expect(onRememberExecutionDevice).toHaveBeenCalledWith('local-device')
    await userEvent.type(screen.getByTestId('project-name-input'), 'alpha app')
    expect(screen.queryByText(/\/workspace\/projects\/alpha-app/)).not.toBeInTheDocument()
    expect(screen.queryByText(/默认目录位于/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'alpha app',
          config: expect.objectContaining({
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'local-device',
            },
            workspace: {
              source: 'local_path',
              localPath: '/workspace/projects/alpha-app',
            },
          }),
        }),
      ),
    )
  })

  test('opens Git project creation from the project create menu', async () => {
    const onListGitRepositories = vi.fn().mockResolvedValue([
      {
        git_repo_id: 101,
        name: 'Wegent',
        git_repo: 'wecode-ai/Wegent',
        git_url: 'https://github.com/wecode-ai/Wegent.git',
        git_domain: 'github.com',
        namespace: 'wecode-ai',
        private: false,
        type: 'github',
      },
    ])
    const onListGitBranches = vi.fn().mockResolvedValue([
      { name: 'main', default: true, protected: false },
    ])
    const onCreateGitWorkspaceProject = vi.fn().mockResolvedValue({
      id: 9,
      name: 'Wegent',
      tasks: [],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-clone-from-git-button'))

    await waitFor(() => expect(onListGitRepositories).toHaveBeenCalledTimes(1))
    await userEvent.selectOptions(
      screen.getByTestId('git-repository-select'),
      'https://github.com/wecode-ai/Wegent.git',
    )
    await waitFor(() => expect(screen.getByTestId('git-branch-select')).toHaveValue('main'))
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onCreateGitWorkspaceProject).toHaveBeenCalledWith(
        expect.objectContaining({
          device_id: 'device-1',
          git: expect.objectContaining({
            url: 'https://github.com/wecode-ai/Wegent.git',
            branch: 'main',
          }),
        }),
      ),
    )
  })

  test('opens Git project dialog before device refresh completes', async () => {
    let resolveRefreshDevices: (() => void) | undefined
    let resolveRepositories: (() => void) | undefined
    const onRefreshDevices = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveRefreshDevices = resolve
        }),
    )
    const onListGitRepositories = vi.fn(
      () =>
        new Promise<[]>(resolve => {
          resolveRepositories = () => resolve([])
        }),
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        onListGitRepositories={onListGitRepositories}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-clone-from-git-button'))

    expect(screen.getByText('克隆 Git 仓库')).toBeInTheDocument()
    expect(screen.getByTestId('git-repository-select')).toBeDisabled()
    expect(screen.getByText('正在加载仓库...')).toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)

    resolveRefreshDevices?.()
    resolveRepositories?.()
  })

  test('keeps project create menu open until clicking outside', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    expect(screen.getByTestId('project-start-from-scratch-button')).toBeInTheDocument()

    fireEvent.pointerMove(document, { clientX: 500, clientY: 500 })
    expect(screen.getByTestId('project-start-from-scratch-button')).toBeInTheDocument()

    await userEvent.hover(screen.getByTestId('project-row-1'))
    expect(screen.getByTestId('project-start-from-scratch-button')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('project-start-from-scratch-button')).not.toBeInTheDocument()
  })

  test('renders project create menu as a body-level flyout to the right of the trigger', async () => {
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        const element = this as HTMLElement

        if (element.querySelector('[data-testid="projects-create-button"]')) {
          return createRect({ left: 104, top: 246, width: 28, height: 28 })
        }

        if (element.dataset.testid === 'projects-create-button-menu') {
          return createRect({ left: 0, top: 0, width: 176, height: 76 })
        }

        return createRect({ left: 0, top: 0, width: 0, height: 0 })
      })

    try {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 898,
      })
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 720,
      })

      render(<DesktopWorkbenchLayout {...baseProps} />)

      const trigger = screen.getByTestId('projects-create-button')
      await userEvent.click(trigger)

      const menu = screen.getByTestId('projects-create-button-menu')
      await waitFor(() => expect(menu).toHaveStyle({ left: '140px', top: '246px' }))
      expect(document.body).toContainElement(menu)
      expect(trigger.parentElement).not.toContainElement(menu)
    } finally {
      getBoundingClientRectSpy.mockRestore()
    }
  })

  test('renders project create dialog as a page-level overlay', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-existing-folder-button'))

    const dialog = screen.getByTestId('project-create-dialog')
    const overlay = dialog.parentElement

    expect(overlay).not.toBeNull()
    expect(document.body).toContainElement(overlay)
    expect(document.querySelector('aside')).not.toContainElement(overlay)
    expect(overlay).toHaveClass('fixed', 'inset-0')
  })

  test('opens blank project dialog from the project work menu add option', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const menu = screen.getByTestId('project-work-menu')
    const addProjectOption = screen.getByTestId('add-project-option')
    expect(
      [...menu.querySelectorAll('button')].map(button => button.dataset.testid),
    ).toEqual([
      'project-option-1',
      'add-project-option',
      'no-project-option',
    ])

    await userEvent.click(addProjectOption)
    expect(screen.getByTestId('create-project-submenu')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('project-start-from-scratch-option'))

    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    expect(screen.getByText('新建项目')).toBeInTheDocument()
    expect(screen.getByTestId('project-name-input')).toBeInTheDocument()
    expect(screen.getByTestId('create-project-button')).toHaveTextContent('创建项目')
  })

  test('creates a project from an existing folder selected in the directory tree', async () => {
    const onCreateProject = vi.fn().mockResolvedValue({ id: 2, name: 'repo', tasks: [] })
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['.cache', 'repo'])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCreateProject={onCreateProject}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'sifang-executor',
              status: 'online',
              is_default: true,
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-existing-folder-button'))

    await waitFor(() =>
      expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('device-1'),
    )
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu'),
    )
    expect(screen.queryByText('.cache')).not.toBeInTheDocument()
    expect(screen.queryByTestId('select-current-directory-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-name-input')).not.toBeInTheDocument()

    const repoEntry = await screen.findByText('repo')
    await userEvent.click(repoEntry)
    expect(onListDeviceDirectories).not.toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')

    await userEvent.click(screen.getByTestId('project-hidden-directories-toggle'))
    expect(screen.getByText('.cache')).toBeInTheDocument()

    await userEvent.dblClick(repoEntry)
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu/repo'),
    )

    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'repo',
          config: expect.objectContaining({
            workspace: {
              source: 'local_path',
              localPath: '/home/ubuntu/repo',
            },
          }),
        }),
      ),
    )
  })

  test('shows project row actions and chat row actions', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: { id: 1, name: 'publish', tasks: [] },
          currentTask: {
            id: 11,
            title: 'Implement archive',
            status: 'COMPLETED',
            task_type: 'code',
            created_at: twoHoursAgo,
            updated_at: twoHoursAgo,
          },
          projects: [
            {
              id: 1,
              name: 'publish',
              tasks: [
                {
                  id: 11,
                  task_id: 11,
                  task_title: 'Implement archive',
                  task_status: 'COMPLETED',
                  updated_at: twoHoursAgo,
                },
              ],
            },
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('project-new-conversation-button'))
    expect(baseProps.onStartNewProjectChat).toHaveBeenCalledWith(1)

    await userEvent.click(screen.getByTestId('project-menu-1'))
    expect(screen.getByTestId('project-menu-1-menu')).toHaveClass(
      'bg-background',
      'text-text-primary',
      'border-border',
    )
    expect(screen.getByTestId('rename-project-1')).toHaveTextContent('重命名项目')
    expect(screen.getByTestId('rename-project-1')).toHaveClass(
      'text-text-primary',
      'hover:bg-muted',
    )
    expect(screen.getByTestId('archive-project-chats-1')).toHaveTextContent('归档会话')
    expect(screen.getByTestId('remove-project-1')).toHaveTextContent('移除')
    expect(screen.getByTestId('remove-project-1')).toHaveClass(
      'text-red-500',
      'hover:bg-red-500/10',
    )

    await userEvent.click(screen.getByTestId('rename-project-1'))
    await userEvent.clear(screen.getByTestId('rename-project-input'))
    await userEvent.type(screen.getByTestId('rename-project-input'), 'publish-v2')
    await userEvent.click(screen.getByTestId('confirm-rename-project-button'))
    expect(baseProps.onUpdateProjectName).toHaveBeenCalledWith(1, 'publish-v2')

    expect(await screen.findByText('Implement archive')).toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument()
    expect(screen.getByTestId('project-chat-time-11')).toHaveClass(
      'group-hover/task:opacity-0',
    )
    expect(screen.getByTestId('project-chat-actions-11')).toHaveClass(
      'absolute',
      'opacity-0',
      'group-hover/task:opacity-100',
    )
    expect(screen.getByTestId('project-chat-row-11')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]',
    )
    await userEvent.click(screen.getByTestId('project-chat-button'))
    expect(baseProps.onOpenTask).toHaveBeenCalledWith(11, 1)

    await userEvent.click(screen.getByTestId('project-chat-menu-11'))
    expect(screen.getByTestId('archive-chat-11')).toHaveTextContent('归档会话')
    expect(screen.getByTestId('rename-chat-11')).toHaveTextContent('重命名会话')
  })

  test('sorts recent sessions by updated time and exposes chat archive actions', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          recentTasks: [
            {
              id: 4,
              title: 'Older session',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: threeHoursAgo,
              updated_at: threeHoursAgo,
            },
            {
              id: 5,
              title: 'Newest session',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: oneHourAgo,
              updated_at: oneHourAgo,
            },
            {
              id: 6,
              title: 'Project session',
              status: 'COMPLETED',
              task_type: 'code',
              project_id: 7,
              created_at: oneHourAgo,
              updated_at: oneHourAgo,
            },
          ],
        }}
      />,
    )

    const rows = screen.getAllByTestId('history-task-button')
    expect(rows[0]).toHaveTextContent('Newest session')
    expect(rows[1]).toHaveTextContent('Older session')
    expect(screen.queryByText('Project session')).not.toBeInTheDocument()
    expect(screen.getByText('1h')).toBeInTheDocument()
    expect(screen.getByTestId('history-task-time-5')).toHaveClass(
      'group-hover/task:opacity-0',
    )
    expect(screen.getByTestId('history-task-actions-5')).toHaveClass(
      'absolute',
      'opacity-0',
      'group-hover/task:opacity-100',
    )
    await userEvent.click(rows[0])
    expect(baseProps.onOpenTask).toHaveBeenCalledWith(5, 0)

    await userEvent.click(screen.getByTestId('history-task-menu-5'))
    expect(screen.getByTestId('archive-history-chat-5')).toHaveTextContent('归档会话')
    expect(screen.getByTestId('rename-history-chat-5')).toHaveTextContent('重命名会话')

    await userEvent.click(screen.getByTestId('chats-more-button'))
    expect(screen.getByTestId('archive-standalone-chats-button')).toHaveTextContent('归档所有会话')
    await userEvent.click(screen.getByTestId('archive-standalone-chats-button'))
    expect(baseProps.onArchiveAllChats).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('chats-new-conversation-button'))
    expect(baseProps.onStartStandaloneChat).toHaveBeenCalledTimes(1)
  })

  test('shows running spinners for project and standalone chats', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        runningTaskIds={new Set([31, 41])}
        state={{
          ...baseProps.state,
          projects: [
            {
              id: 1,
              name: 'github_wegent',
              tasks: [
                {
                  id: 31,
                  task_id: 31,
                  task_title: 'Running project chat',
                  task_status: 'RUNNING',
                  updated_at: new Date().toISOString(),
                },
              ],
            },
          ],
          recentTasks: [
            {
              id: 41,
              title: 'Running standalone chat',
              status: 'RUNNING',
              task_type: 'code',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        }}
      />,
    )

    expect(screen.getByTestId('project-spinner-1')).toBeInTheDocument()
    expect(screen.getByTestId('history-task-spinner-41')).toBeInTheDocument()
  })

  test('does not show spinners for stale server running statuses on initial lists', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        runningTaskIds={new Set()}
        state={{
          ...baseProps.state,
          projects: [
            {
              id: 1,
              name: 'github_wegent',
              tasks: [
                {
                  id: 31,
                  task_id: 31,
                  task_title: 'Stale project chat',
                  task_status: 'RUNNING',
                  updated_at: new Date().toISOString(),
                },
              ],
            },
          ],
          recentTasks: [
            {
              id: 41,
              title: 'Stale standalone chat',
              status: 'PENDING',
              task_type: 'code',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        }}
      />,
    )

    expect(screen.queryByTestId('project-spinner-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('history-task-spinner-41')).not.toBeInTheDocument()
  })

  test('keeps projects and chats in the scrollable sidebar region above settings', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('sidebar-worklists-scroll')).toHaveClass(
      'flex-1',
      'overflow-y-auto',
      'scrollbar-none',
    )
    expect(screen.getByTestId('settings-button')).toHaveClass('shrink-0', 'w-full')
  })

  test('toggles an empty project chat list without selecting the project chat context', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(baseProps.onSelectProject).not.toHaveBeenCalled()
    expect(screen.getByText('暂无会话')).toBeInTheDocument()
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
    expect(baseProps.onSelectProject).not.toHaveBeenCalled()
  })

  test('limits project chats to five and toggles show more and show less', async () => {
    const projectTasks = Array.from({ length: 6 }, (_, index) => {
      const taskNumber = index + 1
      return {
        id: taskNumber,
        task_id: taskNumber,
        task_title: `Chat ${taskNumber}`,
        task_status: 'COMPLETED',
        updated_at: new Date(Date.now() - index * 60 * 1000).toISOString(),
      }
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [{ id: 1, name: 'github_wegent', tasks: projectTasks }],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByText('Chat 1')).toBeInTheDocument()
    expect(screen.getByText('Chat 5')).toBeInTheDocument()
    expect(screen.queryByText('Chat 6')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-task-limit-toggle-1')).toHaveTextContent('显示更多')

    await userEvent.click(screen.getByTestId('project-task-limit-toggle-1'))

    expect(screen.getByText('Chat 6')).toBeInTheDocument()
    expect(screen.getByTestId('project-task-limit-toggle-1')).toHaveTextContent('收起')

    await userEvent.click(screen.getByTestId('project-task-limit-toggle-1'))

    expect(screen.queryByText('Chat 6')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-task-limit-toggle-1')).toHaveTextContent('显示更多')
  })

  test('opens archived chats settings and supports unarchive and delete actions', async () => {
    const onListArchivedTasks = vi.fn().mockResolvedValue({
      total: 1,
      items: [
        {
          id: 20,
          title: 'Archived task',
          status: 'COMPLETED',
          task_type: 'code',
          type: 'offline',
          created_at: '2026-05-27T01:00:00.000Z',
          updated_at: '2026-05-27T12:15:00.000Z',
          project_id: 1,
          project_name: 'Wegent',
        },
      ],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onListArchivedTasks={onListArchivedTasks}
      />,
    )

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('settings-menu-button'))
    await userEvent.click(screen.getByTestId('settings-nav-archived-chats'))

    expect(await screen.findByTestId('archived-chats-settings')).toBeInTheDocument()
    expect(screen.getByText('Archived task')).toBeInTheDocument()
    expect(screen.getByText(/Wegent/)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('unarchive-chat-20'))
    await waitFor(() => expect(baseProps.onUnarchiveTask).toHaveBeenCalledWith(20))

    await userEvent.click(screen.getByTestId('delete-archived-chat-20'))
    await waitFor(() => expect(baseProps.onDeleteTask).toHaveBeenCalledWith(20))

    await userEvent.click(screen.getByTestId('delete-all-archived-chats-button'))
    await waitFor(() => expect(baseProps.onDeleteArchivedTasks).toHaveBeenCalledTimes(1))
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
    expect(screen.queryByTestId('settings-nav-projects')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-general')).not.toBeInTheDocument()
    expect(screen.queryByText('Personal Devices')).not.toBeInTheDocument()
    expect(screen.queryByText('Linux-Device-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.getByText('可连接的设备')).toBeInTheDocument()
    expect(screen.queryByText('可连接这台设备的云设备')).not.toBeInTheDocument()
    expect(await screen.findByText('云设备')).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-device-24a59054-4638-4744-983d-372706c30fcd'),
    ).toBeInTheDocument()
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
    expect(await screen.findByText('42%')).toBeInTheDocument()
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
    expect(screen.getByText('终端')).toBeInTheDocument()
    expect(screen.getByText('IDE')).toBeInTheDocument()
    expect(screen.getByText('桌面')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 700 })
    fireEvent.pointerMove(document, { clientX: 640 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ width: '480px' })
  })

  test('opens the environment info popover and closes it from outside click', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.getByTestId('environment-info-popover')).toHaveClass(
      'w-[340px]',
      'bg-background',
      'text-text-primary',
      'border-border',
      'backdrop-blur-3xl',
      'backdrop-saturate-150',
    )
    expect(screen.getByText('环境信息')).toBeInTheDocument()
    expect(screen.getByText('变更')).toBeInTheDocument()
    const deviceButton = await screen.findByTestId('environment-device-button')
    expect(deviceButton).toHaveTextContent('本地')
    const deviceId = screen.getByTestId('environment-device-id')
    expect(deviceId).toHaveTextContent('e13e1a10...0bb4')
    expect(deviceId).toHaveClass('ml-auto', 'text-right')
    expect(deviceButton).toHaveAttribute(
      'title',
      '本地 · e13e1a10-5377-4a87-a3b3-634a098d0bb4',
    )
    expect(await screen.findByText('+173')).toBeInTheDocument()
    expect(await screen.findByText('-13366')).toBeInTheDocument()
    expect(await screen.findByText('human/narwhal-20260528-073440')).toBeInTheDocument()
    expect(screen.getByText('提交')).toBeInTheDocument()
    expect(screen.getByText('创建拉取请求')).toBeInTheDocument()
    expect(screen.getByText('来源')).toBeInTheDocument()
    expect(screen.getByText('暂无来源')).toBeInTheDocument()

    await userEvent.click(deviceButton)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
    )
    expect(screen.getByText('已复制')).toBeInTheDocument()

    await userEvent.click(document.body)

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
  })

  test('submits environment commits from the popover', async () => {
    const onCommitEnvironmentChanges = vi.fn().mockResolvedValue(undefined)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-commit-button'))
    await userEvent.type(screen.getByTestId('environment-commit-message-input'), 'feat: ship')
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    await waitFor(() =>
      expect(onCommitEnvironmentChanges).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, name: 'github_wegent' }),
        'feat: ship',
      ),
    )
    expect(screen.getByText('已提交')).toBeInTheDocument()
  })

  test('switches and creates branches from the environment popover', async () => {
    const onListEnvironmentBranches = vi.fn().mockResolvedValue([
      'main',
      'human/chipmunk-20260603-053420',
      'human/alpaca-20260603-050330',
    ])
    const onCheckoutEnvironmentBranch = vi.fn().mockResolvedValue(undefined)
    const onCreateEnvironmentBranch = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onListEnvironmentBranches={onListEnvironmentBranches}
        onCheckoutEnvironmentBranch={onCheckoutEnvironmentBranch}
        onCreateEnvironmentBranch={onCreateEnvironmentBranch}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            tasks: [],
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'device-1',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/github_wegent',
              },
            },
          },
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()
    await waitFor(() => expect(onListEnvironmentBranches).toHaveBeenCalledTimes(1))
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('human/chipmunk-20260603-053420')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('environment-branch-search-input'), 'alp')
    expect(screen.getByText('human/alpaca-20260603-050330')).toBeInTheDocument()
    expect(screen.queryByText('human/chipmunk-20260603-053420')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('human/alpaca-20260603-050330'))
    await waitFor(() =>
      expect(onCheckoutEnvironmentBranch).toHaveBeenCalledWith(
        expect.anything(),
        'human/alpaca-20260603-050330',
      ),
    )

    await userEvent.click(screen.getByTestId('environment-branch-row'))
    await userEvent.click(await screen.findByTestId('environment-open-new-branch-button'))
    await userEvent.type(screen.getByTestId('environment-new-branch-input'), 'human/new-branch')
    await userEvent.click(screen.getByTestId('environment-confirm-new-branch-button'))

    await waitFor(() =>
      expect(onCreateEnvironmentBranch).toHaveBeenCalledWith(
        expect.anything(),
        'human/new-branch',
      ),
    )
  })

  test('does not reopen the branch menu when the environment popover is reopened', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    await userEvent.click(document.body)
    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(await screen.findByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
  })

  test('closes the branch menu when Escape is pressed', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument(),
    )
    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
  })

  test('loads environment info from the first workspace project when the popover opens', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+8',
      deletions: '-3',
      executionTarget: 'local' as const,
      deviceId: 'device-from-fallback',
      branchName: 'feature/fallback',
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [
            { id: 1, name: 'legacy', tasks: [] },
            {
              id: 2,
              name: 'workspace',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'device-from-fallback',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/repo',
                },
              },
            },
          ],
        }}
      />,
    )

    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, name: 'workspace' }),
      ),
    )
  })

  test('loads environment info from the current task project before the fallback project', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+1',
      deletions: '-1',
      executionTarget: 'local' as const,
      deviceId: 'device-sina',
      branchName: 'human/seal-20260529-104820',
    })
    const sinaProject = {
      id: 9,
      name: 'sina-sso',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-sina',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/Users/hongyu9/Downloads/sina-sso',
        },
      },
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          currentTask: {
            id: 99,
            title: 'sina task',
            status: 'RUNNING',
            task_type: 'code',
            project_id: 9,
            created_at: '2026-05-29T00:00:00.000Z',
          },
          projects: [
            {
              id: 2,
              name: 'agno',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'device-agno',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/Volumes/OuterHD/OuterIdeaProjects/agno',
                },
              },
            },
            sinaProject,
          ],
        }}
      />,
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() => expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(sinaProject))
  })

  test('refreshes environment info when an assistant message completes', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+4',
      deletions: '-1',
      executionTarget: 'local' as const,
      deviceId: 'device-1',
      branchName: 'feature/done',
    })
    const workspaceProject = {
      id: 1,
      name: 'workspace',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/repo',
        },
      },
    }
    const streamingMessage = {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'Working',
      status: 'streaming' as const,
      createdAt: '2026-05-29T00:00:00.000Z',
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
        }}
        messages={[streamingMessage]}
      />,
    )

    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
        }}
        messages={[
          {
            ...streamingMessage,
            status: 'done' as const,
          },
        ]}
      />,
    )

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(workspaceProject),
    )
  })

  test('closes the right workspace panel from the panel edge', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('close-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
  })

  test('opens and resizes the bottom workspace panel', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByText('终端')).toBeInTheDocument()
    expect(screen.getByText('IDE')).toBeInTheDocument()
    expect(screen.getByText('桌面')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('bottom-workspace-resize-handle'), { clientY: 700 })
    fireEvent.pointerMove(document, { clientY: 620 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ height: '400px' })
  })

  test('closes the bottom workspace panel from the panel edge', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    expect(screen.getByTestId('bottom-workspace-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('close-bottom-workspace-panel-button'))

    expect(screen.queryByTestId('bottom-workspace-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
  })
})
