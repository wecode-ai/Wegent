import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from '@/api/devices'
import { createProjectApi } from '@/api/projects'
import { createQuotaApi } from '@/api/quota'
import '@/i18n'
import { TITLEBAR_ACTIONS_PORTAL_ID } from '@/components/topnav/TitlebarActionsPortal'
import { DesktopWorkbenchLayout } from './DesktopWorkbenchLayout'
import { WorkspaceFilePreview } from './workspace-panels/WorkspaceFilePreview'

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

vi.mock('@/api/projects', () => ({
  createProjectApi: vi.fn(),
}))

vi.mock('@/api/quota', () => ({
  createQuotaApi: vi.fn(),
}))

vi.mock('./workspace-panels/RemoteTerminal', () => ({
  RemoteTerminal: ({ active, sessionId }: { active: boolean; sessionId: string }) => (
    <div
      data-testid="remote-terminal"
      data-session-id={sessionId}
      className="h-full w-full"
      hidden={!active}
    />
  ),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createProjectApiMock = vi.mocked(createProjectApi)
const createQuotaApiMock = vi.mocked(createQuotaApi)
const fetchQuotaMock = vi.fn()
const startTerminalSessionMock = vi.fn()
const startCodeServerSessionMock = vi.fn()

describe('DesktopWorkbenchLayout', () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  function createMockDeviceApi(overrides: Record<string, unknown> = {}) {
    return {
      getHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
      getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
      listDirectories: vi.fn().mockResolvedValue([]),
      listWorkspaceEntries: vi.fn().mockResolvedValue({
        path: '/workspace/project',
        entries: [],
      }),
      readWorkspaceTextFile: vi.fn(),
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
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    document.getElementById(TITLEBAR_ACTIONS_PORTAL_ID)?.remove()
    const titlebarActions = document.createElement('div')
    titlebarActions.id = TITLEBAR_ACTIONS_PORTAL_ID
    titlebarActions.dataset.testid = 'titlebar-actions'
    document.body.appendChild(titlebarActions)
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
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
    createDeviceApiMock.mockReturnValue(createMockDeviceApi() as never)
    startCodeServerSessionMock.mockResolvedValue({
      url: 'http://localhost/ide',
      path: '/workspace/projects/github_wegent',
    })
    startTerminalSessionMock.mockResolvedValue({
      session_id: 'terminal-1',
      url: '',
      transport: 'socketio',
      device_id: 'workspace-cloud-device',
      path: '/workspace/project',
    })
    createProjectApiMock.mockReturnValue({
      startTerminalSession: startTerminalSessionMock,
      startCodeServerSession: startCodeServerSessionMock,
    } as unknown as ReturnType<typeof createProjectApi>)
  })

  const baseProps = {
    state: {
      user: null,
      defaultTeam: null,
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      runtimeWork: null,
      currentProject: null,
      currentRuntimeTask: null,
      standaloneDeviceId: null,
      currentTask: null,
      input: '',
      isBootstrapping: false,
      isSending: false,
      error: null,
    },
    messages: [],
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
      currentStandaloneDeviceId: null,
      executionMode: 'current_workspace',
      executionModeLocked: false,
      onSelectProject: vi.fn(),
      onSelectStandaloneDevice: vi.fn(),
      onExecutionModeChange: vi.fn(),
    },
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGitWorkspaceProject: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
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
    onListEnvironmentBranches: vi
      .fn()
      .mockResolvedValue([
        'main',
        'human/chipmunk-20260603-053420',
        'human/narwhal-20260528-073440',
      ]),
    onCheckoutEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onCreateEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onLoadEnvironmentDiff: vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      ),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onLogout: vi.fn(),
  }

  function createCloudWorkspacePanelState() {
    const workspaceDevice = {
      id: 11,
      device_id: 'workspace-cloud-device',
      name: 'Workspace Cloud Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const workspaceProject = {
      id: 12,
      name: 'workspace-project',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: workspaceDevice.device_id,
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/project',
        },
      },
    }

    return {
      currentProject: workspaceProject,
      projects: [workspaceProject],
      devices: [workspaceDevice],
    }
  }

  function renderWorkspacePanelLayout() {
    const workspacePanelState = createCloudWorkspacePanelState()
    return render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )
  }

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
      '-translate-y-12'
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
      />
    )

    expect(screen.getByTestId('desktop-workbench-content')).toHaveClass('pt-[52px]')
    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass(
      'h-full',
      'overflow-x-hidden',
      'overflow-y-auto',
      'pb-40'
    )
    expect(screen.getByTestId('desktop-floating-composer-backdrop')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'bottom-0',
      'z-10',
      'from-background'
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'bottom-4',
      'left-1/2',
      'z-chrome',
      '-translate-x-1/2'
    )
    expect(screen.getByTestId('desktop-floating-composer-card')).toHaveClass('pointer-events-auto')
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
  })

  test('opens continue-in-im dialog from the active runtime task topbar button', async () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({
      total: 1,
      items: [
        {
          session_key: 'session-1',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 101,
          conversation_id: 'conversation-1',
          sender_id: 'sender-1',
          display_name: 'Alice',
          mode: 'chat',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))

    expect(onListImPrivateSessions).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveTextContent('Alice')
  })

  test('keeps continue-in-im action with workspace panel actions on web', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
      />
    )

    const floatingActions = screen.getByTestId('workspace-panel-floating-actions')
    expect(floatingActions).toContainElement(screen.getByTestId('continue-in-im-button'))
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
  })

  test('keeps continue-in-im action with titlebar actions in Tauri', () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          state={{
            ...baseProps.state,
            currentRuntimeTask: {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              localTaskId: 'runtime-1',
            },
          }}
          messages={[
            {
              id: 'message-1',
              role: 'assistant',
              content: 'Ready',
              status: 'done',
              createdAt: '2026-06-20T00:00:00.000Z',
            },
          ]}
        />
      )

      const titlebarActions = screen.getByTestId('titlebar-actions')
      expect(titlebarActions).toContainElement(screen.getByTestId('continue-in-im-button'))
      expect(titlebarActions).toContainElement(
        screen.getByTestId('toggle-right-workspace-panel-button')
      )
      expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('hides continue-in-im action without a runtime task', () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({ total: 0, items: [] })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={baseProps.state}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onListImPrivateSessions).not.toHaveBeenCalled()
  })

  test('ignores stale private session responses when reopening the dialog', async () => {
    type PrivateSessionResponse = {
      total: number
      items: Array<{
        session_key: string
        channel_type: string
        channel_label: string
        channel_id: number
        conversation_id: string
        sender_id: string
        display_name: string
        mode: 'chat' | 'task'
        state: 'idle'
        active_task_id: null
        last_seen_at: string
      }>
    }
    const firstRequest = createDeferred<PrivateSessionResponse>()
    const secondRequest = createDeferred<PrivateSessionResponse>()
    const onListImPrivateSessions = vi
      .fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))
    await userEvent.click(screen.getByTestId('continue-im-cancel-button'))
    await userEvent.click(screen.getByTestId('continue-in-im-button'))

    secondRequest.resolve({
      total: 1,
      items: [
        {
          session_key: 'session-2',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 102,
          conversation_id: 'conversation-2',
          sender_id: 'sender-2',
          display_name: 'Fresh session',
          mode: 'task',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    expect(await screen.findByTestId('continue-im-session-session-2')).toHaveTextContent(
      'Fresh session'
    )

    firstRequest.resolve({
      total: 1,
      items: [
        {
          session_key: 'session-1',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 101,
          conversation_id: 'conversation-1',
          sender_id: 'sender-1',
          display_name: 'Stale session',
          mode: 'chat',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    await waitFor(() => expect(screen.queryByText('Stale session')).not.toBeInTheDocument())
    expect(screen.getByText('Fresh session')).toBeInTheDocument()
  })

  test('shows a failure notice when bind handler is missing', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={vi.fn().mockResolvedValue({
          total: 1,
          items: [
            {
              session_key: 'session-1',
              channel_type: 'wecom',
              channel_label: 'WeCom',
              channel_id: 101,
              conversation_id: 'conversation-1',
              sender_id: 'sender-1',
              display_name: 'Alice',
              mode: 'chat',
              state: 'idle',
              active_task_id: null,
              last_seen_at: '2026-06-20T00:00:00.000Z',
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    expect(await screen.findByTestId('transient-notice')).toHaveTextContent('继续到私聊失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
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
      />
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

    expect(screen.getByTestId('scroll-to-bottom-button')).toHaveClass('bottom-36', 'z-popover')
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
      />
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass('pb-52')
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass('pb-40')
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

  test('clamps sidebar resizing to the maximum width', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 900 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '480px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('480')
  })

  test('uses the selected sidebar width as the default', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '240px' })
  })

  test('collapses and expands the sidebar', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('desktop-sidebar-topbar')).toHaveClass('h-[52px]')
    expect(screen.getByTestId('desktop-workbench-main')).toHaveClass('mt-1.5', 'mb-1.5', 'mr-1.5')
    expect(screen.getByTestId('desktop-workbench-main')).not.toHaveClass('ml-1.5')
    expect(screen.getByTestId('collapse-sidebar-button')).toHaveClass('h-7', 'w-7', 'rounded-lg')
    expect(screen.getByTestId('desktop-window-controls')).toHaveClass('gap-3')
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('environment-info-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )

    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.queryByText('新对话')).not.toBeInTheDocument()
    expect(document.querySelector('aside')).not.toBeInTheDocument()
    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-topbar-left-actions')).toContainElement(
      screen.getByTestId('desktop-window-controls')
    )
    expect(screen.getByTestId('desktop-workbench-main')).toHaveClass(
      'mt-1.5',
      'mb-1.5',
      'mr-1.5',
      'ml-1.5'
    )

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))

    expect(screen.getByText('新对话')).toBeInTheDocument()
    expect(document.querySelector('aside')).toBeInTheDocument()
  })

  test('keeps window controls in their page-level positions in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('desktop-sidebar-topbar')).toContainElement(
      screen.getByTestId('collapse-sidebar-button')
    )
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('environment-info-button')
    )
    expect(screen.queryByTestId('workbench-topbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-workbench-content')).not.toHaveClass('pt-[52px]')
    expect(screen.getByTestId('desktop-workbench-main')).toHaveClass('mb-1.5', 'mr-1.5')
    expect(screen.getByTestId('desktop-workbench-main')).not.toHaveClass('mt-1.5')

    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.getByTestId('workbench-topbar')).toContainElement(
      screen.getByTestId('expand-sidebar-button')
    )
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
  })

  test('opens project code-server from the Tauri titlebar', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: '24a59054-4638-4744-983d-372706c30fcd',
              name: 'cloud executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() => expect(startCodeServerSessionMock).toHaveBeenCalledWith(1))
    expect(openSpy).toHaveBeenCalledWith('http://localhost/ide', '_blank', 'noopener')
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('open-code-server-titlebar-button')
    )
    expect(screen.getByTestId('open-code-server-titlebar-button')).toHaveAttribute(
      'title',
      '打开项目 IDE'
    )
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toHaveAttribute(
      'title',
      '打开底部栏'
    )
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toHaveAttribute(
      'title',
      '打开右侧栏'
    )
  })

  test('opens project code-server from the current task execution workspace in the Tauri titlebar', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const workspacePanelState = createCloudWorkspacePanelState()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          currentTask: {
            id: 8,
            title: 'Task',
            status: 'RUNNING',
            created_at: '2026-06-12T00:00:00.000Z',
            device_id: 'workspace-cloud-device',
            execution_workspace_path: '/workspace/worktrees/8/workspace-project',
          },
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() => expect(startCodeServerSessionMock).toHaveBeenCalledWith(12, { taskId: 8 }))
    expect(openSpy).toHaveBeenCalledWith('http://localhost/ide', '_blank', 'noopener')
  })

  test('shows project code-server in the Tauri titlebar before devices hydrate', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [],
        }}
      />
    )

    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('open-code-server-titlebar-button')
    )
  })

  test('keeps project code-server disabled for local devices', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'local-claude',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: 'local-claude',
              name: 'local claude',
              status: 'online',
              is_default: false,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    const button = screen.getByTestId('open-code-server-titlebar-button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '项目 IDE 仅支持云设备')

    await userEvent.click(button)

    expect(startCodeServerSessionMock).not.toHaveBeenCalled()
  })

  test('shows a dialog when project code-server fails to start', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    startCodeServerSessionMock.mockRejectedValueOnce(
      new Error('Local devices do not support code-server sessions')
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: '24a59054-4638-4744-983d-372706c30fcd',
              name: 'cloud executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    expect(await screen.findByTestId('code-server-error-dialog')).toHaveTextContent(
      'Local devices do not support code-server sessions'
    )
  })

  test('keeps panel toggles in stable workbench actions on web', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-topbar')).toHaveClass('z-chrome')
    expect(screen.getByTestId('workspace-panel-floating-actions')).toHaveClass(
      'pointer-events-auto',
      'z-popover'
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('environment-info-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.getByTestId('titlebar-actions')).toBeEmptyDOMElement()
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
    expect(within(usagePanel).queryByText('模型额度')).not.toBeInTheDocument()
    expect(usagePanel).toHaveTextContent('747.74 / 748 元')
    expect(usagePanel).toHaveTextContent('剩余 0.26 元')
    expect(usagePanel).not.toHaveTextContent('使用率')
    expect(usagePanel).not.toHaveTextContent('总额度')
    expect(usagePanel).not.toHaveClass('pl-12')
    expect(within(usagePanel).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    const quotaLink = await screen.findByRole('link', {
      name: '额度与计费说明',
    })
    expect(quotaLink).toHaveAttribute('href', 'https://space.intra.weibo.com/develop/model-quota')
    expect(quotaLink).toHaveClass('text-text-secondary')
    expect(quotaLink).not.toHaveClass('text-primary')
  })

  test('opens project creation directly from the sidebar project create button', async () => {
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
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '选择项目文件夹' })).toBeInTheDocument()
    expect(screen.getByTestId('project-device-tab-device-1')).toHaveTextContent('executor')
    expect(screen.getByTestId('project-folder-select-button')).toBeInTheDocument()
    expect(screen.queryByTestId('project-name-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-start-from-scratch-button')).not.toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
  })

  test('opens project create dialog before device refresh completes', async () => {
    let resolveRefreshDevices: (() => void) | undefined
    const onRefreshDevices = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveRefreshDevices = resolve
        })
    )

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
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByText('选择项目文件夹')).toBeInTheDocument()
    expect(screen.getByTestId('project-folder-select-button')).toBeInTheDocument()
    expect(screen.queryByTestId('project-name-input')).not.toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)

    resolveRefreshDevices?.()
  })

  test('enables device upgrade from the sidebar project create dialog', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onUpgradeDevice={onUpgradeDevice}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'old-device',
              name: 'Old Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.4',
              slot_used: 0,
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('project-device-tab-old-device')).toHaveTextContent('需升级')
    expect(screen.getByTestId('project-device-unavailable-old-device')).toHaveTextContent(
      '当前 v1.8.4，需要 1.8.5 或以上'
    )

    const upgradeButton = screen.getByTestId('upgrade-project-device-old-device')
    expect(upgradeButton).not.toBeDisabled()

    await userEvent.click(upgradeButton)

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('does not render a project create menu when opening the sidebar dialog', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('project-start-from-scratch-button')).not.toBeInTheDocument()

    fireEvent.pointerMove(document, { clientX: 500, clientY: 500 })
    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()

    await userEvent.hover(screen.getByTestId('project-row-1'))
    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
  })

  test('does not render a body-level project create flyout', async () => {
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

      expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
      expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
    } finally {
      getBoundingClientRectSpy.mockRestore()
    }
  })

  test('renders project create dialog as a page-level overlay', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))

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
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const menu = screen.getByTestId('project-work-menu')
    const addProjectOption = screen.getByTestId('add-project-option')
    expect([...menu.querySelectorAll('button')].map(button => button.dataset.testid)).toEqual([
      'project-option-1',
      'add-project-option',
      'no-project-option',
    ])

    await userEvent.click(addProjectOption)

    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-project-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    expect(screen.getByText('选择项目文件夹')).toBeInTheDocument()
    expect(screen.getByTestId('project-folder-select-button')).toBeInTheDocument()
    expect(screen.queryByTestId('project-name-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('create-project-button')).toHaveTextContent('创建项目')
  })

  test('opens connection settings cloud device creation from an empty sidebar project dialog', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(<DesktopWorkbenchLayout {...baseProps} onRefreshDevices={onRefreshDevices} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('project-create-dialog')).toBeInTheDocument()
    expect(screen.getByText('创建项目需要一台可用设备。')).toBeInTheDocument()

    const settingsLink = screen.getByTestId('open-cloud-device-settings-link')
    expect(settingsLink).toHaveAttribute('href', '/settings')

    await userEvent.click(settingsLink)

    expect(screen.queryByTestId('project-create-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('wework-settings-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '连接' })).toBeInTheDocument()
    expect(screen.getByTestId('add-cloud-device-dialog')).toBeInTheDocument()
  })

  test('opens connection settings cloud device creation from an empty project dialog', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)
    createDeviceApiMock.mockReturnValue({
      getAllDevices: vi.fn().mockResolvedValue([]),
      getMetrics: vi.fn(),
      getMetricsHistory: vi.fn(),
      getVncConfig: vi.fn(),
      createCloudDevice: vi.fn(),
      startTerminal: vi.fn(),
      startCodeServer: vi.fn(),
      renameDevice: vi.fn(),
      restartCloudDevice: vi.fn(),
      deleteCloudDevice: vi.fn(),
      deleteDevice: vi.fn(),
      getHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
      getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
      listDirectories: vi.fn().mockResolvedValue([]),
      executeCommand: vi.fn(),
    })

    render(<DesktopWorkbenchLayout {...baseProps} onRefreshDevices={onRefreshDevices} />)

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('add-project-option'))
    await userEvent.click(screen.getByTestId('open-cloud-device-settings-link'))

    expect(screen.queryByTestId('project-create-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('wework-settings-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '连接' })).toBeInTheDocument()
    expect(screen.getByTestId('add-cloud-device-dialog')).toBeInTheDocument()
  })

  test('creates a project from an existing folder selected in the directory tree', async () => {
    const onCreateProject = vi.fn().mockResolvedValue({ id: 2, name: 'repo', tasks: [] })
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 10,
        userId: 1,
        projectId: 2,
        deviceId: 'device-1',
        workspacePath: '/home/ubuntu/repo',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
        lastSeenAt: null,
      },
    })
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['.cache', 'repo'])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCreateProject={onCreateProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
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
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-folder-select-button'))

    await waitFor(() => expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('device-1'))
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu')
    )
    expect(screen.queryByText('.cache')).not.toBeInTheDocument()
    expect(screen.getByTestId('device-folder-path-input')).toHaveValue('/home/ubuntu')

    const repoEntry = await screen.findByText('repo')
    await userEvent.click(repoEntry)
    expect(onListDeviceDirectories).not.toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')

    await userEvent.click(screen.getByTestId('device-folder-hidden-toggle'))
    expect(screen.getByText('.cache')).toBeInTheDocument()

    await userEvent.dblClick(repoEntry)
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')
    )

    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))
    expect(screen.getByTestId('project-name-preview')).toHaveTextContent('repo')
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'repo',
          config: {
            mode: 'workspace',
          },
        })
      )
    )
    expect(onPrepareDeviceWorkspace).toHaveBeenCalledWith({
      projectId: 2,
      deviceId: 'device-1',
      workspacePath: '/home/ubuntu/repo',
      action: 'select',
    })
  })

  test('hides project device status when the project device is online', () => {
    const onlineDevice = {
      id: 1,
      device_id: 'online-device',
      name: 'Online Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [onlineDevice],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'cloud',
                  deviceId: 'online-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).queryByTestId('project-device-status-7')).not.toBeInTheDocument()
    expect(within(projectRow).getByTestId('project-new-conversation-button')).not.toBeDisabled()
  })

  test('keeps offline project conversations readable but locks the composer', async () => {
    const offlineDevice = {
      id: 1,
      device_id: 'offline-device',
      name: 'Offline Device',
      status: 'offline' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'offline-device',
        },
      },
      tasks: [],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [offlineDevice],
          currentProject: project,
          currentTask: {
            id: 71,
            title: 'Offline chat',
            status: 'COMPLETED',
            task_type: 'code',
            project_id: 7,
            created_at: new Date().toISOString(),
          },
          input: 'hello offline',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [offlineDevice],
          currentProjectId: 7,
        }}
      />
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveTextContent('hello')
    expect(screen.getByTestId('composer-disabled-reason')).toHaveTextContent(
      'Offline Device 暂不可用，恢复后可继续对话'
    )
    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      'Offline Device 已离线，恢复在线后可继续对话'
    )
    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  test('locks composer for project tasks when the owning project device is offline', async () => {
    const offlineDevice = {
      id: 1,
      device_id: 'offline-project-device',
      name: 'Offline Project Device',
      status: 'offline' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const onlineTaskDevice = {
      id: 2,
      device_id: 'online-task-device',
      name: 'Online Task Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'offline-project-device',
        },
      },
      tasks: [
        {
          id: 71,
          task_id: 71,
          task_title: 'Offline project task',
          device_id: 'online-task-device',
          updated_at: new Date().toISOString(),
        },
      ],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [offlineDevice, onlineTaskDevice],
          currentProject: null,
          currentTask: {
            id: 71,
            title: 'Offline project task',
            status: 'COMPLETED',
            task_type: 'code',
            project_id: 7,
            device_id: 'online-task-device',
            created_at: new Date().toISOString(),
          },
          input: 'should not send',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
      />
    )

    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId('desktop-floating-composer-card')).getByTestId(
        'conversation-device-offline-banner'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      'Offline Project Device 已离线，恢复在线后可继续对话'
    )
    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveClass(
      'bg-background/95',
      'text-text-secondary'
    )
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass('pt-14')
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  test('does not expose raw device ids in the offline conversation notice', () => {
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'b2f75045-2062-4a94-b5c0-ffb9f3b94a90',
        },
      },
      tasks: [
        {
          id: 71,
          task_id: 71,
          task_title: 'Unavailable project task',
          updated_at: new Date().toISOString(),
        },
      ],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [],
          currentProject: null,
          currentTask: {
            id: 71,
            title: 'Unavailable project task',
            status: 'COMPLETED',
            task_type: 'code',
            project_id: 7,
            created_at: new Date().toISOString(),
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
      />
    )

    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      '当前设备 不可用，恢复在线后可继续对话'
    )
    expect(screen.getByTestId('conversation-device-offline-banner')).not.toHaveTextContent(
      'b2f75045-2062-4a94-b5c0-ffb9f3b94a90'
    )
  })

  test('locks composer for nested project tasks even when task detail omits project id', async () => {
    const offlineDevice = {
      id: 1,
      device_id: 'nested-offline-project-device',
      name: 'Nested Offline Project Device',
      status: 'offline' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const standaloneOnlineDevice = {
      id: 2,
      device_id: 'standalone-online-device',
      name: 'Standalone Online Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'nested-offline-project-device',
        },
      },
      tasks: [
        {
          id: 71,
          task_id: 71,
          task_title: 'Nested offline project task',
          updated_at: new Date().toISOString(),
        },
      ],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [offlineDevice, standaloneOnlineDevice],
          standaloneDeviceId: 'standalone-online-device',
          currentProject: null,
          currentTask: {
            id: 71,
            title: 'Nested offline project task',
            status: 'COMPLETED',
            task_type: 'code',
            created_at: new Date().toISOString(),
          },
          input: 'still should not send',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'done',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
      />
    )

    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      'Nested Offline Project Device 已离线，恢复在线后可继续对话'
    )
    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  test('shows an external upgrade action for the active low-version device', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)
    const oldDevice = {
      id: 1,
      device_id: 'old-device',
      name: 'Old Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.4',
      slot_used: 0,
    }
    const compatibleDevice = {
      id: 2,
      device_id: 'compatible-device',
      name: 'Compatible Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'old-device',
        },
      },
      tasks: [],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onUpgradeDevice={onUpgradeDevice}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [oldDevice, compatibleDevice],
          currentProject: project,
          input: 'hello old device',
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [oldDevice, compatibleDevice],
          currentProjectId: 7,
        }}
      />
    )

    expect(screen.getByTestId('composer-disabled-reason')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )
    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('device-status-upgrade-button'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('keeps projects and chats in the scrollable sidebar region above settings', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('sidebar-worklists-scroll')).toHaveClass(
      'flex-1',
      'overflow-y-auto',
      'scrollbar-none'
    )
    expect(screen.getByTestId('settings-button')).toHaveClass('h-9', 'w-full')
  })

  test('selects a project while toggling an empty project task list', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(baseProps.onSelectProject).toHaveBeenNthCalledWith(1, 1)
    expect(screen.getByText('暂无会话')).toBeInTheDocument()
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
    expect(baseProps.onSelectProject).toHaveBeenNthCalledWith(2, 1)
    expect(baseProps.onSelectProject).toHaveBeenCalledTimes(2)
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
      screen.getByTestId('connection-device-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(screen.getByText('yunpeng7-executor-372706c30fcd')).toBeInTheDocument()
    expect(screen.getByText('v1.712')).toBeInTheDocument()
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('Online')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('connection-terminal-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-code-server-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-vnc-button-24a59054-4638-4744-983d-372706c30fcd')
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
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const panel = screen.getByTestId('right-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-option')).toHaveTextContent('审查')
    expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent('文件')
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()

    const content = screen.getByTestId('desktop-workbench-content')
    expect(content).toHaveStyle({ width: '420px' })
    expect(panel).toHaveClass('min-w-0', 'flex-1', 'basis-0')
    expect(panel).toHaveClass('transition-[opacity,transform]', 'duration-300', 'ease-out')
    expect(content).toHaveClass('transition-[width]', 'duration-300', 'ease-out')

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 700 })
    fireEvent.pointerMove(document, { clientX: 640 })
    fireEvent.pointerUp(document)

    expect(content).toHaveStyle({ width: '360px' })
    expect(screen.getByTestId('workspace-file-tree')).toHaveClass('w-[240px]')
  })

  test('right workspace panel pushes the conversation chat into a narrow split column', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    const content = screen.getByTestId('desktop-workbench-content')
    const topBar = screen.getByTestId('workbench-topbar')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    expect(topBar).toHaveStyle({ width: '100%' })
    expect(content).toHaveClass('flex-none', 'transition-[width]', 'duration-300', 'ease-out')
    expect(content).toHaveStyle({ width: '100%' })
    expect(rightPanelShell).toHaveClass(
      'overflow-hidden',
      'opacity-0',
      'transition-[width,opacity]',
      'duration-300',
      'ease-out'
    )
    expect(rightPanelShell).toHaveStyle({ width: '0px' })
    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass('min-w-[32rem]')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(content).toHaveClass(
      'flex-none',
      'border-r',
      'transition-[width]',
      'duration-300',
      'ease-out'
    )
    expect(content).toHaveStyle({ width: '420px' })
    expect(topBar).toHaveStyle({ width: '420px' })
    expect(rightPanelShell).toHaveClass('opacity-100')
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toHaveClass('right-7')
    expect(screen.getByTestId('right-workspace-panel')).toHaveClass(
      'min-w-0',
      'flex-1',
      'basis-0',
      'transition-[opacity,transform]',
      'duration-300',
      'ease-out'
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'w-[calc(100%_-_1.5rem)]',
      'min-w-0',
      'max-w-[calc(100%_-_1.5rem)]'
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).not.toHaveClass('min-w-[32rem]')
  })

  test('right workspace panel opens only the file tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const fileTab = screen.getByTestId('right-workspace-file-tab')
    expect(tabbar).toHaveAttribute('role', 'tablist')
    expect(screen.queryByTestId('right-workspace-review-tab')).not.toBeInTheDocument()
    expect(fileTab).toHaveAttribute('role', 'tab')
    expect(fileTab).toHaveAttribute('aria-selected', 'true')
    expect(fileTab).toHaveTextContent(/^文件$/)
    expect(fileTab).toHaveClass('group')
    const closeButton = within(fileTab).getByTestId('close-right-workspace-panel-button')
    expect(closeButton).toHaveClass(
      'h-5',
      'w-5',
      'rounded-full',
      'border',
      'bg-muted',
      'opacity-0',
      'group-hover:opacity-100',
      'focus-visible:opacity-100'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('right workspace panel restores the previous tab after closing and reopening', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-launcher')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('right workspace panel clears remembered tabs when switching sessions', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const sessionTask = {
      id: 101,
      title: 'Session A',
      status: 'COMPLETED',
      task_type: 'code' as const,
      project_id: workspacePanelState.currentProject.id,
      created_at: '2026-06-12T00:00:00.000Z',
    }
    const nextSessionTask = {
      ...sessionTask,
      id: 102,
      title: 'Session B',
    }
    const layoutProps = {
      ...baseProps,
      state: {
        ...baseProps.state,
        ...workspacePanelState,
        currentTask: sessionTask,
      },
      projectWork: {
        ...baseProps.projectWork,
        projects: workspacePanelState.projects,
        devices: workspacePanelState.devices,
        currentProjectId: workspacePanelState.currentProject.id,
      },
    }

    const { rerender } = render(<DesktopWorkbenchLayout {...layoutProps} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')

    rerender(
      <DesktopWorkbenchLayout
        {...layoutProps}
        state={{
          ...layoutProps.state,
          currentTask: nextSessionTask,
        }}
      />
    )

    await waitFor(() =>
      expect(screen.queryByTestId('right-workspace-file-tab')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
  })

  test('project conversations open files from the project workspace instead of stale task worktrees', async () => {
    const workspaceProject = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'workspace-device',
        },
        workspace: {
          source: 'git' as const,
          checkoutPath: 'projects/abc/Wegent',
        },
      },
    }
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/projects/abc/Wegent',
      entries: [],
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: workspaceProject,
          currentTask: {
            id: 99,
            title: 'Stale task',
            status: 'COMPLETED',
            task_type: 'code',
            project_id: workspaceProject.id,
            created_at: '2026-06-12T00:00:00.000Z',
          },
          projects: [workspaceProject],
          devices: [
            {
              id: 1,
              device_id: 'workspace-device',
              name: 'Workspace Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
        messages={[
          {
            id: 'assistant-1',
            taskId: 99,
            role: 'assistant',
            content: 'stale task output',
            status: 'done',
            createdAt: '2026-06-12T00:00:00.000Z',
            fileChanges: {
              version: 1,
              status: 'active',
              artifact_id: 'turn-file-changes/99/100',
              device_id: 'workspace-device',
              workspace_path: '/Users/me/outside-workspace',
              file_count: 0,
              additions: 0,
              deletions: 0,
              files: [],
            },
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: [workspaceProject],
          devices: [
            {
              id: 1,
              device_id: 'workspace-device',
              name: 'Workspace Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
          currentProjectId: workspaceProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    await waitFor(() =>
      expect(listWorkspaceEntries).toHaveBeenCalledWith(
        'workspace-device',
        '/workspace/projects/abc/Wegent'
      )
    )
  })

  test('right workspace panel opens only the review tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const reviewTab = screen.getByTestId('right-workspace-review-tab')
    expect(tabbar).toHaveAttribute('role', 'tablist')
    expect(reviewTab).toHaveAttribute('role', 'tab')
    expect(reviewTab).toHaveAttribute('aria-selected', 'true')
    expect(reviewTab).toHaveTextContent('审查')
    expect(screen.queryByTestId('right-workspace-file-tab')).not.toBeInTheDocument()
    const closeButton = within(reviewTab).getByTestId('close-right-workspace-panel-button')
    expect(closeButton).toHaveClass(
      'h-5',
      'w-5',
      'rounded-full',
      'border',
      'bg-muted',
      'opacity-0',
      'group-hover:opacity-100',
      'focus-visible:opacity-100'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(baseProps.onLoadEnvironmentDiff).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByTestId('refresh-review-diff-button'))

    await waitFor(() => expect(baseProps.onLoadEnvironmentDiff).toHaveBeenCalledTimes(2))
  })

  test('right workspace panel retries review loading after a stale device offline error', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockRejectedValueOnce(new Error("Device 'aa1f5585-8ef4-4cf3-a3c0-d8c89d22831a' is offline"))
      .mockResolvedValueOnce(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    const failedPanel = await screen.findByTestId('file-changes-review-panel')
    expect(failedPanel).toHaveTextContent('设备暂时不可用，请稍后重试')
    expect(failedPanel).not.toHaveTextContent('aa1f5585-8ef4-4cf3-a3c0-d8c89d22831a')
    expect(onLoadEnvironmentDiff).toHaveBeenCalledTimes(1)

    await userEvent.click(
      within(screen.getByTestId('right-workspace-review-tab')).getByTestId(
        'close-right-workspace-panel-button'
      )
    )
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    await waitFor(() => expect(onLoadEnvironmentDiff).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(screen.getByTestId('file-changes-review-panel')).toHaveTextContent('+new')
    expect(screen.getByTestId('file-changes-review-panel')).not.toHaveTextContent(
      '设备暂时不可用，请稍后重试'
    )
  })

  test('right workspace panel shows file tree and read-only preview', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValueOnce({
      path: '/workspace/project',
      entries: [
        {
          name: 'src',
          path: '/workspace/project/src',
          isDirectory: true,
          size: 0,
          modifiedAt: null,
        },
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 11,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'hello world',
      truncated: false,
      size: 11,
      modifiedAt: null,
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
        readWorkspaceTextFile,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))

    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    await user.click(await screen.findByText('README.md'))

    expect(await screen.findByTestId('workspace-file-preview')).toHaveTextContent('hello world')
    expect(screen.getByText('/workspace/project/README.md')).toBeInTheDocument()
  })

  test('right workspace panel uses the current task execution workspace path', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/worktrees/8/workspace-project',
      entries: [],
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          currentTask: {
            id: 8,
            title: 'Task',
            status: 'RUNNING',
            created_at: '2026-06-12T00:00:00.000Z',
            device_id: 'workspace-cloud-device',
            execution_workspace_path: '/workspace/worktrees/8/workspace-project',
          },
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(listWorkspaceEntries).toHaveBeenCalledWith(
      'workspace-cloud-device',
      '/workspace/worktrees/8/workspace-project'
    )
  })

  test('opens an edited file from the conversation tool block in the workspace panel', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const readWorkspaceTextFile = vi.fn().mockResolvedValue({
      path: '/workspace/project/README.md',
      name: 'README.md',
      content: 'opened from tool block',
      truncated: false,
      size: 22,
      modifiedAt: null,
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries: vi.fn().mockResolvedValue({
          path: '/workspace/project',
          entries: [],
        }),
        readWorkspaceTextFile,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'assistant-editing-file',
            taskId: 101,
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
            blocks: [
              {
                id: 'edit-file-1',
                subtaskId: 101,
                type: 'tool',
                toolName: 'edit_file',
                toolInput: {
                  path: 'README.md',
                  old_string: 'before',
                  new_string: 'after',
                },
                status: 'streaming',
                createdAt: 1770000000000,
              },
            ],
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /正在编辑 README\.md/ }))

    expect(await screen.findByTestId('workspace-file-preview')).toHaveTextContent(
      'opened from tool block'
    )
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(readWorkspaceTextFile).toHaveBeenCalledWith(
      'workspace-cloud-device',
      '/workspace/project/README.md'
    )
  })

  test('right workspace panel renders nested directories as an expanded tree', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/backend') {
        return Promise.resolve({
          path,
          entries: [
            {
              name: 'alembic',
              path: '/workspace/project/backend/alembic',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
            {
              name: 'app',
              path: '/workspace/project/backend/app',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
          ],
        })
      }
      if (path === '/workspace/project/backend/alembic') {
        return Promise.resolve({
          path,
          entries: [
            {
              name: '__pycache__',
              path: '/workspace/project/backend/alembic/__pycache__',
              isDirectory: true,
              size: 0,
              modifiedAt: null,
            },
            {
              name: 'env.py',
              path: '/workspace/project/backend/alembic/env.py',
              isDirectory: false,
              size: 24,
              modifiedAt: null,
            },
          ],
        })
      }
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'backend',
            path: '/workspace/project/backend',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
          {
            name: 'frontend',
            path: '/workspace/project/frontend',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('backend'))

    const backendRow = screen
      .getByText('backend')
      .closest('[data-testid="workspace-directory-row"]')
    const alembicRow = await screen.findByText('alembic')
    expect(backendRow).toHaveAttribute('aria-expanded', 'true')
    expect(backendRow).toHaveAttribute('data-depth', '0')
    expect(alembicRow.closest('[data-testid="workspace-directory-row"]')).toHaveAttribute(
      'data-depth',
      '1'
    )
    expect(screen.getByText('frontend')).toBeInTheDocument()

    await user.click(alembicRow)

    const selectedAlembicRow = screen
      .getByText('alembic')
      .closest('[data-testid="workspace-directory-row"]')
    expect(selectedAlembicRow).toHaveClass('ring-1', 'ring-primary')
    expect(await screen.findByText('__pycache__')).toBeInTheDocument()
    expect(
      screen.getByText('env.py').closest('[data-testid="workspace-file-row"]')
    ).toHaveAttribute('data-depth', '2')
    expect(screen.getAllByTestId('workspace-tree-indent-guide').length).toBeGreaterThan(0)
  })

  test('right workspace panel ignores stale file preview responses', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    const readmeFile = createDeferred<{
      path: string
      name: string
      content: string
      truncated: boolean
      size: number
      modifiedAt: null
    }>()
    const notesFile = createDeferred<{
      path: string
      name: string
      content: string
      truncated: boolean
      size: number
      modifiedAt: null
    }>()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [
        {
          name: 'README.md',
          path: '/workspace/project/README.md',
          isDirectory: false,
          size: 12,
          modifiedAt: null,
        },
        {
          name: 'NOTES.md',
          path: '/workspace/project/NOTES.md',
          isDirectory: false,
          size: 11,
          modifiedAt: null,
        },
      ],
    })
    const readWorkspaceTextFile = vi.fn((_deviceId: string, path: string) =>
      path.endsWith('README.md') ? readmeFile.promise : notesFile.promise
    )
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
        readWorkspaceTextFile,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('README.md'))
    await user.click(screen.getByText('NOTES.md'))

    await act(async () => {
      notesFile.resolve({
        path: '/workspace/project/NOTES.md',
        name: 'NOTES.md',
        content: 'notes first',
        truncated: false,
        size: 11,
        modifiedAt: null,
      })
    })
    expect(await screen.findByTestId('workspace-file-preview')).toHaveTextContent('notes first')

    await act(async () => {
      readmeFile.resolve({
        path: '/workspace/project/README.md',
        name: 'README.md',
        content: 'readme stale',
        truncated: false,
        size: 12,
        modifiedAt: null,
      })
    })

    expect(screen.getByTestId('workspace-file-preview')).toHaveTextContent('notes first')
    expect(screen.getByTestId('workspace-file-preview')).not.toHaveTextContent('readme stale')
  })

  test('right workspace panel ignores stale directory responses', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const srcTree = createDeferred<{
      path: string
      entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: null
      }>
    }>()
    const docsTree = createDeferred<{
      path: string
      entries: Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: null
      }>
    }>()
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/src') return srcTree.promise
      if (path === '/workspace/project/docs') return docsTree.promise
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
          {
            name: 'docs',
            path: '/workspace/project/docs',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    const srcButton = (await screen.findByText('src')).closest('button')
    const docsButton = screen.getByText('docs').closest('button')
    expect(srcButton).not.toBeNull()
    expect(docsButton).not.toBeNull()
    fireEvent.click(srcButton as HTMLButtonElement)
    fireEvent.click(docsButton as HTMLButtonElement)

    await act(async () => {
      docsTree.resolve({
        path: '/workspace/project/docs',
        entries: [
          {
            name: 'guide.md',
            path: '/workspace/project/docs/guide.md',
            isDirectory: false,
            size: 10,
            modifiedAt: null,
          },
        ],
      })
    })
    expect(await screen.findByText('guide.md')).toBeInTheDocument()

    await act(async () => {
      srcTree.resolve({
        path: '/workspace/project/src',
        entries: [
          {
            name: 'main.ts',
            path: '/workspace/project/src/main.ts',
            isDirectory: false,
            size: 10,
            modifiedAt: null,
          },
        ],
      })
    })

    expect(screen.getByText('docs').closest('[data-testid="workspace-directory-row"]')).toHaveClass(
      'ring-1',
      'ring-primary'
    )
    expect(screen.getByText('guide.md')).toBeInTheDocument()
    expect(screen.getByText('main.ts')).toBeInTheDocument()
  })

  test('right workspace panel retries the failed directory path', async () => {
    const user = userEvent.setup()
    const workspacePanelState = createCloudWorkspacePanelState()
    let srcAttempts = 0
    const listWorkspaceEntries = vi.fn((_deviceId: string, path: string) => {
      if (path === '/workspace/project/src') {
        srcAttempts += 1
        if (srcAttempts === 1) {
          return Promise.reject(new Error('src failed'))
        }
        return Promise.resolve({
          path: '/workspace/project/src',
          entries: [
            {
              name: 'main.ts',
              path: '/workspace/project/src/main.ts',
              isDirectory: false,
              size: 12,
              modifiedAt: null,
            },
          ],
        })
      }
      return Promise.resolve({
        path: '/workspace/project',
        entries: [
          {
            name: 'src',
            path: '/workspace/project/src',
            isDirectory: true,
            size: 0,
            modifiedAt: null,
          },
        ],
      })
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
      }) as never
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await user.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await user.click(screen.getByTestId('right-workspace-file-option'))
    await user.click(await screen.findByText('src'))
    expect(await screen.findByText('src failed')).toBeInTheDocument()

    await user.click(screen.getByTestId('workspace-file-tree-retry-button'))

    expect(await screen.findByText('main.ts')).toBeInTheDocument()
    expect(listWorkspaceEntries).toHaveBeenLastCalledWith(
      'workspace-cloud-device',
      '/workspace/project/src'
    )
  })

  test('right workspace panel keeps the same tree for unrelated message updates', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const listWorkspaceEntries = vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    })
    createDeviceApiMock.mockReturnValue(
      createMockDeviceApi({
        listWorkspaceEntries,
      }) as never
    )
    const layoutProps = {
      ...baseProps,
      state: {
        ...baseProps.state,
        ...workspacePanelState,
      },
      projectWork: {
        ...baseProps.projectWork,
        projects: workspacePanelState.projects,
        devices: workspacePanelState.devices,
        currentProjectId: workspacePanelState.currentProject?.id,
      },
    }

    const { rerender } = render(<DesktopWorkbenchLayout {...layoutProps} />)

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    await waitFor(() => expect(listWorkspaceEntries).toHaveBeenCalledTimes(1))

    rerender(
      <DesktopWorkbenchLayout
        {...layoutProps}
        messages={[
          {
            id: 'message-update',
            role: 'assistant',
            content: 'streaming content changed',
            status: 'streaming',
            createdAt: '2026-06-12T00:00:00.000Z',
          },
        ]}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listWorkspaceEntries).toHaveBeenCalledTimes(1)
  })

  test('workspace file preview comments use the selected duplicate DOM line', async () => {
    const user = userEvent.setup()
    const onAddCodeComment = vi.fn()
    render(
      <WorkspaceFilePreview
        file={{
          path: '/workspace/project/repeat.txt',
          name: 'repeat.txt',
          content: 'repeat\nmiddle\nrepeat',
          truncated: false,
          size: 20,
          modifiedAt: null,
        }}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={onAddCodeComment}
      />
    )
    const secondRepeat = screen.getAllByText('repeat')[1]
    const range = document.createRange()
    range.selectNodeContents(secondRepeat)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.mouseUp(secondRepeat)
    await user.type(screen.getByTestId('workspace-file-comment-input'), 'check second repeat')
    await user.click(screen.getByTestId('workspace-file-add-comment-button'))

    expect(onAddCodeComment).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/workspace/project/repeat.txt',
        startLine: 3,
        endLine: 3,
        selectedText: 'repeat',
        comment: 'check second repeat',
      })
    )
  })

  test('workspace file preview clears local comment state when file changes', async () => {
    const firstFile = {
      path: '/workspace/project/first.txt',
      name: 'first.txt',
      content: 'first file',
      truncated: false,
      size: 10,
      modifiedAt: null,
    }
    const secondFile = {
      path: '/workspace/project/second.txt',
      name: 'second.txt',
      content: 'second file',
      truncated: false,
      size: 11,
      modifiedAt: null,
    }
    const { rerender } = render(
      <WorkspaceFilePreview
        file={firstFile}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )
    const firstText = screen.getByText('first file')
    const range = document.createRange()
    range.selectNodeContents(firstText)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.mouseUp(firstText)
    expect(screen.getByTestId('workspace-file-comment-input')).toBeInTheDocument()

    rerender(
      <WorkspaceFilePreview
        file={secondFile}
        loading={false}
        onRetry={vi.fn()}
        onAddCodeComment={vi.fn()}
      />
    )

    expect(screen.queryByTestId('workspace-file-comment-input')).not.toBeInTheDocument()
  })

  test('opens the environment info popover and closes it from outside click', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
              name: 'yunpeng7-executor-0bb4',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
            },
          ],
        }}
        onLoadEnvironmentInfo={vi.fn().mockResolvedValue({
          additions: '+173',
          deletions: '-13366',
          executionTarget: 'cloud',
          deviceId: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
          workspacePath: '/workspace/projects/github_wegent',
          branchName: 'human/narwhal-20260528-073440',
          createPullRequestUrl:
            'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
        })}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument()
    expect(screen.getByTestId('environment-info-popover')).toHaveClass(
      'w-[340px]',
      'bg-background',
      'text-text-primary',
      'border-border',
      'backdrop-blur-3xl',
      'backdrop-saturate-150'
    )
    expect(screen.getByText('环境信息')).toBeInTheDocument()
    expect(screen.getByText('变更')).toBeInTheDocument()
    const deviceSection = screen.getByTestId('environment-device-section')
    const gitSection = screen.getByTestId('environment-git-section')
    expect(deviceSection).not.toContainElement(gitSection)
    expect(gitSection).not.toContainElement(deviceSection)
    const executionTargetRow = screen.getByTestId('environment-execution-target-row')
    expect(deviceSection).toContainElement(executionTargetRow)
    expect(executionTargetRow).toHaveTextContent('位置')
    expect(executionTargetRow).toHaveTextContent('云设备')
    const deviceButton = await screen.findByTestId('environment-device-button')
    expect(deviceSection).toContainElement(deviceButton)
    expect(deviceButton).toHaveTextContent('设备')
    expect(deviceButton).toHaveTextContent('yunpeng7-executor-0bb4')
    expect(deviceButton).not.toHaveTextContent('云设备')
    expect(deviceButton).not.toHaveTextContent('e13e1a10')
    expect(deviceButton).not.toHaveTextContent('8ef4')
    expect(screen.queryByTestId('environment-device-id')).not.toBeInTheDocument()
    expect(deviceButton).toHaveAttribute('title', '设备 · yunpeng7-executor-0bb4')
    const workspacePathButton = screen.getByTestId('environment-workspace-path-button')
    expect(deviceSection).toContainElement(workspacePathButton)
    expect(workspacePathButton).toHaveTextContent('/workspace/projects/github_wegent')
    expect(workspacePathButton).toContainElement(
      screen.getByTestId('environment-workspace-path-copy-icon')
    )
    expect(gitSection).toHaveTextContent('变更')
    expect(await screen.findByText('+173')).toBeInTheDocument()
    expect(await screen.findByText('-13366')).toBeInTheDocument()
    expect(gitSection).toHaveTextContent('human/narwhal-20260528-073440')
    expect(gitSection).toHaveTextContent('提交')
    expect(gitSection).toHaveTextContent('创建拉取请求')
    expect(gitSection).toHaveTextContent('来源')
    expect(gitSection).toHaveTextContent('暂无来源')

    await userEvent.click(deviceButton)

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

    await userEvent.click(workspacePathButton)

    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      '/workspace/projects/github_wegent'
    )

    await userEvent.click(document.body)

    expect(screen.queryByTestId('environment-info-popover')).not.toBeInTheDocument()
  })

  test('opens environment changes review in the right workspace panel', async () => {
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
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
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-changes-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentDiff).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, name: 'github_wegent' }),
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
    )
    expect(screen.queryByRole('dialog', { name: '本轮文件变更' })).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
    expect(screen.getByTestId('file-changes-review-panel')).toHaveTextContent('+new')
  })

  test('opens environment changes review from the current task execution workspace', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    const onLoadEnvironmentDiff = vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentDiff={onLoadEnvironmentDiff}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          currentTask: {
            id: 8,
            title: 'Task',
            status: 'RUNNING',
            created_at: '2026-06-12T00:00:00.000Z',
            device_id: 'workspace-cloud-device',
            execution_workspace_path: '/workspace/worktrees/8/workspace-project',
          },
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await waitFor(() => expect(screen.getByTestId('right-workspace-review-option')).toBeEnabled())
    await userEvent.click(screen.getByTestId('right-workspace-review-option'))

    await waitFor(() =>
      expect(onLoadEnvironmentDiff).toHaveBeenCalledWith(
        expect.objectContaining({ id: 12, name: 'workspace-project' }),
        {
          deviceId: 'workspace-cloud-device',
          path: '/workspace/worktrees/8/workspace-project',
          source: 'task',
          taskId: 8,
        }
      )
    )
    expect(await screen.findByTestId('file-changes-review-panel')).toHaveTextContent('src/env.ts')
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
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-commit-button'))
    await userEvent.type(screen.getByTestId('environment-commit-message-input'), 'feat: ship')
    await userEvent.click(screen.getByTestId('environment-confirm-commit-button'))

    await waitFor(() =>
      expect(onCommitEnvironmentChanges).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, name: 'github_wegent' }),
        'feat: ship',
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
    )
    expect(screen.getByText('已提交')).toBeInTheDocument()
  })

  test('switches and creates branches from the environment popover', async () => {
    const onListEnvironmentBranches = vi
      .fn()
      .mockResolvedValue(['main', 'human/chipmunk-20260603-053420', 'human/alpaca-20260603-050330'])
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
      />
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
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
    )

    await userEvent.click(screen.getByTestId('environment-branch-row'))
    await userEvent.click(await screen.findByTestId('environment-open-new-branch-button'))
    await userEvent.type(screen.getByTestId('environment-new-branch-input'), 'human/new-branch')
    await userEvent.click(screen.getByTestId('environment-confirm-new-branch-button'))

    await waitFor(() =>
      expect(onCreateEnvironmentBranch).toHaveBeenCalledWith(
        expect.anything(),
        'human/new-branch',
        {
          deviceId: 'device-1',
          path: '/workspace/github_wegent',
          source: 'project',
        }
      )
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

  test('keeps environment info visible without a git branch and hides git actions', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onLoadEnvironmentInfo={vi.fn().mockResolvedValue({
          additions: '+0',
          deletions: '-0',
          executionTarget: 'local',
          deviceId: 'device-1',
          workspacePath: '/workspace/plain-folder',
          branchName: '',
        })}
        onListEnvironmentBranches={vi.fn().mockResolvedValue([])}
        onCheckoutEnvironmentBranch={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() => expect(screen.getByTestId('environment-info-popover')).toBeInTheDocument())
    expect(screen.getByTestId('environment-workspace-path')).toHaveTextContent(
      '/workspace/plain-folder'
    )
    expect(screen.queryByTestId('environment-git-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('environment-branch-row')).not.toBeInTheDocument()
  })

  test('closes the branch menu when Escape is pressed', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('environment-info-button'))
    await userEvent.click(screen.getByTestId('environment-branch-row'))

    expect(await screen.findByTestId('environment-branch-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByTestId('environment-branch-menu')).not.toBeInTheDocument()
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
      />
    )

    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, name: 'workspace' }),
        {
          deviceId: 'device-from-fallback',
          path: '/repo',
          source: 'project',
        }
      )
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
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(sinaProject, {
        deviceId: 'device-sina',
        path: '/Users/hongyu9/Downloads/sina-sso',
        source: 'project',
      })
    )
  })

  test('loads environment info from the current runtime task workspace', async () => {
    const onLoadEnvironmentInfo = vi.fn().mockResolvedValue({
      additions: '+2',
      deletions: '-0',
      executionTarget: 'local' as const,
      deviceId: 'runtime-device',
      branchName: 'runtime/worktree',
    })
    const onGetProjectWorkspaceRoot = vi.fn().mockResolvedValue('/workspace/projects')
    const runtimeProject = {
      id: 12,
      name: 'runtime-project',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'runtime-device',
        },
      },
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onLoadEnvironmentInfo={onLoadEnvironmentInfo}
        state={{
          ...baseProps.state,
          currentProject: null,
          currentRuntimeTask: {
            deviceId: 'runtime-device',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-1',
          },
          projects: [
            {
              id: 2,
              name: 'fallback',
              tasks: [],
              config: {
                mode: 'workspace',
                execution: {
                  targetType: 'local',
                  deviceId: 'fallback-device',
                },
                workspace: {
                  source: 'local_path',
                  localPath: '/workspace/fallback',
                },
              },
            },
            runtimeProject,
          ],
          runtimeWork: {
            projects: [
              {
                project: { id: runtimeProject.id, name: runtimeProject.name },
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'runtime-device',
                    workspacePath: '/workspace/project-alpha',
                    available: true,
                    mapped: true,
                    localTasks: [
                      {
                        localTaskId: 'runtime-1',
                        workspacePath: '/workspace/worktrees/8/project-alpha',
                        title: 'Runtime task',
                        runtime: 'codex',
                      },
                    ],
                  },
                ],
              },
            ],
            unmappedDeviceWorkspaces: [],
            totalLocalTasks: 1,
          },
        }}
      />
    )

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() =>
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(runtimeProject, {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/8/project-alpha',
        source: 'runtime',
      })
    )
    expect(onGetProjectWorkspaceRoot).not.toHaveBeenCalled()
  })

  test('loads environment info only when the environment popover opens', async () => {
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
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
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
      />
    )

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(onLoadEnvironmentInfo).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('environment-info-button'))

    await waitFor(() => {
      expect(onLoadEnvironmentInfo).toHaveBeenCalledTimes(1)
      expect(onLoadEnvironmentInfo).toHaveBeenCalledWith(workspaceProject, {
        deviceId: 'device-1',
        path: '/repo',
        source: 'project',
      })
    })
  })

  test('closes the right workspace panel from the panel actions', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    const floatingActions = screen.getByTestId('workspace-panel-floating-actions')
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
  })

  test('opens and resizes the bottom workspace panel', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveClass(
      'transition-[height,opacity,transform]',
      'duration-300',
      'ease-out',
      'pointer-events-auto',
      'translate-y-0',
      'opacity-100'
    )
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('bottom-workspace-resize-handle'), { clientY: 700 })
    fireEvent.pointerMove(document, { clientY: 620 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ height: '400px' })
  })

  test('bottom workspace terminal uses the current task execution workspace session', async () => {
    const workspacePanelState = createCloudWorkspacePanelState()
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
          currentTask: {
            id: 8,
            title: 'Task',
            status: 'RUNNING',
            created_at: '2026-06-12T00:00:00.000Z',
            device_id: 'workspace-cloud-device',
            execution_workspace_path: '/workspace/worktrees/8/workspace-project',
          },
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject?.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledWith(12, { taskId: 8 }))
  })

  test('opens the terminal by default when the bottom workspace panel opens', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() => expect(startTerminalSessionMock).toHaveBeenCalledWith(12))
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.queryByTestId('workspace-terminal-frame')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
  })

  test('closes the bottom workspace panel from the panel edge', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveClass('opacity-100')

    await userEvent.click(screen.getByTestId('close-bottom-workspace-panel-button'))

    expect(panel).toBeInTheDocument()
    expect(panel).toHaveStyle({ height: '0px' })
    expect(panel).toHaveClass('pointer-events-none', 'translate-y-3', 'opacity-0')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
  })
})
