import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import { MessageList } from '@/components/chat/MessageList'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type {
  Attachment,
  DeviceInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeTranscriptResponse,
  TurnFileChangesSummary,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Project Device',
    status: 'online',
    is_default: true,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

function createProject(overrides: Partial<ProjectWithTasks> = {}): ProjectWithTasks {
  return {
    id: 7,
    name: 'Wegent',
    tasks: [],
    config: {
      mode: 'workspace',
      execution: {
        targetType: 'local',
        deviceId: 'device-1',
      },
      workspace: {
        source: 'local_path',
        localPath: '/workspace/project-alpha',
      },
    },
    ...overrides,
  }
}

function createRuntimeWork(
  overrides: Partial<RuntimeWorkListResponse> = {}
): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, name: 'Wegent' },
        deviceWorkspaces: [
          {
            id: 22,
            projectId: 7,
            deviceId: 'device-1',
            deviceName: 'Project Device',
            deviceStatus: 'online',
            workspacePath: '/workspace/project-alpha',
            mapped: true,
            available: true,
            localTasks: [
              {
                localTaskId: 'runtime-a',
                workspacePath: '/workspace/project-alpha',
                title: 'Runtime A',
                runtime: 'claude_code',
              },
              {
                localTaskId: 'runtime-b',
                workspacePath: '/workspace/project-alpha',
                title: 'Runtime B',
                runtime: 'claude_code',
              },
              {
                localTaskId: 'runtime-restored',
                workspacePath: '/workspace/project-alpha',
                title: 'Restored runtime',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalLocalTasks: 3,
      },
    ],
    unmappedDeviceWorkspaces: [],
    totalLocalTasks: 3,
    ...overrides,
  }
}

function createTurnFileChanges(): TurnFileChangesSummary {
  return {
    version: 1,
    status: 'active',
    artifact_id: 'artifact-1',
    device_id: 'device-1',
    workspace_path: '/workspace/project-alpha',
    file_count: 1,
    additions: 6,
    deletions: 4,
    files: [
      {
        old_path: null,
        path: 'wework/src/features/workbench/WorkbenchProvider.tsx',
        change_type: 'modified',
        additions: 6,
        deletions: 4,
        binary: false,
      },
    ],
    reverted_at: null,
  }
}

function createImageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 45,
    filename: 'photo.png',
    file_size: 1200,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-05-27T00:00:00.000Z',
    ...overrides,
  }
}

function createRuntimeWorkApiMock(overrides: Record<string, unknown> = {}) {
  return {
    listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    upsertDeviceWorkspace: vi.fn(),
    prepareDeviceWorkspace: vi.fn(),
    getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
      localTaskId: address.localTaskId,
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [],
    })),
    sendRuntimeMessage: vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    }),
    openRuntimeWorkspace: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
      threadId: 'thread-1',
    }),
    bindRuntimeTaskImSessions: vi.fn(),
    getImNotificationSettings: vi.fn().mockResolvedValue({
      global: { enabled: false, sessionKey: null, session: null },
      runtimeTaskSubscriptions: [],
    }),
    updateGlobalImNotification: vi.fn(),
    subscribeRuntimeTaskNotifications: vi.fn(),
    unsubscribeRuntimeTaskNotifications: vi.fn(),
    archiveRuntimeTask: vi.fn(),
    cancelRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    }),
    createRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      localTaskId: 'runtime-created',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
    }),
    forkRuntimeTask: vi.fn(),
    ...overrides,
  }
}

function createWorkbenchServices(overrides: Partial<WorkbenchServices> = {}): WorkbenchServices {
  const base = {
    teamApi: {
      getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
    },
    modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
    skillApi: {
      listSkills: vi.fn().mockResolvedValue([]),
      getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
    },
    projectApi: {
      listProjects: vi.fn().mockResolvedValue({ items: [createProject()] }),
      getProject: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
    },
    taskApi: {
      getTurnFileChangesDiff: vi.fn(),
      revertTurnFileChanges: vi.fn(),
    },
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([createDevice()]),
      getHomeDirectory: vi.fn(),
      getProjectWorkspaceRoot: vi.fn(),
      listDirectories: vi.fn(),
      createDirectory: vi.fn(),
      executeCommand: vi.fn(),
      upgradeDevice: vi.fn(),
      listSkills: vi.fn().mockResolvedValue([]),
    },
    runtimeWorkApi: createRuntimeWorkApiMock(),
    chatStream: {
      sendGuidance: vi.fn(),
      cancelStream: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  } as unknown as WorkbenchServices

  return {
    ...base,
    ...overrides,
    projectApi: { ...base.projectApi, ...overrides.projectApi },
    taskApi: { ...base.taskApi, ...overrides.taskApi },
    deviceApi: { ...base.deviceApi, ...overrides.deviceApi },
    chatStream: { ...base.chatStream, ...overrides.chatStream },
  } as WorkbenchServices
}

