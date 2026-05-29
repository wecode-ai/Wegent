import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import type { Attachment, SkillRef, UnifiedModel } from '@/types/api'

function Probe() {
  const { state } = useWorkbench()
  return (
    <div data-testid="probe">
      {state.isBootstrapping ? 'loading' : state.user?.user_name}
    </div>
  )
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
      <button type="button" onClick={() => workbench.selectProject(7)}>
        select project
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
      <button type="button" onClick={() => workbench.setInput('build it')}>
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

function ProjectSelectionProbe() {
  const workbench = useWorkbench()

  return (
    <div>
      <span data-testid="current-project-name">
        {workbench.state.currentProject?.name ?? 'no-project'}
      </span>
      <button type="button" onClick={() => workbench.startNewChat()}>
        new chat
      </button>
      <button type="button" onClick={() => workbench.startStandaloneChat()}>
        standalone chat
      </button>
    </div>
  )
}

describe('WorkbenchProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
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

  test('restores the last concrete project for new chat and can clear project work', async () => {
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

    await userEvent.click(screen.getByText('new chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
  })

  test('sends project chat options for a new project conversation', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 99 })
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
          modelApi: { listModels: vi.fn().mockResolvedValue({ data: [] }) },
          skillApi: {
            listSkills: vi.fn().mockResolvedValue([]),
            getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
          },
          projectApi: {
            listProjects,
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
          device_id: 'device-1',
          task_type: 'code',
          message: 'build it',
          force_override_bot_model: 'gpt-5.5-medium',
          force_override_bot_model_type: 'user',
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
    expect(listProjects).toHaveBeenCalledTimes(2)
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
              },
              {
                id: 2,
                device_id: 'cloud-online',
                name: 'Cloud Online',
                status: 'online',
                is_default: false,
                device_type: 'cloud',
              },
            ]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
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
      expect(screen.getByTestId('standalone-device-id')).toHaveTextContent(
        'cloud-online'
      )
    )

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          team_id: 2,
          project_id: undefined,
          device_id: 'cloud-online',
          task_type: 'code',
          message: 'run pwd',
        })
      )
    )
  })

  test('does not send model or skill overrides after a task is open', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ success: true, task_id: 8 })

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

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({
          model_id: 'gpt-5.5-medium',
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
  })

  test('sends an attachment-only project message with fallback text', async () => {
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
          <button type="button" onClick={() => workbench.projectChat.addExistingAttachment(attachment)}>
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
            listDevices: vi.fn().mockResolvedValue([]),
            getHomeDirectory: vi.fn(),
            getProjectWorkspaceRoot: vi.fn(),
            listDirectories: vi.fn(),
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

    await userEvent.click(await screen.findByText('add attachment'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '请参考附件',
          attachment_ids: [55],
        })
      )
    )
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
})
