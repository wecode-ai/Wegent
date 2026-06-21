import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import type { Attachment, SkillRef, UnifiedModel } from '@/types/api'
import type { CodeCommentContext } from '@/types/workspace-files'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import type { ChatStreamHandlers } from '@/stream/chatStream'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createRuntimeWorkApiMock(overrides: Record<string, unknown> = {}): {
  listRuntimeWork: ReturnType<typeof vi.fn>
  createRuntimeTask: ReturnType<typeof vi.fn>
  sendRuntimeMessage: ReturnType<typeof vi.fn>
  bindRuntimeTaskImSessions: ReturnType<typeof vi.fn>
  archiveRuntimeTask: ReturnType<typeof vi.fn>
  getRuntimeTranscript: ReturnType<typeof vi.fn>
} {
  return {
    listRuntimeWork: vi.fn().mockResolvedValue({
      projects: [],
      unmappedDeviceWorkspaces: [],
      totalLocalTasks: 0,
    }),
    createRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      localTaskId: 'runtime-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
    }),
    sendRuntimeMessage: vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-1',
    }),
    bindRuntimeTaskImSessions: vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-1',
      },
      boundSessionKeys: ['session-7', 'session-9'],
      notifiedCount: 2,
    }),
    archiveRuntimeTask: vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'runtime-1',
      workspacePath: '/workspace/project-alpha',
    }),
    getRuntimeTranscript: vi.fn().mockResolvedValue({
      localTaskId: 'runtime-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [],
    }),
    ...overrides,
  }
}

function createWorkbenchServices(overrides: Partial<WorkbenchServices> = {}): WorkbenchServices {
  return {
    teamApi: {
      getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
    },
    modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
    skillApi: {
      listSkills: vi.fn().mockResolvedValue([]),
      getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
    },
    projectApi: {
      listProjects: vi.fn().mockResolvedValue({ items: [] }),
      getProject: vi.fn(),
      createProject: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
    },
    taskApi: {
      getTaskDetail: vi.fn(),
      renameTask: vi.fn(),
    },
    deviceApi: {
      listDevices: vi.fn().mockResolvedValue([]),
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
      joinTask: vi.fn(),
      leaveTask: vi.fn(),
      sendMessage: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
    ...overrides,
  } as WorkbenchServices
}

function Probe() {
  const { state } = useWorkbench()
  return <div data-testid="probe">{state.isBootstrapping ? 'loading' : state.user?.user_name}</div>
}

function ProjectChatProbe() {
  const workbench = useWorkbench()
  const projectChat = workbench.projectChat

  const selectedModel: UnifiedModel = {
    name: 'gpt-5.5-medium',
    type: 'user',
    displayName: 'GPT 5.5 Medium',
  }
  const runtimeModel: UnifiedModel = {
    name: 'codex-gpt-5.5',
    type: 'runtime',
    displayName: 'GPT-5.5 (Codex)',
    provider: 'openai',
    modelId: 'gpt-5.5',
    config: {
      protocol: 'openai-responses',
      apiFormat: 'responses',
    },
    runtime: {
      family: 'openai.openai-responses',
      provider: 'openai',
    },
  }
  const selectedSkill: SkillRef = {
    name: 'project-summary',
    namespace: 'default',
    is_public: false,
  }
  const attachment: Attachment = {
    id: 42,
    filename: 'brief.pdf',
    file_size: 1200,
    mime_type: 'application/pdf',
    status: 'ready',
    file_extension: '.pdf',
    created_at: '2026-05-27T00:00:00.000Z',
  }

  return (
    <div>
      <span data-testid="message-attachment-filenames">
        {workbench.messages
          .flatMap(message => (message.attachments ?? []).map(attachment => attachment.filename))
          .join(',')}
      </span>
      <span data-testid="project-execution-mode">{workbench.projectExecutionMode}</span>
      <span data-testid="project-worktree-base-branch">
        {workbench.projectWorktreeBaseBranch ?? 'no-branch'}
      </span>
      <span data-testid="workbench-input">{workbench.state.input}</span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="current-runtime-task-address">
        {workbench.state.currentRuntimeTask
          ? `${workbench.state.currentRuntimeTask.deviceId}:${workbench.state.currentRuntimeTask.workspacePath}:${workbench.state.currentRuntimeTask.localTaskId}`
          : 'no-runtime-task'}
      </span>
      <button type="button" onClick={() => workbench.selectProject(7)}>
        select project
      </button>
      <button type="button" onClick={() => workbench.startNewProjectChat(8)}>
        start project 8 chat
      </button>
      <button type="button" onClick={() => projectChat.setSelectedModel(selectedModel)}>
        select model
      </button>
      <button type="button" onClick={() => projectChat.setSelectedModel(runtimeModel)}>
        select runtime model
      </button>
      <button type="button" onClick={() => projectChat.setSelectedSkills([selectedSkill])}>
        select skill
      </button>
      <button type="button" onClick={() => projectChat.addExistingAttachment(attachment)}>
        add attachment
      </button>
      <button type="button" onClick={() => workbench.setProjectExecutionMode('git_worktree')}>
        select worktree
      </button>
      <button type="button" onClick={() => workbench.setProjectWorktreeBaseBranch('develop')}>
        select develop source branch
      </button>
      <button type="button" onClick={() => workbench.setInput('build it')}>
        set input
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send
      </button>
    </div>
  )
}

function CodeCommentSendProbe() {
  const workbench = useWorkbench()
  const codeComment: CodeCommentContext = {
    id: 'comment-1',
    filePath: 'src/app.ts',
    fileName: 'app.ts',
    startLine: 12,
    endLine: 14,
    selectedText: 'const answer = computeAnswer()',
    comment: 'Check whether this handles retries.',
    createdAt: '2026-06-12T00:00:00.000Z',
  }

  return (
    <div>
      <span data-testid="code-comment-context-count">{workbench.codeCommentContexts.length}</span>
      <span data-testid="message-contents">
        {workbench.messages.map(message => message.content).join('|')}
      </span>
      <button type="button" onClick={() => workbench.selectProject(7)}>
        select project
      </button>
      <button type="button" onClick={() => workbench.addCodeCommentContext(codeComment)}>
        add code comment
      </button>
      <button type="button" onClick={() => workbench.setInput('please inspect')}>
        set input
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send
      </button>
    </div>
  )
}

function RetryFailedMessageProbe() {
  const workbench = useWorkbench()
  const failedMessage = workbench.messages.find(
    message => message.role === 'assistant' && message.status === 'failed'
  )

  return (
    <div>
      <button type="button" onClick={() => workbench.setInput('hi')}>
        set retry input
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send retry input
      </button>
      <button
        type="button"
        onClick={() => {
          if (failedMessage) {
            void workbench.retryFailedMessage(failedMessage.id)
          }
        }}
      >
        retry failed message
      </button>
      <span data-testid="retry-message-states">
        {workbench.messages
          .map(message => `${message.role}:${message.content}:${message.status}`)
          .join('|')}
      </span>
    </div>
  )
}

function ModelCompatibilityProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open task
      </button>
      <div data-testid="model-compatibility-status">
        {workbench.projectChat.models
          .map(model => `${model.name}:${model.compatibilityDisabledReason ?? 'enabled'}`)
          .join('|')}
      </div>
    </div>
  )
}

function ProjectTaskSendProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="workbench-input">{workbench.state.input}</span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <span data-testid="current-task-id">{workbench.state.currentTask?.id ?? 'no-task'}</span>
      <span data-testid="project-count">{workbench.state.projects.length}</span>
      <button type="button" onClick={() => void workbench.openTask(71)}>
        open project task
      </button>
      <button type="button" onClick={() => workbench.setInput('continue')}>
        set input
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send
      </button>
    </div>
  )
}

function RuntimeRefreshProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="runtime-total">
        {workbench.state.runtimeWork?.totalLocalTasks ?? 'no-runtime-work'}
      </span>
      <button type="button" onClick={() => void workbench.refreshWorkLists()}>
        refresh runtime work
      </button>
    </div>
  )
}

function StandaloneRuntimeSendProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="standalone-device-id">
        {workbench.state.standaloneDeviceId ?? 'no-device'}
      </span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <button type="button" onClick={() => workbench.setInput('run pwd')}>
        set input
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send
      </button>
    </div>
  )
}

function RuntimeOpenProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-runtime-task-address">
        {workbench.state.currentRuntimeTask
          ? `${workbench.state.currentRuntimeTask.deviceId}:${workbench.state.currentRuntimeTask.workspacePath}:${workbench.state.currentRuntimeTask.localTaskId}`
          : 'no-runtime-task'}
      </span>
      <ol data-testid="runtime-open-messages">
        {workbench.messages.map(message => (
          <li key={message.id}>{message.content}</li>
        ))}
      </ol>
      <ol data-testid="runtime-open-blocks">
        {workbench.messages.flatMap(message =>
          (message.blocks ?? []).map(block => (
            <li key={`${message.id}-${block.id}`}>
              {block.type}:{block.content ?? block.toolName ?? ''}:{block.status ?? ''}
            </li>
          ))
        )}
      </ol>
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
    </div>
  )
}

function LegacyTaskProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-task-title">
        {workbench.state.currentTask?.title ?? 'no-task'}
      </span>
      <span data-testid="message-count">{workbench.messages.length}</span>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open task
      </button>
    </div>
  )
}

function TaskMessagesProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="message-contents">
        {workbench.messages
          .map(message => `${message.role}:${message.status}:${message.content}`)
          .join('|')}
      </span>
      <span data-testid="message-errors">
        {workbench.messages
          .map(
            message =>
              `${message.role}:${message.status}:${message.error ?? ''}:${message.errorType ?? ''}`
          )
          .join('|')}
      </span>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open task
      </button>
    </div>
  )
}

function TaskForkProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-task-id">{workbench.state.currentTask?.id ?? 'no-task'}</span>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open source task
      </button>
      <button
        type="button"
        onClick={() => void workbench.forkCurrentTask({ target: { type: 'managed' } })}
      >
        fork to cloud
      </button>
    </div>
  )
}

function DeviceListProbe() {
  const workbench = useWorkbench()

  return (
    <div data-testid="device-list">
      {workbench.state.devices.map(device => device.name).join(',')}
    </div>
  )
}

function ProjectSelectionProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-project-name">
        {workbench.state.currentProject?.name ?? 'no-project'}
      </span>
      <span data-testid="standalone-device-id">
        {workbench.state.standaloneDeviceId ?? 'no-device'}
      </span>
      <button type="button" onClick={() => workbench.startNewChat()}>
        new chat
      </button>
      <button type="button" onClick={() => workbench.startStandaloneChat()}>
        standalone chat
      </button>
      <button type="button" onClick={() => workbench.selectStandaloneDevice('local-online')}>
        select local standalone device
      </button>
    </div>
  )
}

function TaskSelectionProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-project-name">
        {workbench.state.currentProject?.name ?? 'no-project'}
      </span>
      <span data-testid="standalone-device-id">
        {workbench.state.standaloneDeviceId ?? 'no-device'}
      </span>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open standalone task
      </button>
    </div>
  )
}

function GuidanceRaceProbe({ startStream }: { startStream: () => void }) {
  const workbench = useWorkbench()

  return (
    <div>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open task
      </button>
      <button type="button" onClick={startStream}>
        start stream
      </button>
      <button type="button" onClick={() => workbench.setInput('第一条引导')}>
        set first guidance
      </button>
      <button type="button" onClick={() => workbench.setInput('第二条引导')}>
        set second guidance
      </button>
      <button type="button" onClick={() => workbench.setInput('第三条引导')}>
        set third guidance
      </button>
      <button type="button" onClick={() => void workbench.sendCurrentInput()}>
        send
      </button>
      <div data-testid="queued-states">
        {workbench.queuedMessages
          .map(message => `${message.content}:${message.status}:${message.error ?? ''}`)
          .join('|')}
      </div>
      {workbench.queuedMessages.map((message, index) => (
        <button
          key={message.id}
          type="button"
          data-testid={`guide-queued-${index}`}
          onClick={() => void workbench.sendQueuedAsGuidance(message.id)}
        >
          guide {index}
        </button>
      ))}
    </div>
  )
}

function ProjectCreationProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="standalone-device-id">
        {workbench.state.standaloneDeviceId ?? 'no-device'}
      </span>
      <button
        type="button"
        onClick={() =>
          void workbench.createProject({
            name: 'alpha',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'project-device',
              },
              workspace: {
                source: 'local_path',
                localPath: '/workspace/projects/alpha',
              },
            },
          })
        }
      >
        create project
      </button>
    </div>
  )
}

function ImSessionProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void workbench.listImPrivateSessions()
        }}
      >
        list IM sessions
      </button>
      <button
        type="button"
        onClick={() => {
          void workbench.bindRuntimeTaskToImSessions(
            {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              localTaskId: 'runtime-1',
            },
            ['session-7', 'session-9']
          )
        }}
      >
        bind IM sessions
      </button>
    </div>
  )
}