function renderWorkbench(children: React.ReactNode, services = createWorkbenchServices()) {
  return render(
    <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
      {children}
    </WorkbenchProvider>
  )
}

function BootstrapProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <span data-testid="boot-state">
        {workbench.state.isBootstrapping ? 'loading' : workbench.state.user?.user_name}
      </span>
      <span data-testid="project-count">{workbench.state.projects.length}</span>
      <span data-testid="runtime-total">{workbench.state.runtimeWork?.totalLocalTasks ?? 0}</span>
    </div>
  )
}

function DeviceStatusProbe() {
  const workbench = useWorkbench()
  return <span data-testid="device-status">{workbench.state.devices[0]?.status ?? 'missing'}</span>
}

function ProjectSendProbe() {
  const workbench = useWorkbench()
  const imageAttachment = createImageAttachment()

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {workbench.state.currentRuntimeTask
          ? `${workbench.state.currentRuntimeTask.deviceId}:${workbench.state.currentRuntimeTask.localTaskId}`
          : 'none'}
      </span>
      <span data-testid="message-contents">
        {workbench.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="message-roles">
        {workbench.messages.map(message => `${message.role}:${message.content}`).join('|')}
      </span>
      <span data-testid="project-attachment-count">
        {workbench.projectChat.attachments.length}
      </span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <button type="button" onClick={() => workbench.selectProjectWorkspace(7, null)}>
        select project
      </button>
      <button
        type="button"
        onClick={() => workbench.openStandaloneWorkspace('device-1', '/workspace/direct-codex')}
      >
        open standalone workspace
      </button>
      <button type="button" onClick={() => workbench.setInput('修复 CI')}>
        set input
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(imageAttachment)}
      >
        add image attachment
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send
      </button>
      <MessageList messages={workbench.messages} />
    </div>
  )
}

function RuntimeOpenProbe() {
  const workbench = useWorkbench()
  const [fileChangesDiff, setFileChangesDiff] = useState('')
  const [fileChangesStatus, setFileChangesStatus] = useState('')
  const fileChangesSubtaskId = workbench.messages.find(message => message.fileChanges)?.subtaskId
  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {workbench.state.currentRuntimeTask
          ? `${workbench.state.currentRuntimeTask.deviceId}:${workbench.state.currentRuntimeTask.localTaskId}`
          : 'none'}
      </span>
      <span data-testid="runtime-open-messages">
        {workbench.messages.map(message => message.content).join('|')}
      </span>
      <span data-testid="runtime-transcript-loading">
        {workbench.isRuntimeTranscriptLoading ? 'loading' : 'idle'}
      </span>
      <span data-testid="runtime-transcript-has-more">
        {workbench.runtimeTranscriptHasMoreBefore ? 'more' : 'done'}
      </span>
      <span data-testid="runtime-open-blocks">
        {workbench.messages
          .flatMap(message => message.blocks ?? [])
          .map(block => {
            if (block.type === 'tool') return `tool:${block.toolName}:${block.status}`
            if (block.type === 'thinking') return `thinking:${block.content}:${block.status}`
            return `text:${block.content}:${block.status}`
          })
          .join('|')}
      </span>
      <span data-testid="runtime-open-block-times">
        {workbench.messages
          .flatMap(message => message.blocks ?? [])
          .map(block => block.createdAt)
          .join('|')}
      </span>
      <span data-testid="runtime-open-file-changes">
        {workbench.messages
          .map(message =>
            message.fileChanges
              ? `${message.fileChanges.file_count}:${message.fileChanges.additions}:${message.fileChanges.deletions}`
              : ''
          )
          .filter(Boolean)
          .join('|')}
      </span>
      <span data-testid="runtime-open-error">{workbench.state.error ?? ''}</span>
      <span data-testid="runtime-file-changes-diff">{fileChangesDiff}</span>
      <span data-testid="runtime-file-changes-status">{fileChangesStatus}</span>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench.loadTurnFileChangesDiff(fileChangesSubtaskId).then(setFileChangesDiff)
          }
        }}
      >
        review runtime file changes
      </button>
      <button
        type="button"
        onClick={() => {
          if (fileChangesSubtaskId) {
            void workbench
              .revertTurnFileChanges(fileChangesSubtaskId)
              .then(fileChanges => setFileChangesStatus(fileChanges.status))
          }
        }}
      >
        revert runtime file changes
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeLocalTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-a',
          })
        }
      >
        open runtime a
      </button>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeLocalTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-b',
          })
        }
      >
        open runtime b
      </button>
      <button type="button" onClick={() => void workbench.loadOlderRuntimeTranscript()}>
        load older
      </button>
    </div>
  )
}

