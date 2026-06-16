import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import type { Attachment, SkillRef, UnifiedModel } from '@/types/api'

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
      <span data-testid="workbench-input">{workbench.state.input}</span>
      <span data-testid="workbench-error">{workbench.state.error ?? ''}</span>
      <button type="button" onClick={() => workbench.selectProject(7)}>
        select project
      </button>
      <button type="button" onClick={() => workbench.startNewProjectChat(8)}>
        start project 8 chat
      </button>
      <button type="button" onClick={() => projectChat.setSelectedModel(selectedModel)}>
        select model
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
      <button type="button" onClick={() => workbench.setInput('build it')}>
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

function ArchiveProbe() {
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
      <button type="button" onClick={() => void workbench.archiveAllChats()}>
        archive all
      </button>
    </div>
  )
}

function RunningTasksProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="running-task-ids">
        {Array.from(workbench.runningTaskIds)
          .sort((a, b) => a - b)
          .join(',')}
      </span>
      <span data-testid="current-task-title">
        {workbench.state.currentTask?.title ?? 'no-task'}
      </span>
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open task 8
      </button>
      <button type="button" onClick={() => void workbench.openTask(9)}>
        open task 9
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
      <button type="button" onClick={() => void workbench.openTask(8)}>
        open task
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail,
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
        <ArchiveProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(getTaskDetail).toHaveBeenCalledWith(8))
    expect(await screen.findByTestId('current-task-title')).toHaveTextContent('Restored task')
    expect(joinTask).toHaveBeenCalledWith(8)
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail,
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail,
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
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
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
              items: [{ id: 7, name: 'Wegent', tasks: [] }],
            }),
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
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
              items: [{ id: 7, name: 'Wegent', tasks: [] }],
            }),
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
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
              items: [{ id: 7, name: 'Wegent', tasks: [] }],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({
              total: 1,
              items: [
                {
                  id: 8,
                  title: 'hello-1',
                  status: 'SUCCESS',
                  task_type: 'code',
                  project_id: 0,
                  device_id: 'local-online',
                  created_at: '2026-05-29T00:00:00.000Z',
                },
              ],
            }),
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
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({
              total: 1,
              items: [
                {
                  id: 8,
                  title: 'restored chat',
                  status: 'SUCCESS',
                  task_type: 'code',
                  project_id: 0,
                  device_id: 'local-online',
                  created_at: '2026-05-29T00:00:00.000Z',
                },
              ],
            }),
            getTaskDetail,
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
        <ArchiveProbe />
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          team_id: 2,
          project_id: 7,
          client_origin: 'wework',
          device_id: 'device-1',
          task_type: 'code',
          message: 'build it',
          force_override_bot_model: 'gpt-5.5-medium',
          force_override_bot_model_type: 'user',
          model_options: {
            reasoning: 'high',
          },
          attachment_ids: [42],
          additional_skills: [
            {
              name: 'project-summary',
              namespace: 'default',
              is_public: false,
            },
          ],
        })
      )
    )
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 71,
              title: 'Continue project work',
              status: 'SUCCESS',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
          userApi: { updateCurrentUser },
        }}
      >
        <ProjectChatProbe />
      </WorkbenchProvider>
    )

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())

    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('select worktree'))

    expect(updateCurrentUser).toHaveBeenCalledWith({
      preferences: {
        wework_project_execution_mode: 'git_worktree',
      },
    })

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 7,
          device_id: 'device-1',
          execution: {
            workspace: {
              source: 'git_worktree',
            },
          },
        })
      )
    )
  })

  test('uses the remembered project execution mode for new project conversations', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })

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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 8,
          device_id: 'device-2',
          execution: {
            workspace: {
              source: 'git_worktree',
            },
          },
        })
      )
    )
  })

  test('sends standalone chats to the preferred online cloud device', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 100 })

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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          team_id: 2,
          project_id: 0,
          client_origin: 'wework',
          device_id: 'cloud-online',
          task_type: 'code',
          message: 'run pwd',
        })
      )
    )
    const url = window.location.pathname + window.location.search
    expect(url === '/tasks/100' || url === '/projects/0/tasks/100').toBe(true)
  })

  test('treats backend chat ACK without success as successful and reuses task id', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ task_id: 99, subtask_id: 101, message_id: 1 })
      .mockResolvedValueOnce({ task_id: 99, subtask_id: 103, message_id: 3 })

    function FollowUpProbe() {
      const workbench = useWorkbench()
      return (
        <div>
          <span data-testid="current-task-id">{workbench.state.currentTask?.id ?? 'no-task'}</span>
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
              items: [{ id: 7, name: 'Wegent', tasks: [] }],
            }),
            getProject: vi.fn(),
            createProject: vi.fn(),
            updateProject: vi.fn(),
            deleteProject: vi.fn(),
            archiveProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
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
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <FollowUpProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set first input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(screen.getByTestId('current-task-id')).toHaveTextContent('99'))

    await userEvent.click(screen.getByText('set second input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        task_id: 99,
        project_id: undefined,
        message: '我叫什么',
      })
    )
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'RUNNING',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'RUNNING',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
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
    type StreamHandlers = {
      onChatStart?: (payload: { task_id: number; subtask_id: number; shell_type?: string }) => void
      onChatError?: (payload: {
        task_id?: number
        subtask_id: number
        error: string
        type?: string
      }) => void
    }
    let streamHandlers: StreamHandlers | undefined
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
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
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage,
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers as StreamHandlers
              return vi.fn()
            }),
          },
        }}
      >
        <RetryFailedMessageProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('set retry input'))
    await userEvent.click(screen.getByText('send retry input'))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))

    act(() => {
      streamHandlers?.onChatStart?.({
        task_id: 8,
        subtask_id: 101,
        shell_type: 'Chat',
      })
      streamHandlers?.onChatError?.({
        task_id: 8,
        subtask_id: 101,
        error: 'Task failed with status: FAILED',
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('retry-message-states')).toHaveTextContent('assistant::failed')
    )

    await userEvent.click(screen.getByText('retry failed message'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        task_id: 8,
        message: 'hi',
      })
    )
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
            archiveProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
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
                  result: { value: '你好，胡云鹏！' },
                  status: 'COMPLETED',
                  created_at: '2026-05-27T00:02:00.000Z',
                },
                {
                  id: 11,
                  role: 'USER',
                  message_id: 1,
                  prompt: '我叫胡云鹏',
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
              ],
            }),
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
        'user:我叫胡云鹏assistant:你好，胡云鹏！'
      )
    )
    expect(screen.getByTestId('history-attachment-filenames')).toHaveTextContent('diagram.png')
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
            archiveProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'SUCCESS',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [],
            }),
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
            {workbench.state.currentTask?.title ?? ''}
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
            getTaskDetail: vi.fn(),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats: vi.fn(),
            listArchivedTasks: vi.fn(),
            unarchiveTask: vi.fn(),
            deleteTask: vi.fn(),
            deleteArchivedTasks: vi.fn(),
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
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '',
          title: '新对话',
          attachment_ids: [55],
        })
      )
    )
    expect(screen.getByTestId('attachment-message-contents')).not.toHaveTextContent('请参考附件')
    expect(screen.getByTestId('attachment-message-contents')).toHaveTextContent('user:done:')
    expect(screen.getByTestId('attachment-current-task-title')).toHaveTextContent('新对话')
  })

  test('clears the open task and messages after archiving all chats', async () => {
    const archiveAllChats = vi.fn().mockResolvedValue({ message: 'ok', count: 1 })

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
            getTaskDetail: vi.fn().mockResolvedValue({
              id: 8,
              title: 'Existing task',
              status: 'SUCCESS',
              task_type: 'code',
              created_at: '2026-05-27T00:00:00.000Z',
              subtasks: [
                {
                  id: 9,
                  role: 'user',
                  prompt: 'hello',
                  status: 'SUCCESS',
                  created_at: '2026-05-27T00:01:00.000Z',
                },
              ],
            }),
            renameTask: vi.fn(),
            archiveTask: vi.fn(),
            archiveAllChats,
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
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            subscribe: vi.fn(() => vi.fn()),
          },
        }}
      >
        <ArchiveProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-task-title')).toHaveTextContent('Existing task')
    )
    expect(screen.getByTestId('message-count')).toHaveTextContent('1')

    await userEvent.click(screen.getByText('archive all'))

    await waitFor(() => expect(archiveAllChats).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-task-title')).toHaveTextContent('no-task')
    expect(screen.getByTestId('message-count')).toHaveTextContent('0')
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({ total: 0, items: [] }),
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

  test('keeps a live running task indicator after switching to another task', async () => {
    type StreamHandlers = {
      onChatStart?: (payload: { task_id: number; subtask_id: number }) => void
    }
    let streamHandlers: StreamHandlers | undefined

    const getTaskDetail = vi.fn(async (taskId: number) => ({
      id: taskId,
      title: `Task ${taskId}`,
      status: 'COMPLETED',
      task_type: 'code',
      project_id: 0,
      created_at: '2026-06-04T00:00:00.000Z',
      subtasks: [],
    }))

    render(
      <WorkbenchProvider
        user={{ id: 1, user_name: 'alice', email: 'a@b.c' }}
        services={{
          teamApi: {
            getDefaultWorkbenchTeam: vi.fn().mockResolvedValue({ id: 2, name: 'coder' }),
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
            archiveProjectChats: vi.fn(),
            archiveAllProjectChats: vi.fn(),
            createConversation: vi.fn(),
          },
          taskApi: {
            listRecentTasks: vi.fn().mockResolvedValue({
              total: 2,
              items: [
                {
                  id: 8,
                  title: 'Task 8',
                  status: 'COMPLETED',
                  task_type: 'code',
                  project_id: 0,
                  created_at: '2026-06-04T00:00:00.000Z',
                },
                {
                  id: 9,
                  title: 'Task 9',
                  status: 'COMPLETED',
                  task_type: 'code',
                  project_id: 0,
                  created_at: '2026-06-04T00:01:00.000Z',
                },
              ],
            }),
            getTaskDetail,
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
            joinTask: vi.fn(),
            leaveTask: vi.fn(),
            sendMessage: vi.fn(),
            cancelStream: vi.fn(),
            subscribe: vi.fn(handlers => {
              streamHandlers = handlers as StreamHandlers
              return vi.fn()
            }),
          },
        }}
      >
        <RunningTasksProbe />
      </WorkbenchProvider>
    )

    await userEvent.click(await screen.findByText('open task 8'))
    await waitFor(() =>
      expect(screen.getByTestId('current-task-title')).toHaveTextContent('Task 8')
    )

    act(() => {
      streamHandlers?.onChatStart?.({ task_id: 8, subtask_id: 80 })
    })

    await waitFor(() => expect(screen.getByTestId('running-task-ids')).toHaveTextContent('8'))

    await userEvent.click(screen.getByText('open task 9'))
    await waitFor(() =>
      expect(screen.getByTestId('current-task-title')).toHaveTextContent('Task 9')
    )

    expect(screen.getByTestId('running-task-ids')).toHaveTextContent('8')
  })
})