describe('WorkbenchProvider', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    localStorage.clear()
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
  })

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
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  displayName: 'GPT 5.5 Medium',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
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

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('alice'))
  })

  test('loads runtime work during bootstrap without a DB recent task API', async () => {
    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          runtimeWorkApi: createRuntimeWorkApiMock({
            listRuntimeWork: vi.fn().mockResolvedValue({
              projects: [],
              unmappedDeviceWorkspaces: [],
              totalLocalTasks: 0,
            }),
          }),
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

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('alice'))
  })

  test('creates a runtime local task for a new project message', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const createRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      localTaskId: 'runtime-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [{ name: 'claude-sonnet', type: 'user', displayName: 'Claude Sonnet' }],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Alpha',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: { targetType: 'local', deviceId: 'device-1' },
                    workspace: { source: 'local_path', localPath: '/workspace/project-alpha' },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Local Mac',
                status: 'online',
                is_default: true,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          runtimeWorkApi: createRuntimeWorkApiMock({
            createRuntimeTask,
          }),
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          teamId: 2,
          runtime: 'claude_code',
          message: 'build it',
          title: 'build it',
          modelId: 'claude-sonnet',
          modelType: 'user',
          modelOptions: {},
          additionalSkills: [],
          attachmentIds: [],
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('exposes IM private session APIs through context', async () => {
    const listPrivateSessions = vi.fn().mockResolvedValue({ total: 0, items: [] })
    const bindRuntimeTaskImSessions = vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-1',
      },
      boundSessionKeys: ['session-7', 'session-9'],
      notifiedCount: 2,
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({ data: [] }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          imSessionApi: {
            listPrivateSessions,
          },
          runtimeWorkApi: createRuntimeWorkApiMock({ bindRuntimeTaskImSessions }),
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ImSessionProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(screen.getByText('list IM sessions'))
    await userEvent.click(screen.getByText('bind IM sessions'))

    expect(listPrivateSessions).toHaveBeenCalledWith()
    expect(bindRuntimeTaskImSessions).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-1',
      },
      sessionKeys: ['session-7', 'session-9'],
    })
  })

  test('continues runtime local task streaming after reopening a running task', async () => {
    let handlers: ChatStreamHandlers = {}
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          {
            id: 'runtime-a:assistant:9001',
            role: 'assistant',
            content: '已经输出',
            status: 'streaming',
            subtaskId: 9001,
            createdAt: '2026-06-21T12:00:00.000Z',
          },
        ],
      }),
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={createWorkbenchServices({
          runtimeWorkApi,
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(nextHandlers => {
              handlers = nextHandlers
              return vi.fn()
            }),
          },
        })}
      >
        <RuntimeOpenProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:/workspace/project-alpha:runtime-a'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('已经输出')

    act(() => {
      handlers.onChatChunk?.({
        subtask_id: 9001,
        content: '继续流式',
        offset: 12,
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('已经输出继续流式')

    act(() => {
      handlers.onChatDone?.({
        subtask_id: 9001,
        offset: 24,
        result: { value: '最终正确内容' },
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('最终正确内容')
  })

  test('does not automatically upgrade old online devices during bootstrap', async () => {
    const upgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({ data: [] }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
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
            ]),
            upgradeDevice,
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <DeviceListProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByTestId('device-list')).toHaveTextContent('Old Device'))
    expect(upgradeDevice).not.toHaveBeenCalled()
  })

  test('opens task from the browser path after bootstrap', async () => {
    window.history.pushState({}, '', '/tasks/8')
    const getTaskDetail = vi.fn().mockResolvedValue({
      id: 8,
      title: 'Restored task',
      status: 'COMPLETED',
      task_type: 'code',
      project_id: 0,
      device_id: 'local-online',
      created_at: '2026-06-04T00:00:00.000Z',
      updated_at: '2026-06-04T00:01:00.000Z',
      subtasks: [],
    })
    const joinTask = vi.fn()

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail,
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'local-online',
                name: 'Local Device',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask,
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            sendGuidance: vi.fn(),
            cancelStream: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
            connect: vi.fn(),
          },
        }}
      >
        <LegacyTaskProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(getTaskDetail).toHaveBeenCalledWith(8))
    expect(await screen.findByTestId('current-task-title')).toHaveTextContent('Restored task')
    expect(joinTask).toHaveBeenCalledWith(8)
  })

  test('forks current task and opens the fork without starting execution', async () => {
    const forkTask = vi.fn().mockResolvedValue({
      task_id: 86,
      task: {
        id: 86,
        title: 'Forked task',
        status: 'PENDING',
        task_type: 'code',
        project_id: 0,
        created_at: '2026-06-04T00:02:00.000Z',
        subtasks: [],
      },
    })
    const getTaskDetail = vi.fn(async (taskId: number) => ({
      id: taskId,
      title: taskId === 86 ? 'Forked task' : 'Source task',
      status: taskId === 86 ? 'PENDING' : 'COMPLETED',
      task_type: 'code',
      project_id: 0,
      created_at: '2026-06-04T00:00:00.000Z',
      subtasks: [],
    }))
    const joinTask = vi.fn()
    const sendMessage = vi.fn()

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail,
            forkTask,
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask,
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <TaskForkProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open source task'))
    await waitFor(() => expect(screen.getByTestId('current-task-id')).toHaveTextContent('8'))

    await userEvent.click(screen.getByText('fork to cloud'))

    await waitFor(() => expect(screen.getByTestId('current-task-id')).toHaveTextContent('86'))
    expect(forkTask).toHaveBeenCalledWith(8, { target: { type: 'managed' } })
    expect(getTaskDetail).toHaveBeenCalledWith(86)
    expect(joinTask).toHaveBeenCalledWith(86)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('restores cached streaming content when opening a running task after refresh', async () => {
    const getTaskDetail = vi.fn().mockResolvedValue({
      id: 8,
      title: 'Running task',
      status: 'RUNNING',
      task_type: 'code',
      project_id: 0,
      device_id: 'local-online',
      created_at: '2026-06-04T00:00:00.000Z',
      updated_at: '2026-06-04T00:01:00.000Z',
      subtasks: [
        {
          id: 20,
          task_id: 8,
          role: 'user',
          prompt: '写个故事',
          status: 'COMPLETED',
          created_at: '2026-06-04T00:00:00.000Z',
        },
        {
          id: 21,
          task_id: 8,
          role: 'assistant',
          result: { value: '' },
          status: 'RUNNING',
          created_at: '2026-06-04T00:00:01.000Z',
        },
      ],
    })
    const joinTask = vi.fn().mockResolvedValue({
      streaming: {
        subtask_id: 21,
        offset: 9,
        cached_content: '已经输出的内容',
      },
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail,
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'local-online',
                name: 'Local Device',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask,
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            sendGuidance: vi.fn(),
            cancelStream: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <TaskMessagesProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))

    await waitFor(() => expect(joinTask).toHaveBeenCalledWith(8))
    expect(screen.getByTestId('message-contents')).toHaveTextContent(
      'assistant:streaming:已经输出的内容'
    )
  })

  test('restores persisted failure with specific result error before generic task status error', async () => {
    const specificError = 'Codex CLI failed to resume thread: session not found'
    const getTaskDetail = vi.fn().mockResolvedValue({
      id: 8,
      title: 'Failed task',
      status: 'FAILED',
      task_type: 'code',
      project_id: 0,
      device_id: 'local-online',
      created_at: '2026-06-04T00:00:00.000Z',
      updated_at: '2026-06-04T00:01:00.000Z',
      subtasks: [
        {
          id: 21,
          task_id: 8,
          role: 'assistant',
          result: {
            value: '',
            error: specificError,
            error_type: 'execution_error',
          },
          error_message: 'Task failed with status: FAILED',
          status: 'FAILED',
          created_at: '2026-06-04T00:00:01.000Z',
        },
      ],
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail,
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'local-online',
                name: 'Local Device',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            sendGuidance: vi.fn(),
            cancelStream: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <TaskMessagesProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))

    await waitFor(() =>
      expect(screen.getByTestId('message-errors')).toHaveTextContent(
        `assistant:failed:${specificError}:execution_error`
      )
    )
    expect(screen.getByTestId('message-errors')).not.toHaveTextContent(
      'Task failed with status: FAILED'
    )
  })

  test('ignores stale cached streaming when opening a cancelled task', async () => {
    const getTaskDetail = vi.fn().mockResolvedValue({
      id: 8,
      title: 'Cancelled task',
      status: 'CANCELLED',
      task_type: 'code',
      project_id: 0,
      device_id: 'local-online',
      created_at: '2026-06-04T00:00:00.000Z',
      updated_at: '2026-06-04T00:01:00.000Z',
      subtasks: [
        {
          id: 20,
          task_id: 8,
          role: 'user',
          prompt: '写个故事',
          status: 'COMPLETED',
          created_at: '2026-06-04T00:00:00.000Z',
        },
        {
          id: 21,
          task_id: 8,
          role: 'assistant',
          result: { value: '' },
          status: 'CANCELLED',
          created_at: '2026-06-04T00:00:01.000Z',
        },
      ],
    })
    const joinTask = vi.fn().mockResolvedValue({
      streaming: {
        subtask_id: 21,
        offset: 9,
        cached_content: '旧的缓存内容',
      },
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail,
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'local-online',
                name: 'Local Device',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask,
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            sendGuidance: vi.fn(),
            cancelStream: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <TaskMessagesProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))

    await waitFor(() => expect(joinTask).toHaveBeenCalledWith(8))
    expect(screen.getByTestId('message-contents')).toHaveTextContent('assistant:done:')
    expect(screen.getByTestId('message-contents')).not.toHaveTextContent('assistant:streaming')
  })

  test('uses the opened task model as the runtime compatibility anchor', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'wecode-claude-opus-4',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'gpt-5.5-medium',
        type: 'user',
        runtime: { family: 'openai.openai-responses' },
      },
    ]

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: models }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'SUCCESS',
              task_type: 'code',
              project_id: 0,
              model_id: 'wecode-claude-sonnet-4-5',
              force_override_bot_model_type: 'public',
              created_at: '2026-06-04T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ModelCompatibilityProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('model-compatibility-status')).toHaveTextContent(
        'gpt-5.5-medium:enabled'
      )
    )

    await userEvent.click(screen.getByText('open task'))

    await waitFor(() =>
      expect(screen.getByTestId('model-compatibility-status')).toHaveTextContent(
        'gpt-5.5-medium:runtime_family_mismatch'
      )
    )
    expect(screen.getByTestId('model-compatibility-status')).toHaveTextContent(
      'wecode-claude-opus-4:enabled'
    )
  })

  test('refreshes devices when a device comes online after bootstrap', async () => {
    let handlers: Record<string, (payload: unknown) => void> = {}
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 1,
          device_id: 'linux-device',
          name: 'Linux-Device-0b18648b2e82',
          status: 'offline',
          is_default: false,
          device_type: 'local',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1,
          device_id: 'linux-device',
          name: 'Linux-Device-0b18648b2e82',
          status: 'offline',
          is_default: false,
          device_type: 'local',
        },
        {
          id: 2,
          device_id: 'c78d176b-3f32-4598-9758-cb8262d8f25a',
          name: 'macOS-Device-cb8262d8f25a',
          status: 'online',
          is_default: false,
          device_type: 'local',
        },
      ])

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices,
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(nextHandlers => {
              handlers = nextHandlers as Record<string, (payload: unknown) => void>
              return vi.fn()
            }),
          },
        }}
      >
        <DeviceListProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('device-list')).toHaveTextContent('Linux-Device-0b18648b2e82')
    )

    handlers.onDeviceOnline?.({
      device_id: 'c78d176b-3f32-4598-9758-cb8262d8f25a',
      name: 'macOS-Device-cb8262d8f25a',
      status: 'online',
    })

    await waitFor(() =>
      expect(screen.getByTestId('device-list')).toHaveTextContent('macOS-Device-cb8262d8f25a')
    )
    expect(listDevices).toHaveBeenCalledTimes(2)
  })

  test('starts new chat as standalone project zero even with a remembered project', async () => {
    localStorage.setItem('wework.lastProjectId.1', '7')

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  displayName: 'GPT 5.5 Medium',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-2',
                name: 'Docs Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectSelectionProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )

    await userEvent.click(screen.getByText('standalone chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('no-project')
    expect(window.location.pathname + window.location.search).toBe('/?projectId=0')

    await userEvent.click(screen.getByText('new chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('no-project')
    expect(window.location.pathname + window.location.search).toBe('/?projectId=0')
  })

  test('restores the remembered standalone device when entering chat mode', async () => {
    localStorage.setItem('wework.lastProjectId.1', '7')
    const updateCurrentUser = vi.fn().mockResolvedValue({
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: { default_execution_target: 'local-online' },
    })

    render(
      <WorkbenchProvider
        user={{
          id: 1,
          user_name: 'alice',
          email: 'a@b.c',
          preferences: { send_key: 'cmd_enter', default_execution_target: 'local-online' },
        }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  displayName: 'GPT 5.5 Medium',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'cloud-online',
                name: 'Cloud Online',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
              {
                id: 2,
                device_id: 'local-online',
                name: 'Local Online',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: {
            updateCurrentUser,
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectSelectionProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('local-online')

    await userEvent.click(screen.getByText('standalone chat'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('no-project')
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('local-online')

    await userEvent.click(screen.getByText('select local standalone device'))
    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenCalledWith({
        preferences: {
          send_key: 'cmd_enter',
          default_execution_target: 'local-online',
        },
      })
    )
  })

  test('opens standalone task history with the task device selected', async () => {
    localStorage.setItem('wework.lastProjectId.1', '7')
    const joinTask = vi.fn()

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  displayName: 'GPT 5.5 Medium',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'hello-1',
              status: 'SUCCESS',
              task_type: 'code',
              project_id: 0,
              device_id: 'local-online',
              created_at: '2026-05-29T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'cloud-online',
                name: 'Cloud Online',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
              {
                id: 2,
                device_id: 'local-online',
                name: 'Local Online',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask,
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <TaskSelectionProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('cloud-online')

    await userEvent.click(screen.getByText('open standalone task'))

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('no-project')
    )
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('local-online')
    expect(joinTask).toHaveBeenCalledWith(8)
    expect(window.location.pathname).toBe('/projects/0/tasks/8')
    expect(window.location.search).toBe('')
  })

  test('restores an opened task from the taskId URL parameter after refresh', async () => {
    window.history.pushState({}, '', '/?taskId=8')
    const getTaskDetail = vi.fn().mockResolvedValue({
      id: 8,
      title: 'restored chat',
      status: 'SUCCESS',
      task_type: 'code',
      project_id: 0,
      device_id: 'local-online',
      created_at: '2026-05-29T00:00:00.000Z',
      subtasks: [],
    })
    const joinTask = vi.fn()

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  displayName: 'GPT 5.5 Medium',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [{ id: 7, name: 'Wegent', tasks: [] }],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail,
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 2,
                device_id: 'local-online',
                name: 'Local Online',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask,
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <LegacyTaskProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('current-task-title')).toHaveTextContent('restored chat')
    )
    expect(getTaskDetail).toHaveBeenCalledWith(8)
    expect(joinTask).toHaveBeenCalledWith(8)
    expect(window.location.pathname).toBe('/projects/0/tasks/8')
    expect(window.location.search).toBe('')
  })

  test('persists the project creation device as the default execution target', async () => {
    const updateCurrentUser = vi.fn().mockResolvedValue({
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: { default_execution_target: 'project-device' },
    })
    const createProject = vi.fn().mockResolvedValue({
      id: 9,
      name: 'alpha',
      tasks: [],
      config: {
        execution: {
          targetType: 'local',
          deviceId: 'project-device',
        },
      },
    })

    render(
      <WorkbenchProvider
        user={{
          id: 1,
          user_name: 'alice',
          email: 'a@b.c',
          preferences: { send_key: 'cmd_enter' },
        }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject,
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'project-device',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: {
            updateCurrentUser,
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectCreationProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('create project'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenCalledWith({
        preferences: {
          send_key: 'cmd_enter',
          default_execution_target: 'project-device',
        },
      })
    )
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('project-device')
  })

  test('sends project chat options for a new project conversation', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          {
            id: 'runtime-1:user:1',
            role: 'user',
            content: 'build it',
            createdAt: '2026-06-20T00:00:00.000Z',
            attachments: [
              {
                id: 42,
                filename: 'brief.pdf',
                file_size: 1200,
                mime_type: 'application/pdf',
                status: 'ready',
                file_extension: '.pdf',
                created_at: '2026-05-27T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    })
    const updateCurrentUser = vi.fn().mockResolvedValue({
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: {
        wework_new_chat_model_selection: {
          modelName: 'gpt-5.5-medium',
          modelType: 'user',
          options: { reasoning: 'high' },
        },
      },
    })
    const updateProject = vi.fn().mockResolvedValue({
      id: 7,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local',
          deviceId: 'device-1',
        },
        modelSelection: {
          modelName: 'gpt-5.5-medium',
          modelType: 'user',
          options: { reasoning: 'high' },
        },
      },
    })
    const listProjects = vi.fn().mockResolvedValue({
      items: [
        {
          id: 7,
          name: 'Wegent',
          tasks: [],
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'device-1',
            },
          },
        },
      ],
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  displayName: 'GPT 5.5 Medium',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects,
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject,
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: {
            updateCurrentUser,
          },
          runtimeWorkApi,
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('select model'))
    await userEvent.click(screen.getByText('select skill'))
    await userEvent.click(screen.getByText('add attachment'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 2,
          projectId: 7,
          runtime: 'claude_code',
          message: 'build it',
          title: 'build it',
          modelId: 'gpt-5.5-medium',
          modelType: 'user',
          modelOptions: {
            reasoning: 'high',
          },
          attachmentIds: [42],
          additionalSkills: [
            {
              name: 'project-summary',
              namespace: 'default',
              is_public: false,
            },
          ],
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('message-attachment-filenames')).toHaveTextContent('brief.pdf')
    expect(updateCurrentUser).toHaveBeenCalledWith({
      preferences: {
        wework_new_chat_model_selection: {
          modelName: 'gpt-5.5-medium',
          modelType: 'user',
          options: {
            reasoning: 'high',
          },
        },
      },
    })
    expect(updateProject).not.toHaveBeenCalled()
    expect(listProjects).toHaveBeenCalledTimes(2)
  })

  test('sends runtime GPT model selection for a new project conversation', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        localTaskId: 'runtime-codex-1',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-codex-1',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })
    const updateCurrentUser = vi.fn().mockResolvedValue(undefined)

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'codex-gpt-5.5',
                  type: 'runtime',
                  displayName: 'GPT-5.5 (Codex)',
                  provider: 'openai',
                  modelId: 'gpt-5.5',
                  config: {
                    protocol: 'openai-responses',
                    apiFormat: 'responses',
                  },
                  runtime: {
                    family: 'openai.openai-responses',
                    provider: 'openai',
                  },
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: {
            updateCurrentUser,
          },
          runtimeWorkApi,
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('select runtime model'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 2,
          projectId: 7,
          runtime: 'codex',
          message: 'build it',
          modelId: 'codex-gpt-5.5',
          modelType: 'runtime',
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(updateCurrentUser).toHaveBeenCalledWith({
      preferences: {
        wework_new_chat_model_selection: {
          modelName: 'codex-gpt-5.5',
          modelType: 'runtime',
          options: {
            reasoning: 'high',
          },
        },
      },
    })
  })

  test('resolves automatic model selection when sending a new project conversation', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const runtimeWorkApi = createRuntimeWorkApiMock()

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'wegent-wework', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'kimi',
                  type: 'public',
                  displayName: 'Kimi',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 2,
          projectId: 7,
          runtime: 'claude_code',
          message: 'build it',
          modelId: 'kimi',
          modelType: 'public',
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('surfaces a missing wework default team during bootstrap', async () => {
    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockRejectedValue(new Error('Wework default team is not configured')),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({ data: [] }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('workbench-error')).toHaveTextContent(
        'Wework default team is not configured'
      )
    )
  })

  test('sends pending code comments as formatted message context', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          {
            id: 'runtime-1:user:1',
            role: 'user',
            content: 'please inspect',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ],
      }),
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Local Device',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <CodeCommentSendProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('add code comment'))
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('1')

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const payload = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(payload).toEqual(
      expect.objectContaining({
        teamId: 2,
        projectId: 7,
        runtime: 'claude_code',
      })
    )
    expect(payload.message).toContain('please inspect')
    expect(payload.message).toContain('<code_comment_context>')
    expect(payload.message).toContain('"filePath": "src/app.ts"')
    expect(payload.message).toContain('"lines": "12-14"')
    expect(payload.message).toContain('"selectedCode": "const answer = computeAnswer()"')
    expect(payload.message).toContain('"userComment": "Check whether this handles retries."')
    expect(screen.getByTestId('message-contents')).toHaveTextContent('please inspect')
    expect(screen.getByTestId('message-contents')).not.toHaveTextContent('<code_comment_context>')
    await waitFor(() =>
      expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('0')
    )
  })

  test('blocks sending when the active project device is offline', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'offline-device',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'offline-device',
                name: 'Offline Device',
                status: 'offline',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: { updateCurrentUser: vi.fn() },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('workbench-input')).toHaveTextContent('build it')
    expect(screen.getByTestId('workbench-error')).toHaveTextContent(
      'Offline Device 离线，恢复在线后可继续对话'
    )
  })

  test('blocks project task sending when the owning project device is missing', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 71 })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [
                    {
                      id: 71,
                      task_id: 71,
                      task_title: 'Continue project work',
                      updated_at: '2026-05-27T00:00:00.000Z',
                    },
                  ],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'missing-device',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 71,
              title: 'Continue project work',
              status: 'SUCCESS',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'standalone-online',
                name: 'Standalone Online',
                status: 'online',
                is_default: true,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: { updateCurrentUser: vi.fn() },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ProjectTaskSendProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByTestId('project-count')).toHaveTextContent('1'))

    await userEvent.click(screen.getByText('open project task'))
    await waitFor(() => expect(screen.getByTestId('current-task-id')).toHaveTextContent('71'))

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('workbench-input')).toHaveTextContent('continue')
    expect(screen.getByTestId('workbench-error')).toHaveTextContent(
      'missing-device 不可用，恢复在线后可继续对话'
    )
  })

  test('sends git worktree execution intent for existing local workspace conversations', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const runtimeWorkApi = createRuntimeWorkApiMock()
    const updateCurrentUser = vi.fn().mockResolvedValue({
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: { wework_project_execution_mode: 'git_worktree' },
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
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
                      localPath: '/workspace/projects/Wegent',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
          userApi: { updateCurrentUser },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('select worktree'))
    await userEvent.click(screen.getByText('select develop source branch'))

    expect(screen.getByTestId('project-worktree-base-branch')).toHaveTextContent('develop')

    expect(updateCurrentUser).toHaveBeenCalledWith({
      preferences: {
        wework_project_execution_mode: 'git_worktree',
      },
    })

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          execution: {
            workspace: {
              source: 'git_worktree',
              branch: 'develop',
            },
          },
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('uses the remembered project execution mode for new project conversations', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
    const runtimeWorkApi = createRuntimeWorkApiMock()

    render(
      <WorkbenchProvider
        user={{
          id: 1,
          user_name: 'alice',
          email: 'a@b.c',
          preferences: { wework_project_execution_mode: 'git_worktree' },
        }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
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
                      localPath: '/workspace/projects/Wegent',
                    },
                  },
                },
                {
                  id: 8,
                  name: 'Docs',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-2',
                    },
                    workspace: {
                      source: 'local_path',
                      localPath: '/workspace/projects/Docs',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-2',
                name: 'Docs Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('start project 8 chat'))

    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 8,
          execution: {
            workspace: {
              source: 'git_worktree',
            },
          },
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('sends standalone chats to the preferred online cloud device', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 100 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [],
        unmappedDeviceWorkspaces: [
          {
            id: null,
            projectId: null,
            deviceId: 'cloud-online',
            deviceName: 'Cloud Online',
            deviceStatus: 'online',
            workspacePath: '/workspace/cloud',
            mapped: false,
            available: true,
            localTasks: [],
          },
        ],
        totalLocalTasks: 0,
      }),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'cloud-online',
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/default',
        runtime: 'claude_code',
      }),
    })

    function StandaloneDeviceProbe() {
      const workbench = useWorkbench()

      return (
        <div>
          <span data-testid="standalone-device-id">
            {workbench.state.standaloneDeviceId ?? 'no-device'}
          </span>
          <button type="button" onClick={() => workbench.setInput('run pwd')}>
            set input
          </button>
          <button type="button" onClick={() => void workbench.sendCurrentInput()}>
            send
          </button>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'local-online',
                name: 'Local Online',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
              {
                id: 2,
                device_id: 'cloud-online',
                name: 'Cloud Online',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <StandaloneDeviceProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('cloud-online')
    )

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 2,
          deviceId: 'cloud-online',
          workspacePath: '/workspace/cloud',
          runtime: 'claude_code',
          message: 'run pwd',
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'cloud-online',
      localTaskId: 'runtime-1',
    })
    expect(window.location.search).not.toContain('workspacePath')
    expect(window.location.search).not.toContain('%2Fworkspace')
  })

  test('restores a runtime local task from the runtime task URL after refresh', async () => {
    window.history.pushState(
      {},
      '',
      '/runtime-tasks?deviceId=device-1&localTaskId=runtime-restored'
    )
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      localTaskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [{ id: 'runtime-restored:user:1', role: 'user', content: 'restored message' }],
    })
    const listRuntimeWork = vi.fn().mockResolvedValue({
      projects: [
        {
          project: {
            id: 11,
            name: 'Project Alpha',
          },
          deviceWorkspaces: [
            {
              id: 22,
              deviceId: 'device-1',
              deviceName: 'Alice Mac',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              localTasks: [
                {
                  localTaskId: 'runtime-restored',
                  workspacePath: '/workspace/project-alpha',
                  title: 'restored task',
                  runtime: 'claude_code',
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        },
      ],
      unmappedDeviceWorkspaces: [],
      totalLocalTasks: 1,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({ getRuntimeTranscript, listRuntimeWork }),
    })

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <RuntimeOpenProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:/workspace/project-alpha:runtime-restored'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('restored message')
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      localTaskId: 'runtime-restored',
    })
  })

  test('uses the device id returned by runtime task creation for project task address', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'resolved-device',
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices()
    services.projectApi.listProjects = vi.fn().mockResolvedValue({
      items: [
        {
          id: 7,
          name: 'Wegent',
          tasks: [],
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'configured-device',
            },
          },
        },
      ],
    })
    services.deviceApi.listDevices = vi.fn().mockResolvedValue([
      {
        id: 1,
        device_id: 'configured-device',
        name: 'Configured Device',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
        executor_version: '1.8.5',
      },
    ])
    services.runtimeWorkApi = runtimeWorkApi

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'resolved-device:/workspace/project-alpha:runtime-1'
      )
    )
    expect(runtimeWorkApi.getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'resolved-device',
      workspacePath: '/workspace/project-alpha',
      localTaskId: 'runtime-1',
    })
  })

  test('blocks standalone runtime sends when the selected device has multiple workspaces', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [],
        unmappedDeviceWorkspaces: [
          {
            id: null,
            projectId: null,
            deviceId: 'cloud-online',
            deviceName: 'Cloud Online',
            deviceStatus: 'online',
            workspacePath: '/workspace/one',
            mapped: false,
            available: true,
            localTasks: [],
          },
          {
            id: null,
            projectId: null,
            deviceId: 'cloud-online',
            deviceName: 'Cloud Online',
            deviceStatus: 'online',
            workspacePath: '/workspace/two',
            mapped: false,
            available: true,
            localTasks: [],
          },
        ],
        totalLocalTasks: 0,
      }),
      createRuntimeTask: vi.fn(),
    })
    const services = createWorkbenchServices()
    services.deviceApi.listDevices = vi.fn().mockResolvedValue([
      {
        id: 1,
        device_id: 'cloud-online',
        name: 'Cloud Online',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
        executor_version: '1.8.5',
      },
    ])
    services.runtimeWorkApi = runtimeWorkApi

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <StandaloneRuntimeSendProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('cloud-online')
    )
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    expect(runtimeWorkApi.createRuntimeTask).not.toHaveBeenCalled()
    expect(screen.getByTestId('workbench-error')).toHaveTextContent(
      '请选择项目或打开设备工作区后再发送'
    )
  })

  test('preserves the last runtime work snapshot when a foreground refresh fails', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce({
          projects: [],
          unmappedDeviceWorkspaces: [
            {
              id: null,
              projectId: null,
              deviceId: 'device-1',
              deviceName: 'Local Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/local',
              mapped: false,
              available: true,
              localTasks: [
                {
                  localTaskId: 'runtime-1',
                  workspacePath: '/workspace/local',
                  title: 'Existing runtime task',
                  runtime: 'claude_code',
                },
              ],
            },
          ],
          totalLocalTasks: 1,
        })
        .mockRejectedValueOnce(new Error('device offline')),
    })
    const services = createWorkbenchServices({ runtimeWorkApi })

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <RuntimeRefreshProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByTestId('runtime-total')).toHaveTextContent('1'))
    await userEvent.click(screen.getByText('refresh runtime work'))

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('runtime-total')).toHaveTextContent('1')
  })

  test('ignores stale runtime transcript responses after opening another local task', async () => {
    const firstTranscript = deferred<{
      localTaskId: string
      workspacePath: string
      runtime: 'claude_code'
      messages: { id: string; role: 'user'; content: string }[]
    }>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                projectId: 7,
                deviceId: 'device-1',
                deviceName: 'Local Device',
                deviceStatus: 'online',
                workspacePath: '/workspace/project-alpha',
                mapped: true,
                available: true,
                localTasks: [],
              },
            ],
          },
        ],
        unmappedDeviceWorkspaces: [],
        totalLocalTasks: 0,
      }),
      getRuntimeTranscript: vi.fn(address => {
        if (address.localTaskId === 'runtime-a') return firstTranscript.promise
        return Promise.resolve({
          localTaskId: 'runtime-b',
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
          messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
        })
      }),
    })
    const services = createWorkbenchServices()
    services.projectApi.listProjects = vi.fn().mockResolvedValue({
      items: [{ id: 7, name: 'Wegent', tasks: [] }],
    })
    services.runtimeWorkApi = runtimeWorkApi

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <RuntimeOpenProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('open runtime a')).toBeInTheDocument())
    await userEvent.click(screen.getByText('open runtime a'))
    await userEvent.click(screen.getByText('open runtime b'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:/workspace/project-alpha:runtime-b'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')

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
      'device-1:/workspace/project-alpha:runtime-b'
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('message a')
  })

  test('reuses runtime local task address for follow-up messages', async () => {
    const sendMessage = vi.fn()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        localTaskId: 'runtime-99',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      sendRuntimeMessage: vi.fn().mockResolvedValue({
        accepted: true,
        localTaskId: 'runtime-99',
      }),
    })

    function FollowUpProbe() {
      const workbench = useWorkbench()
      return (
        <div>
          <span data-testid="current-runtime-task-id">
            {workbench.state.currentRuntimeTask?.localTaskId ?? 'no-runtime-task'}
          </span>
          <span data-testid="followup-project-count">{workbench.state.projects.length}</span>
          <button type="button" onClick={() => workbench.selectProject(7)}>
            select project
          </button>
          <button type="button" onClick={() => workbench.setInput('我叫胡云鹏')}>
            set first input
          </button>
          <button type="button" onClick={() => workbench.setInput('我叫什么')}>
            set second input
          </button>
          <button type="button" onClick={() => void workbench.sendCurrentInput()}>
            send
          </button>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({
              items: [
                {
                  id: 7,
                  name: 'Wegent',
                  tasks: [],
                  config: {
                    mode: 'workspace',
                    execution: {
                      targetType: 'local',
                      deviceId: 'device-1',
                    },
                  },
                },
              ],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Project Device',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <FollowUpProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByTestId('followup-project-count')).toHaveTextContent('1'))
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set first input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-id')).toHaveTextContent('runtime-99')
    )

    await userEvent.click(screen.getByText('set second input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          localTaskId: 'runtime-99',
        },
        message: '我叫什么',
      })
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('keeps an optimistic runtime follow-up visible until transcript catches up', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [],
        unmappedDeviceWorkspaces: [],
        totalLocalTasks: 1,
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          {
            id: 'runtime-a:user:1',
            role: 'user',
            content: 'first message',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ],
      }),
      sendRuntimeMessage: vi.fn().mockResolvedValue({
        accepted: true,
        localTaskId: 'runtime-a',
      }),
    })

    function FollowUpControls() {
      const workbench = useWorkbench()
      return (
        <>
          <button type="button" onClick={() => workbench.setInput('second message')}>
            set follow-up input
          </button>
          <button type="button" onClick={() => void workbench.sendCurrentInput()}>
            send follow-up
          </button>
        </>
      )
    }

    const services = createWorkbenchServices({
      runtimeWorkApi,
      deviceApi: {
        ...createWorkbenchServices().deviceApi,
        listDevices: vi.fn().mockResolvedValue([
          {
            id: 1,
            device_id: 'device-1',
            name: 'Device',
            status: 'online',
            is_default: true,
            device_type: 'local',
            bind_shell: 'codex',
            executor_version: '1.8.5',
          },
        ]),
      },
    })

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <RuntimeOpenProbe />
        <FollowUpControls />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up input'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(runtimeWorkApi.sendRuntimeMessage).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('second message')
    )
  })

  test('renders local task assistant output from existing chat stream events', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={createWorkbenchServices({
          runtimeWorkApi,
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers
              return vi.fn()
            }),
          },
        })}
      >
        <RuntimeOpenProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:/workspace/project-alpha:runtime-a'
      )
    )

    await act(async () => {
      streamHandlers.onChatStart?.({
        subtask_id: 101,
        shell_type: 'Codex',
        device_id: 'device-1',
        local_task_id: 'other-runtime',
      })
      streamHandlers.onChatChunk?.({
        subtask_id: 101,
        content: 'ignored',
        offset: 0,
        device_id: 'device-1',
        local_task_id: 'other-runtime',
      })
      await Promise.resolve()
    })
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('ignored')

    await act(async () => {
      streamHandlers.onChatStart?.({
        subtask_id: 102,
        shell_type: 'Codex',
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
      streamHandlers.onChatChunk?.({
        subtask_id: 102,
        content: 'hello',
        offset: 0,
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
      streamHandlers.onChatChunk?.({
        subtask_id: 102,
        content: '',
        offset: 0,
        result: { reasoning_chunk: 'Reading files' },
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
      streamHandlers.onBlockCreated?.({
        subtask_id: 102,
        device_id: 'device-1',
        local_task_id: 'runtime-a',
        block: {
          id: 'call-1',
          type: 'tool',
          tool_name: 'shell',
          tool_input: { command: 'pwd' },
          status: 'pending',
        },
      })
      streamHandlers.onBlockUpdated?.({
        subtask_id: 102,
        device_id: 'device-1',
        local_task_id: 'runtime-a',
        block_id: 'call-1',
        status: 'done',
      })
      streamHandlers.onChatDone?.({
        subtask_id: 102,
        offset: 5,
        result: { value: 'hello world' },
        device_id: 'device-1',
        local_task_id: 'runtime-a',
      })
      await Promise.resolve()
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('hello world')
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'thinking:Reading files:done'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('tool:shell:done')
  })

  test('renders local task user messages from chat message events', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={createWorkbenchServices({
          runtimeWorkApi,
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers
              return vi.fn()
            }),
          },
        })}
      >
        <RuntimeOpenProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:/workspace/project-alpha:runtime-a'
      )
    )

    await act(async () => {
      streamHandlers.onChatMessage?.({
        subtask_id: 201,
        message_id: 301,
        role: 'user',
        content: 'ignored IM message',
        created_at: '2026-06-21T10:00:00.000Z',
        device_id: 'device-1',
        local_task_id: 'other-runtime',
      })
      await Promise.resolve()
    })
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('ignored IM message')

    await act(async () => {
      streamHandlers.onChatMessage?.({
        subtask_id: 202,
        message_id: 302,
        role: 'user',
        content: 'IM follow-up',
        created_at: '2026-06-21T10:01:00.000Z',
        device_id: 'device-1',
        local_task_id: 'runtime-a',
        source: {
          source: 'im',
          channel_type: 'telegram',
          channel_label: 'Telegram',
          sender_id: 'staff-a',
        },
      })
      await Promise.resolve()
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('IM follow-up')
  })

  test('keeps later guidance queued while one guidance send is in progress', async () => {
    let streamHandlers: {
      onChatStart?: (payload: { task_id: number; subtask_id: number; shell_type?: string }) => void
    } = {}
    let resolveCancel: ((value: { success: boolean }) => void) | undefined
    const cancelStream = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCancel = resolve
        })
    )
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 8 })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'RUNNING',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            cancelStream,
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers
              return vi.fn()
            }),
          },
        }}
      >
        <GuidanceRaceProbe
          startStream={() =>
            streamHandlers.onChatStart?.({
              task_id: 8,
              subtask_id: 101,
              shell_type: 'Chat',
            })
          }
        />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))
    await userEvent.click(screen.getByText('start stream'))
    await userEvent.click(screen.getByText('set first guidance'))
    await userEvent.click(screen.getByText('send'))
    await userEvent.click(screen.getByText('set second guidance'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(screen.getByTestId('queued-states')).toHaveTextContent(
        '第一条引导:queued:|第二条引导:queued:'
      )
    )

    await userEvent.click(screen.getByTestId('guide-queued-0'))
    await userEvent.click(screen.getByTestId('guide-queued-1'))

    expect(cancelStream).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('queued-states')).toHaveTextContent(
      '第一条引导:sending:|第二条引导:queued:'
    )

    resolveCancel?.({ success: true })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })

  test('does not drain remaining queued messages before the guided response starts', async () => {
    let streamHandlers: {
      onChatStart?: (payload: { task_id: number; subtask_id: number; shell_type?: string }) => void
    } = {}
    const cancelStream = vi.fn().mockResolvedValue({ success: true })
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 8 })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'RUNNING',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            cancelStream,
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers
              return vi.fn()
            }),
          },
        }}
      >
        <GuidanceRaceProbe
          startStream={() =>
            streamHandlers.onChatStart?.({
              task_id: 8,
              subtask_id: 101,
              shell_type: 'Chat',
            })
          }
        />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))
    await userEvent.click(screen.getByText('start stream'))
    await userEvent.click(screen.getByText('set first guidance'))
    await userEvent.click(screen.getByText('send'))
    await userEvent.click(screen.getByText('set second guidance'))
    await userEvent.click(screen.getByText('send'))
    await userEvent.click(screen.getByText('set third guidance'))
    await userEvent.click(screen.getByText('send'))
    await userEvent.click(screen.getByTestId('guide-queued-0'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('queued-states')).toHaveTextContent(
      '第二条引导:queued:|第三条引导:queued:'
    )
  })

  test('retries a failed assistant message using the previous user message', async () => {
    const sendMessage = vi.fn()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [],
        unmappedDeviceWorkspaces: [
          {
            id: null,
            projectId: null,
            deviceId: 'device-1',
            deviceName: 'Device',
            deviceStatus: 'online',
            workspacePath: '/workspace/default',
            mapped: false,
            available: true,
            localTasks: [],
          },
        ],
        totalLocalTasks: 0,
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-1',
        workspacePath: '/workspace/default',
        runtime: 'claude_code',
        messages: [
          {
            id: 'runtime-1:user:1',
            role: 'user',
            content: 'hi',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
          {
            id: 'runtime-1:assistant:1',
            role: 'assistant',
            content: '',
            createdAt: '2026-06-20T00:00:01.000Z',
            status: 'failed',
          },
        ],
      }),
    })

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'device-1',
                name: 'Device',
                status: 'online',
                is_default: true,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <RetryFailedMessageProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('set retry input'))
    await userEvent.click(screen.getByText('send retry input'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))

    await waitFor(() =>
      expect(screen.getByTestId('retry-message-states')).toHaveTextContent('assistant::failed')
    )

    await userEvent.click(screen.getByText('retry failed message'))

    await waitFor(() => expect(runtimeWorkApi.sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.sendRuntimeMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          localTaskId: 'runtime-1',
        },
        message: 'hi',
      })
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('opens task history in message order with normalized backend roles', async () => {
    function HistoryProbe() {
      const workbench = useWorkbench()
      return (
        <div>
          <button type="button" onClick={() => void workbench.openTask(8)}>
            open task
          </button>
          <ol data-testid="messages">
            {workbench.messages.map(message => (
              <li key={message.id}>
                {message.role}:{message.content}
              </li>
            ))}
          </ol>
          <span data-testid="history-attachment-filenames">
            {workbench.messages
              .flatMap(message =>
                (message.attachments ?? []).map(attachment => attachment.filename)
              )
              .join(',')}
          </span>
          <span data-testid="history-message-sources">
            {workbench.messages
              .map(
                message =>
                  `${message.role}:${message.source?.source ?? 'none'}:${
                    message.source?.session_id ?? 'none'
                  }`
              )
              .join('|')}
          </span>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [
                {
                  id: 12,
                  role: 'ASSISTANT',
                  message_id: 2,
                  prompt: '',
                  result: {
                    value: '你好，胡云鹏！',
                    source: {
                      source: 'im',
                      session_id: 'assistant-session',
                    },
                  },
                  status: 'COMPLETED',
                  created_at: '2026-05-27T00:02:00.000Z',
                },
                {
                  id: 11,
                  role: 'USER',
                  message_id: 1,
                  prompt: '我叫胡云鹏',
                  result: {
                    source: {
                      source: 'im',
                      session_id: 'session-1',
                      message_id: 'im-message-1',
                    },
                  },
                  status: 'COMPLETED',
                  contexts: [
                    {
                      id: 43,
                      context_type: 'attachment',
                      name: 'diagram.png',
                      status: 'ready',
                      file_extension: '.png',
                      file_size: 1024,
                      mime_type: 'image/png',
                    },
                  ],
                  created_at: '2026-05-27T00:01:00.000Z',
                },
                {
                  id: 13,
                  role: 'USER',
                  message_id: 3,
                  prompt: 'from unsupported source',
                  result: {
                    source: {
                      source: 'web',
                      session_id: 'web-session',
                    },
                  },
                  status: 'COMPLETED',
                  created_at: '2026-05-27T00:03:00.000Z',
                },
              ],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <HistoryProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))

    await waitFor(() =>
      expect(screen.getByTestId('messages')).toHaveTextContent(
        'user:我叫胡云鹏assistant:你好，胡云鹏！user:from unsupported source'
      )
    )
    expect(screen.getByTestId('history-attachment-filenames')).toHaveTextContent('diagram.png')
    expect(screen.getByTestId('history-message-sources')).toHaveTextContent(
      'user:im:session-1|assistant:none:none|user:none:none'
    )
  })

  test('restores persisted tool blocks when opening task history', async () => {
    function ToolBlockHistoryProbe() {
      const workbench = useWorkbench()
      return (
        <div>
          <button type="button" onClick={() => void workbench.openTask(8)}>
            open task
          </button>
          <ol data-testid="tool-blocks">
            {workbench.messages.flatMap(message =>
              (message.blocks ?? []).flatMap(block =>
                block.type === 'tool'
                  ? [
                      <li key={block.id}>
                        {block.toolName}:{String(block.toolInput?.command)}:
                        {String(block.toolOutput)}:{block.status}
                      </li>,
                    ]
                  : block.type === 'thinking'
                    ? [
                        <li key={block.id}>
                          thinking:{block.content}:{block.status}
                        </li>,
                      ]
                    : [
                        <li key={block.id}>
                          text:{block.content}:{block.status}
                        </li>,
                      ]
              )
            )}
          </ol>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'COMPLETED',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [
                {
                  id: 12,
                  task_id: 8,
                  role: 'ASSISTANT',
                  message_id: 2,
                  prompt: '',
                  result: {
                    value: '/Users/yunpeng7/AIGCWorkSpace',
                    blocks: [
                      {
                        id: 'call_exec_1',
                        type: 'tool',
                        tool_use_id: 'call_exec_1',
                        tool_name: 'exec',
                        tool_input: { command: 'pwd' },
                        tool_output: '/Users/yunpeng7/AIGCWorkSpace',
                        status: 'completed',
                        timestamp: 1770000000,
                      },
                      {
                        id: 'thinking_1',
                        type: 'thinking',
                        content: 'I will inspect the workspace',
                        status: 'streaming',
                        timestamp: 1770000000100,
                      },
                      {
                        id: 'text_1',
                        type: 'text',
                        content: 'Let me check the workspace.',
                        status: 'done',
                        timestamp: 1770000000200,
                      },
                    ],
                  },
                  status: 'COMPLETED',
                  created_at: '2026-05-27T00:02:00.000Z',
                  completed_at: '2026-05-27T00:03:00.000Z',
                },
              ],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ToolBlockHistoryProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))

    await waitFor(() =>
      expect(screen.getByTestId('tool-blocks')).toHaveTextContent(
        'exec:pwd:/Users/yunpeng7/AIGCWorkSpace:done'
      )
    )
    expect(screen.getByTestId('tool-blocks')).toHaveTextContent(
      'thinking:I will inspect the workspace:done'
    )
    expect(screen.getByTestId('tool-blocks')).toHaveTextContent(
      'text:Let me check the workspace.:done'
    )
  })

  test('sends current-task model override but not skill overrides after a task is open', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 8 })
    const updateCurrentUser = vi.fn()

    function LockedProbe() {
      const workbench = useWorkbench()
      const projectChat = workbench.projectChat

      return (
        <div>
          <button
            type="button"
            onClick={() =>
              projectChat.setSelectedModel({
                name: 'gpt-5.5-medium',
                type: 'user',
              })
            }
          >
            select locked model
          </button>
          <button
            type="button"
            onClick={() =>
              projectChat.setSelectedSkills([
                { name: 'project-summary', namespace: 'default', is_public: false },
              ])
            }
          >
            select locked skill
          </button>
          <button type="button" onClick={() => workbench.setInput('continue')}>
            set input
          </button>
          <button type="button" onClick={() => void workbench.openTask(8)}>
            open task
          </button>
          <button type="button" onClick={() => void workbench.sendCurrentInput()}>
            send
          </button>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'gpt-5.5-medium',
                  type: 'user',
                  config: {
                    protocol: 'openai',
                  },
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'SUCCESS',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          userApi: {
            updateCurrentUser,
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <LockedProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))
    await userEvent.click(screen.getByText('select locked model'))
    await userEvent.click(screen.getByText('select locked skill'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalled())
    const payload = sendMessage.mock.calls[0][0]
    expect(payload).toEqual(
      expect.objectContaining({
        task_id: 8,
        force_override_bot_model: 'gpt-5.5-medium',
        force_override_bot_model_type: 'user',
      })
    )
    expect(payload).not.toHaveProperty('additional_skills')
    expect(updateCurrentUser).not.toHaveBeenCalled()
  })

  test('sends an attachment-only project message without echoing fallback text', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 100 })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [],
        unmappedDeviceWorkspaces: [
          {
            id: null,
            projectId: null,
            deviceId: 'local-online',
            deviceName: 'Local Online',
            deviceStatus: 'online',
            workspacePath: '/workspace/local',
            mapped: false,
            available: true,
            localTasks: [],
          },
        ],
        totalLocalTasks: 0,
      }),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'local-online',
        localTaskId: 'runtime-attachment',
        workspacePath: '/workspace/local',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        localTaskId: 'runtime-attachment',
        workspacePath: '/workspace/local',
        runtime: 'claude_code',
        messages: [
          {
            id: 'runtime-attachment:user:1',
            role: 'user',
            content: '',
            createdAt: '2026-06-20T00:00:00.000Z',
            attachments: [
              {
                id: 55,
                filename: 'screenshot.png',
                file_size: 1200,
                mime_type: 'image/png',
                status: 'ready',
                file_extension: '.png',
                created_at: '2026-05-27T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    })

    function AttachmentOnlyProbe() {
      const workbench = useWorkbench()
      const attachment: Attachment = {
        id: 55,
        filename: 'screenshot.png',
        file_size: 1200,
        mime_type: 'image/png',
        status: 'ready',
        file_extension: '.png',
        created_at: '2026-05-27T00:00:00.000Z',
      }

      return (
        <div>
          <span data-testid="attachment-probe-ready">
            {workbench.state.defaultTeam ? 'ready' : 'loading'}
          </span>
          <span data-testid="attachment-message-contents">
            {workbench.messages
              .map(message => `${message.role}:${message.status}:${message.content}`)
              .join('|')}
          </span>
          <span data-testid="attachment-current-task-title">
            {workbench.state.currentRuntimeTask?.localTaskId ?? ''}
          </span>
          <button
            type="button"
            onClick={() => workbench.projectChat.addExistingAttachment(attachment)}
          >
            add attachment
          </button>
          <button type="button" onClick={() => void workbench.sendCurrentInput()}>
            send
          </button>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([
              {
                id: 1,
                device_id: 'local-online',
                name: 'Local Online',
                status: 'online',
                is_default: false,
                device_type: 'local',
                bind_shell: 'claudecode',
                executor_version: '1.8.5',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
          runtimeWorkApi,
        }}
      >
        <AttachmentOnlyProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('attachment-probe-ready')).toHaveTextContent('ready')
    )
    await userEvent.click(screen.getByText('add attachment'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '',
          title: '新对话',
          attachmentIds: [55],
        })
      )
    )
    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachment-message-contents')).not.toHaveTextContent('请参考附件')
    expect(screen.getByTestId('attachment-message-contents')).toHaveTextContent('user:done:')
    expect(screen.getByTestId('attachment-current-task-title')).toHaveTextContent(
      'runtime-attachment'
    )
  })

  test('keeps the model the user picked in an open task across chat:start events', async () => {
    // Regression: the dropdown used to revert to the task's original model
    // ~2 seconds after the user picked a new one, because the next turn's
    // chat:start WebSocket event dispatched task_status_changed and the
    // syncSelection effect then re-anchored the dropdown on the stale
    // currentTask.model_id (which had never been updated for existing tasks).
    type StreamHandlers = {
      onChatStart?: (payload: { task_id: number; subtask_id: number }) => void
    }
    let streamHandlers: StreamHandlers | undefined

    function ModelPersistProbe() {
      const workbench = useWorkbench()

      return (
        <div>
          <span data-testid="current-task-model">
            {workbench.state.currentTask?.model_id ?? 'no-task'}
          </span>
          <span data-testid="selected-model">
            {workbench.projectChat.selectedModel?.name ?? 'no-model'}
          </span>
          <button
            type="button"
            data-testid="switch-to-opus"
            onClick={() =>
              workbench.projectChat.setSelectedModel({
                name: 'wecode-claude-opus-4',
                type: 'public',
              })
            }
          >
            switch to opus
          </button>
          <button type="button" onClick={() => void workbench.openTask(8)}>
            open task
          </button>
        </div>
      )
    }

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi
              .fn()
              .mockResolvedValue({ id: 2, name: 'coder', is_active: true }),
          },
          modelApi: {
            listModels: vi.fn().mockResolvedValue({
              data: [
                {
                  name: 'wecode-claude-sonnet-4-5',
                  type: 'public',
                },
                {
                  name: 'wecode-claude-opus-4',
                  type: 'public',
                },
              ],
            }),
          },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects: vi.fn().mockResolvedValue({ items: [] }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
          },
          taskApi: {
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'SUCCESS',
              task_type: 'code',
              project_id: 0,
              model_id: 'wecode-claude-sonnet-4-5',
              force_override_bot_model_type: 'public',
              created_at: '2026-06-04T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
          },
          deviceApi: {
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
            listSkills: vi.fn().mockResolvedValue([]),
          },
          chatStream: {
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers as StreamHandlers
              return vi.fn()
            }),
          },
        }}
      >
        <ModelPersistProbe />
      </WorkbenchProvider>
    )

    // 1. Open the task; the dropdown anchors on the task's saved model.
    await userEvent.click(await screen.findByText('open task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-task-model')).toHaveTextContent('wecode-claude-sonnet-4-5')
    )
    expect(screen.getByTestId('selected-model')).toHaveTextContent('wecode-claude-sonnet-4-5')

    // 2. User picks a different model. The dropdown updates immediately
    //    AND the open task's model_id is mirrored so subsequent
    //    task_status updates (e.g. chat:start) can't revert it.
    await userEvent.click(screen.getByTestId('switch-to-opus'))
    await waitFor(() =>
      expect(screen.getByTestId('current-task-model')).toHaveTextContent('wecode-claude-opus-4')
    )
    expect(screen.getByTestId('selected-model')).toHaveTextContent('wecode-claude-opus-4')

    // 3. The next turn's chat:start event flips task status from SUCCESS to
    //    RUNNING. Before the fix this rebuilt state.currentTask and the
    //    syncSelection effect then re-anchored the dropdown on the stale
    //    model_id — reverting the user's choice. After the fix the open
    //    task's model_id already reflects the new selection, so nothing
    //    flips back.
    expect(streamHandlers?.onChatStart).toBeDefined()
    act(() => {
      streamHandlers?.onChatStart?.({ task_id: 8, subtask_id: 99 })
    })

    await waitFor(() =>
      expect(screen.getByTestId('selected-model')).toHaveTextContent('wecode-claude-opus-4')
    )
    expect(screen.getByTestId('current-task-model')).toHaveTextContent('wecode-claude-opus-4')
  })
})