function RuntimeModelCompatibilityProbe() {
  const workbench = useWorkbench()
  const modelRows = workbench.projectChat.models.map(model => {
    const disabledReason = model.compatibilityDisabledReason ?? 'enabled'
    return `${model.name}:${model.compatibilityDisabled ? disabledReason : 'enabled'}`
  })

  return (
    <div>
      <span data-testid="runtime-model-compatibility">{modelRows.join('|')}</span>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeLocalTask({
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            localTaskId: 'runtime-a',
          })
        }
      >
        open runtime a
      </button>
    </div>
  )
}

function FollowUpProbe() {
  const workbench = useWorkbench()
  const imageAttachment = createImageAttachment()
  const firstQueuedMessage = workbench.queuedMessages[0]

  return (
    <div>
      <span data-testid="composer-input">{workbench.state.input}</span>
      <span data-testid="queued-messages">
        {workbench.queuedMessages.map(message => `${message.status}:${message.content}`).join('|')}
      </span>
      <span data-testid="queued-errors">
        {workbench.queuedMessages.map(message => message.error ?? '').join('|')}
      </span>
      <span data-testid="queued-notices">
        {workbench.queuedMessages.map(message => message.notice ?? '').join('|')}
      </span>
      <span data-testid="runtime-attachment-count">
        {workbench.projectChat.attachments.length}
      </span>
      <span data-testid="guidance-messages">
        {workbench.guidanceMessages
          .map(message => `${message.status}:${message.content}`)
          .join('|')}
      </span>
      <button type="button" onClick={() => workbench.setInput('继续修')}>
        set follow-up
      </button>
      <button type="button" onClick={() => workbench.setInput('执行ls')}>
        set ls follow-up
      </button>
      <button
        type="button"
        onClick={() => workbench.projectChat.addExistingAttachment(imageAttachment)}
      >
        add image attachment
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send follow-up
      </button>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh work lists
      </button>
      <button
        type="button"
        onClick={() => {
          if (firstQueuedMessage) workbench.editQueuedMessage(firstQueuedMessage.id)
        }}
      >
        edit first queued
      </button>
      <button
        type="button"
        onClick={() => {
          if (firstQueuedMessage) void workbench.sendQueuedAsGuidance(firstQueuedMessage.id)
        }}
      >
        guide first queued
      </button>
    </div>
  )
}

function RuntimeTaskSkillsProbe() {
  const workbench = useWorkbench()
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void workbench.openRuntimeLocalTask({
            deviceId: 'runtime-device',
            workspacePath: '/workspace/runtime-device',
            localTaskId: 'runtime-skill-task',
          })
        }
      >
        open runtime skill task
      </button>
      <button type="button" onClick={() => void workbench.projectChat.listLocalSkills()}>
        list local skills
      </button>
    </div>
  )
}

describe('WorkbenchProvider runtime tasks', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  test('bootstraps projects and runtime work without DB task APIs', async () => {
    const services = createWorkbenchServices()

    renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('alice'))
    expect(screen.getByTestId('project-count')).toHaveTextContent('0')
    expect(screen.getByTestId('runtime-total')).toHaveTextContent('3')
    expect(services.projectApi.listProjects).not.toHaveBeenCalled()
    expect(services.runtimeWorkApi?.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('applies device online events immediately when refresh falls back would be stale', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'offline' })])
      .mockRejectedValue(new Error('network unavailable'))
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<DeviceStatusProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('offline'))

    await act(async () => {
      streamHandlers.onDeviceOnline?.({
        device_id: 'device-1',
        name: 'Project Device',
      })
    })

    expect(screen.getByTestId('device-status')).toHaveTextContent('online')
  })

  test('ensures the chat socket is connected while mounted', async () => {
    const socketClient = {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    }
    const services = createWorkbenchServices({
      socketClient,
    } as Partial<WorkbenchServices>)

    const { unmount } = renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(socketClient.ensureConnected).toHaveBeenCalledTimes(1))
    expect(socketClient.dispose).not.toHaveBeenCalled()

    unmount()

    expect(socketClient.dispose).toHaveBeenCalledTimes(1)
  })

  test('locks existing runtime task model choices to its runtime protocol', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'kimi-k2.5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
    ]
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'wecode-claude-sonnet-4-5:enabled',
          'kimi-k2.5:enabled',
          'codex-gpt-5.5:runtime_family_mismatch',
          'gpt-5-2025-08-07:runtime_family_mismatch',
        ].join('|')
      )
    )
  })

  test('keeps ChatGPT models selectable inside existing Codex runtime tasks', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  localTasks: [
                    {
                      localTaskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'codex-gpt-5.5:enabled',
          'gpt-5-2025-08-07:enabled',
          'wecode-claude-sonnet-4-5:runtime_family_mismatch',
        ].join('|')
      )
    )
  })

  test('creates a runtime local task for a new project message', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  localTasks: [],
                },
              ],
            },
          ],
          totalLocalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'resolved-device',
        localTaskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'assistant-1', role: 'assistant', content: '已开始处理' }],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('task_id')
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'resolved-device:runtime-created'
      )
    )
    expect(screen.getByTestId('message-contents')).toHaveTextContent('已开始处理')
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'resolved-device',
      localTaskId: 'runtime-created',
    })
  })

  test('renders image attachments immediately when creating a runtime local task', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:runtime-message-image-preview')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )
    const transcript = deferred<RuntimeTranscriptResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'resolved-device',
        localTaskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockReturnValue(transcript.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('0')
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: [45],
      })
    )
    expect(await screen.findByTestId('message-image-preview')).toHaveAttribute(
      'src',
      'blob:runtime-message-image-preview'
    )
  })

  test('creates a runtime local task from an explicitly opened standalone workspace', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        localTaskId: 'standalone-created',
        workspacePath: '/workspace/direct-codex',
        runtime: 'codex',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'standalone-created',
        workspacePath: '/workspace/direct-codex',
        runtime: 'codex',
        messages: [{ id: 'assistant-1', role: 'assistant', content: 'started' }],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('open standalone workspace')).toBeInTheDocument())
    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    })
    expect(`${window.location.pathname}${window.location.search}`).toBe('/')
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/direct-codex',
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
  })

  test('renders streaming local task chunks when the socket connects after chat start', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const transcript = deferred<RuntimeTranscriptResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'resolved-device',
        localTaskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      }),
      getRuntimeTranscript: vi.fn().mockReturnValue(transcript.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'resolved-device:runtime-created'
      )
    )

    await act(async () => {
      streamHandlers.onChatChunk?.({
        subtask_id: 102,
        content: 'streamed answer',
        offset: 0,
        device_id: 'resolved-device',
        local_task_id: 'runtime-created',
      })
    })

    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant:streamed answer')

    await act(async () => {
      transcript.resolve({
        localTaskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          { id: 'user-1', role: 'user', content: '修复 CI' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'streamed answer',
            subtaskId: 102,
          },
        ],
      })
      await transcript.promise
    })
  })

  test('restores a runtime local task from the URL with transcript blocks', async () => {
    window.history.pushState(
      {},
      '',
      '/runtime-tasks?deviceId=device-1&localTaskId=runtime-restored'
    )
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      localTaskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '恢复的问题' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '恢复的回答',
          subtaskId: 901,
          blocks: [
            {
              id: 'thinking-901',
              type: 'thinking',
              content: '读取历史记录',
              status: 'done',
              timestamp: 1770000000,
            },
            {
              id: 'call-901',
              type: 'tool',
              tool_name: 'exec_command',
              tool_input: { cmd: 'pwd' },
              tool_output: '/workspace/project-alpha',
              status: 'done',
              timestamp: 1770000001000,
            },
            {
              id: 'text-901',
              type: 'text',
              content: '处理完成',
              status: 'done',
              timestamp: 1770000002000,
            },
          ],
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-restored'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('恢复的问题')
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'thinking:读取历史记录:done'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('tool:exec_command:done')
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('text:处理完成:done')
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      localTaskId: 'runtime-restored',
      limit: 50,
    })
  })

  test('uses runtime transcript server times for blocks without timestamps', async () => {
    vi.setSystemTime(new Date('2026-06-05T00:01:00.000Z'))
    window.history.pushState(
      {},
      '',
      '/runtime-tasks?deviceId=device-1&localTaskId=runtime-restored'
    )
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      localTaskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '恢复的回答',
          subtaskId: 901,
          createdAt: '2026-06-05T00:00:00.000Z',
          blocks: [
            {
              id: 'thinking-901',
              type: 'thinking',
              content: '读取历史记录',
              status: 'done',
              created_at: '2026-06-05T00:00:06.000Z',
            },
            {
              id: 'text-901',
              type: 'text',
              content: '处理完成',
              status: 'done',
            },
          ],
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-block-times')).toHaveTextContent(
        '1780617606000|1780617600000'
      )
    )
  })

  test('restores runtime transcript file changes onto assistant messages', async () => {
    window.history.pushState(
      {},
      '',
      '/runtime-tasks?deviceId=device-1&localTaskId=runtime-restored'
    )
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      localTaskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: 902,
          fileChanges: createTurnFileChanges(),
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
  })

  test('loads older runtime transcript messages before the current page', async () => {
    const getRuntimeTranscript = vi.fn(request => {
      if (request.beforeCursor === 'offset:120') {
        return Promise.resolve({
          localTaskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
          messages: [{ id: 'runtime-a:user:o20', role: 'user', content: 'older message' }],
          hasMoreBefore: false,
          beforeCursor: null,
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:o120', role: 'user', content: 'recent message' }],
        hasMoreBefore: true,
        beforeCursor: 'offset:120',
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('recent message')
    )
    expect(screen.getByTestId('runtime-transcript-has-more')).toHaveTextContent('more')

    await userEvent.click(screen.getByText('load older'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
        'older message|recent message'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      localTaskId: 'runtime-a',
      limit: 50,
      beforeCursor: 'offset:120',
    })
    expect(screen.getByTestId('runtime-transcript-has-more')).toHaveTextContent('done')
  })

  test('reviews and reverts runtime transcript file changes through device commands', async () => {
    window.history.pushState(
      {},
      '',
      '/runtime-tasks?deviceId=device-1&localTaskId=runtime-restored'
    )
    const fileChanges = createTurnFileChanges()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      localTaskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: 902,
          fileChanges,
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: { success: true, diff: 'diff --git a/file b/file' },
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: { success: true, status: 'reverted' },
        stderr: '',
      })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript,
      }) as WorkbenchServices['runtimeWorkApi'],
      deviceApi: {
        executeCommand,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
    await userEvent.click(screen.getByText('review runtime file changes'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-diff')).toHaveTextContent(
        'diff --git a/file b/file'
      )
    )
    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'turn_file_changes_review',
      path: fileChanges.workspace_path,
      args: [fileChanges.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })

    await userEvent.click(screen.getByText('revert runtime file changes'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-status')).toHaveTextContent('reverted')
    )
    expect(executeCommand).toHaveBeenLastCalledWith('device-1', {
      command_key: 'turn_file_changes_revert',
      path: fileChanges.workspace_path,
      args: [fileChanges.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
    expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
  })

  test('switches the selected runtime task before transcript loading finishes', async () => {
    const firstTranscript = deferred<RuntimeTranscriptResponse>()
    const getRuntimeTranscript = vi.fn((address: RuntimeTaskAddress) => {
      if (address.localTaskId === 'runtime-a') return firstTranscript.promise
      return Promise.resolve({
        localTaskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('loading')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('')

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('idle')

    await act(async () => {
      firstTranscript.resolve({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
      })
      await firstTranscript.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-b'
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('message a')
  })

  test('reuses the current runtime task address for follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-a',
      },
      message: '继续修',
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
  })

  test('queues runtime messages while current response is running', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  localTasks: [
                    {
                      localTaskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('queues runtime messages while an assistant stream is active before runtime status refreshes', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
        sendGuidance: vi.fn(),
        cancelStream: vi.fn(),
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        task_id: 77,
        subtask_id: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
  })

  test('sends queued runtime messages when the task becomes idle', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runningRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              localTasks: [
                {
                  localTaskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalLocalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              localTasks: [
                {
                  localTaskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'claude_code',
                  running: false,
                },
              ],
            },
          ],
        },
      ],
      totalLocalTasks: 1,
    })
    let runtimeRunning = true
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
        ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    runtimeRunning = false
    await userEvent.click(screen.getByText('refresh work lists'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-a',
      },
      message: '继续修',
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
  })

  test('edits queued runtime messages back into the composer', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  localTasks: [
                    {
                      localTaskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('edit first queued'))

    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
  })

  test('sends queued runtime messages as guidance for the active stream', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const sendGuidance = vi.fn().mockResolvedValue({
      success: true,
      guidance_id: 'guidance-runtime-1',
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  localTasks: [
                    {
                      localTaskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
        sendGuidance,
        cancelStream: vi.fn(),
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        task_id: 77,
        subtask_id: 101,
        shell_type: 'Chat',
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(sendGuidance).toHaveBeenCalledTimes(1))
    expect(sendGuidance).toHaveBeenCalledWith({
      task_id: 77,
      subtask_id: 101,
      team_id: 2,
      message: '继续修',
      guidance: '继续修',
      client_guidance_id: expect.stringMatching(/^guidance-101-/),
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('queued:继续修')
  })

  test('pauses the active local task before sending queued guidance without DB task context', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const sendGuidance = vi.fn().mockResolvedValue({
      success: true,
      guidance_id: 'guidance-runtime-1',
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  localTasks: [
                    {
                      localTaskId: 'runtime-a',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime A',
                      runtime: 'claude_code',
                      running: true,
                    },
                  ],
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        })
      ),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
        sendGuidance,
        cancelStream: vi.fn(),
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        subtask_id: 101,
        shell_type: 'Codex',
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
    })
    await userEvent.click(screen.getByText('set ls follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    expect(sendGuidance).not.toHaveBeenCalled()
    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      localTaskId: 'runtime-a',
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-a',
      },
      message: '执行ls',
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('queued-errors')).not.toHaveTextContent('当前回复缺少引导上下文')
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('执行ls')
  })

  test('sends image attachments with current runtime task follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-a',
      },
      message: '继续修',
      attachmentIds: [45],
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('loads local skills from the current runtime task device', async () => {
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'device-1', name: 'Default Device' }),
            createDevice({ id: 2, device_id: 'runtime-device', name: 'Runtime Device' }),
          ]),
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'env-context',
            description: 'Environment facts',
            path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
            source: 'codex',
          },
        ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
          localTaskId: address.localTaskId,
          workspacePath: address.workspacePath,
          runtime: 'codex',
          messages: [],
        })),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskSkillsProbe />, services)

    await userEvent.click(screen.getByText('open runtime skill task'))
    await waitFor(() =>
      expect(services.runtimeWorkApi?.getRuntimeTranscript).toHaveBeenCalledWith({
        deviceId: 'runtime-device',
        workspacePath: '/workspace/runtime-device',
        localTaskId: 'runtime-skill-task',
        limit: 50,
      })
    )

    await userEvent.click(screen.getByText('list local skills'))

    await waitFor(() => {
      expect(services.deviceApi.listSkills).toHaveBeenCalledWith('runtime-device')
    })
  })

  test('ignores stream events from a previously selected runtime task', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )

    await act(async () => {
      streamHandlers.onChatMessage?.({
        subtask_id: 101,
        role: 'assistant',
        content: 'stale runtime a output',
        created_at: '2026-06-20T00:00:00.000Z',
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
      streamHandlers.onChatMessage?.({
        subtask_id: 102,
        role: 'assistant',
        content: 'current runtime b output',
        created_at: '2026-06-20T00:00:01.000Z',
        device_id: 'device-1',
        local_task_id: 'runtime-b',
      })
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
      'current runtime b output'
    )
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent(
      'stale runtime a output'
    )
  })
})
