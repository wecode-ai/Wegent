import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { clearRuntimeConversationCacheForTests } from '@/features/workbench/runtimeConversationCache'
import { TaskActivityView } from './TaskActivityView'
import type { Attachment } from '@/types/api'

const createProjectRuntimeTask = vi.fn()
const sendRuntimePaneMessage = vi.fn()
const openRuntimeTask = vi.fn()
const cancelRuntimeTask = vi.fn()
const bindTask = vi.fn()
const updateLoopItem = vi.fn()
const getLoopItem = vi.fn()
const approveLoopItemRun = vi.fn()
const rejectLoopItemRun = vi.fn()
const listModels = vi.fn()
const attachmentSelectionMock = {
  attachments: [] as Attachment[],
  uploadingFiles: new Map(),
  errors: new Map(),
  isAttachmentReadyToSend: true,
  handleFileSelect: vi.fn(),
  addExistingAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  resetAttachments: vi.fn(),
}

const { runtimeWorkMock, agentsMock, openExternalUrlMock } = vi.hoisted(() => ({
  runtimeWorkMock: { value: null as unknown },
  agentsMock: { value: [] as Array<Record<string, unknown>> },
  openExternalUrlMock: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/external-links')>()),
  openExternalUrl: openExternalUrlMock,
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    state: {
      runtimeWork: runtimeWorkMock.value,
      devices: [],
    },
    services: {
      deliveryApi: { bindTask, updateLoopItem, getLoopItem, approveLoopItemRun, rejectLoopItemRun },
      projectChatAgentApi: {
        list: vi.fn(async () => agentsMock.value),
      },
      modelApi: { listModels },
    },
    createProjectRuntimeTask,
    sendRuntimePaneMessage,
    openRuntimeTask,
    cancelRuntimeTask,
  }),
}))

vi.mock('@/components/layout/useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => ({
    messages: [],
    queuedMessages: [],
    queuedMessagesPaused: false,
    guidanceMessages: [],
    codeCommentContexts: [],
    input: '',
    setInput: vi.fn(),
    error: null,
    status: {
      taskExecution: { running: false, status: 'completed' },
    },
    sending: false,
    waitingForAssistant: false,
    answeredRequestUserInputIds: new Set(),
    transcriptLoading: false,
    transcriptHasMoreBefore: false,
    transcriptLoadingMoreBefore: false,
    transcriptLoadingFullContent: false,
    transcriptFullContent: false,
    loadedTranscriptRanges: [],
    turnNavigation: [],
    subagentStatuses: [],
    goal: null,
    goalContinuing: false,
    taskPlan: null,
    goalDraftActive: false,
    loadMoreTranscriptBefore: vi.fn(),
    loadFullTranscript: vi.fn(),
    loadFullTranscriptForExport: vi.fn(),
    loadTranscriptTurnNavigationItem: vi.fn(),
    loadTranscriptGap: vi.fn(),
    send: vi.fn(),
    retryFailedMessage: vi.fn(),
    editLastUserMessage: vi.fn(),
    sendRequestUserInputResponse: vi.fn(),
    ignoreRequestUserInput: vi.fn(),
    addCodeComment: vi.fn(),
    clearCodeComments: vi.fn(),
    cancelQueuedMessage: vi.fn(),
    resumeQueuedMessages: vi.fn(),
    resumeQueuedMessagesWithInput: vi.fn(),
    clearQueuedMessages: vi.fn(),
    reorderQueuedMessages: vi.fn(),
    sendQueuedAsGuidance: vi.fn(),
    interruptAndSendQueued: vi.fn(),
    editQueuedMessage: vi.fn(),
    cancelGuidanceMessage: vi.fn(),
    pauseCurrentResponse: vi.fn(),
    compactContext: vi.fn(),
    setCurrentGoal: vi.fn(),
    cancelGoalDraft: vi.fn(),
    editCurrentGoal: vi.fn(),
    pauseCurrentGoal: vi.fn(),
    resumeCurrentGoal: vi.fn(),
    clearCurrentGoal: vi.fn(),
  }),
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: () => <div data-testid="runtime-execution-transcript">transcript</div>,
}))

vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: () => attachmentSelectionMock,
}))

const userMessage: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'message-1',
  projectId: '11',
  taskId: 'WEG-1',
  sender: { type: 'user', id: '1', name: 'Ada' },
  type: 'text',
  content: '@Code Reviewer inspect this',
  metadata: {
    mentions: [{ type: 'agent', id: '12', label: 'Code Reviewer' }],
  },
  status: 'completed',
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
}

const agentMessage: ProjectChatMessage = {
  ...userMessage,
  sequenceNumber: 2,
  messageId: 'message-2',
  sender: { type: 'agent', id: '12', name: 'Code Reviewer' },
  type: 'agent_chunk',
  content: '',
  metadata: {},
  status: 'streaming',
}

describe('TaskActivityView', () => {
  beforeEach(() => {
    clearRuntimeConversationCacheForTests()
    agentsMock.value = [
      {
        id: '12',
        projectId: '11',
        name: 'Code Reviewer',
        runtime: 'codex',
        model: null,
        systemPrompt: '',
        status: 'active',
        visibility: 'creator_admin',
        executionEnvironment: 'local',
        executionMode: 'auto',
        executionDeviceId: null,
        localProjectId: null,
        createdByUserId: 1,
        createdByUserName: 'Alice',
        version: 1,
        createdAt: '',
        updatedAt: '',
      },
    ]
    runtimeWorkMock.value = null
    createProjectRuntimeTask.mockReset()
    sendRuntimePaneMessage.mockReset()
    sendRuntimePaneMessage.mockResolvedValue(true)
    openRuntimeTask.mockReset()
    openExternalUrlMock.mockReset()
    openExternalUrlMock.mockResolvedValue(true)
    cancelRuntimeTask.mockReset()
    bindTask.mockReset()
    updateLoopItem.mockReset()
    getLoopItem.mockReset()
    approveLoopItemRun.mockReset()
    rejectLoopItemRun.mockReset()
    listModels.mockReset()
    attachmentSelectionMock.attachments = []
    attachmentSelectionMock.isAttachmentReadyToSend = true
    attachmentSelectionMock.resetAttachments.mockReset()
    attachmentSelectionMock.handleFileSelect.mockReset()
    listModels.mockResolvedValue({ data: [] })
    updateLoopItem.mockImplementation(async (_id, values) => ({
      id: 'WEG-1',
      title: 'Inspect changes',
      description: 'Review the current diff',
      assignee_agent_id: '12',
      version: 2,
      ...values,
    }))
    getLoopItem.mockImplementation(async id => ({
      id,
      title: 'Inspect changes',
      description: 'Review the current diff',
      assignee_agent_id: '12',
      status: 'in_review',
      version: 8,
      ai_state: { status: 'completed', project_chat_message_id: 'message-2' },
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts the assigned AI when a task comment is added without an @ mention', async () => {
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    expect(screen.getByTestId('cloud-task-activity-WEG-1')).toHaveTextContent('动态')
    expect(screen.queryByTestId('cloud-task-activity-close')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '继续处理',
        mentions: [expect.objectContaining({ type: 'agent', id: '12' })],
      })
    )
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '继续处理',
      expect.objectContaining({
        cloudProjectId: '11',
        additionalContext: expect.objectContaining({
          projectChatTask: expect.objectContaining({
            value: expect.stringContaining('WEG-1'),
          }),
        }),
      })
    )
    expect(createProjectRuntimeTask.mock.calls[0][1].additionalContext).not.toHaveProperty(
      'projectChatHistory'
    )
    expect(createProjectRuntimeTask.mock.calls[0][1]).not.toHaveProperty('modelId')
    expect(createProjectRuntimeTask.mock.calls[0][1]).not.toHaveProperty('executionModel')
    await waitFor(() => expect(client.startAgentResponse).toHaveBeenCalledOnce())
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerMessageId: 'message-1',
        agentId: '12',
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      })
    )
    expect(await screen.findByText('机器人已接收')).toBeInTheDocument()
  })

  it('defaults the parent comment execution project to the task page project', async () => {
    runtimeWorkMock.value = {
      projects: [
        {
          project: { id: 91, name: '运营工作区' },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              projectId: 91,
              tasks: [{ taskId: 'runtime-task-1', title: '执行任务' }],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
            ai_state: {
              runtime_device_id: 'device-1',
              runtime_task_id: 'runtime-task-1',
            },
          } as never
        }
      />
    )

    const projectTrigger = screen.getByTestId('project-work-button')
    expect(projectTrigger).toHaveTextContent('运营工作区')
    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '继续处理',
        expect.objectContaining({ project: expect.objectContaining({ id: 91 }) })
      )
    )
  })

  it('does not infer a project from the robot record', async () => {
    agentsMock.value = [
      {
        id: '12',
        projectId: '11',
        name: 'Code Reviewer',
        runtime: 'codex',
        model: null,
        systemPrompt: '',
        status: 'active',
        visibility: 'creator_admin',
        executionEnvironment: 'local',
        executionMode: 'auto',
        executionDeviceId: 'device-1',
        localProjectId: 91,
        createdByUserId: 1,
        createdByUserName: 'Alice',
        version: 1,
        createdAt: '',
        updatedAt: '',
      },
    ]
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')
    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '继续处理',
        expect.objectContaining({ project: null })
      )
    )
  })

  it('shows the project placeholder when nothing binds a project', async () => {
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    runtimeWorkMock.value = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          projectId: null,
          tasks: [{ taskId: 'parent-session-1', title: '执行任务' }],
        },
      ],
      totalTasks: 1,
    }
    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    const projectTrigger = screen.getByTestId('project-work-button')
    expect(projectTrigger).toHaveTextContent('请选择项目')
  })

  it('lets the user override the execution project from the picker menu', async () => {
    runtimeWorkMock.value = {
      projects: [
        { project: { id: 91, name: '运营工作区' }, deviceWorkspaces: [] },
        { project: { id: 92, name: '侧项目' }, deviceWorkspaces: [] },
      ],
      chats: [],
      totalTasks: 0,
    }
    agentsMock.value = [
      {
        id: '12',
        projectId: '11',
        name: 'Code Reviewer',
        runtime: 'codex',
        model: null,
        systemPrompt: '',
        status: 'active',
        visibility: 'creator_admin',
        executionEnvironment: 'local',
        executionMode: 'auto',
        executionDeviceId: 'device-1',
        localProjectId: 91,
        createdByUserId: 1,
        createdByUserName: 'Alice',
        version: 1,
        createdAt: '',
        updatedAt: '',
      },
    ]
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        localProjects={[
          { id: 91, name: '运营工作区', tasks: [] },
          { id: 92, name: '侧项目', tasks: [] },
        ]}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')
    expect(screen.queryByTestId('clear-project-button')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('project-work-button'))
    await screen.findByTestId('project-work-menu')
    await user.click(screen.getByTestId('project-option-92'))

    expect(screen.getByTestId('project-work-button')).toHaveTextContent('侧项目')
    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '继续处理',
        expect.objectContaining({ project: expect.objectContaining({ id: 92 }) })
      )
    )

    await user.click(screen.getByTestId('clear-project-button'))
    expect(screen.getByTestId('project-work-button')).toHaveTextContent('请选择项目')
  })

  it('passes the per-comment model override to the AI run', async () => {
    listModels.mockResolvedValue({
      data: [
        {
          name: 'gpt-5.5-codex',
          type: 'runtime',
          displayName: 'GPT 5.5 Codex',
          config: { ui: { family: 'codex-official' } },
        },
      ],
    })
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.click(await screen.findByTestId('model-selector-button'))
    await user.hover(await screen.findByTestId('model-control-menu-model'))
    await user.click(await screen.findByTestId('model-option-gpt-5.5-codex'))
    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() =>
      expect(client.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '继续处理', model: 'gpt-5.5-codex' })
      )
    )
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '继续处理',
        expect.objectContaining({
          executionModel: {
            modelId: 'gpt-5.5-codex',
            modelType: 'runtime',
            modelOptions: expect.objectContaining({ collaborationMode: 'default' }),
          },
          modelSelection: {
            modelName: 'gpt-5.5-codex',
            modelType: 'runtime',
            options: expect.any(Object),
          },
        })
      )
    )
    await waitFor(() =>
      expect(client.startAgentResponse).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5-codex' })
      )
    )
  })

  it('shows the newest parent comment first without scrolling to the bottom', async () => {
    const older = {
      ...userMessage,
      sequenceNumber: 1,
      messageId: 'message-1',
      content: '较早评论',
    }
    const newer = {
      ...userMessage,
      sequenceNumber: 2,
      messageId: 'message-2',
      content: '最新评论',
    }
    const client = {
      subscribe: vi.fn(async () => {
        return {
          snapshot: { messages: [older, newer], latestSequence: 2, currentUserId: '1' },
          unsubscribe: vi.fn(),
        }
      }),
      send: vi.fn(async () => newer),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => agentMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const list = await screen.findByTestId('cloud-task-activity-list')
    Object.defineProperty(list, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    // The scroll position lags the just-grown content (old bottom), so a
    // naive "am I still at the bottom?" check would wrongly disable follow.
    Object.defineProperty(list, 'scrollTop', { value: 500, configurable: true })
    const scrollTo = vi.fn()
    Object.defineProperty(list, 'scrollTo', { value: scrollTo, configurable: true })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowY: 'auto',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)

    await screen.findByText('最新评论')
    const cards = list.querySelectorAll('.task-detail-comment-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent('最新评论')
    expect(cards[1]).toHaveTextContent('较早评论')

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls the comment list to the top when a new parent comment is sent', async () => {
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => agentMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const list = await screen.findByTestId('cloud-task-activity-list')
    Object.defineProperty(list, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(list, 'scrollTop', { value: 500, configurable: true })
    const scrollTo = vi.fn()
    Object.defineProperty(list, 'scrollTo', { value: scrollTo, configurable: true })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowY: 'auto',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' }))
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 1200, behavior: 'auto' })
  })

  it('keeps linear activity auto-follow inside the comment list', async () => {
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => agentMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <div data-testid="issue-detail-scroll-container">
        <TaskActivityView
          client={client}
          currentUserId={1}
          project={{ id: '11', name: 'Wework' } as never}
          task={
            {
              id: 'WEG-1',
              title: 'Inspect changes',
              description: 'Review the current diff',
              status: 'inbox',
              version: 1,
              assignee_agent_id: '12',
            } as never
          }
          linear
        />
      </div>
    )

    const outer = screen.getByTestId('issue-detail-scroll-container')
    const list = await screen.findByTestId('cloud-task-activity-list')
    const outerScrollTo = vi.fn()
    const listScrollTo = vi.fn()
    Object.defineProperty(outer, 'scrollTo', { value: outerScrollTo, configurable: true })
    Object.defineProperty(list, 'scrollTo', { value: listScrollTo, configurable: true })

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(listScrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' }))
    expect(outerScrollTo).not.toHaveBeenCalled()
  })

  it('places only the current user on the right when an AI has the same id', async () => {
    const collidingAgent = {
      ...agentMessage,
      sender: { type: 'agent' as const, id: '1', name: 'Local WeWork' },
    }
    const client = {
      subscribe: vi.fn(async (_projectId, _taskId, _afterSequence, onMessage) => {
        onMessage(userMessage)
        onMessage(collidingAgent)
        return {
          snapshot: {
            messages: [userMessage, collidingAgent],
            latestSequence: 2,
            currentUserId: '1',
          },
          unsubscribe: vi.fn(),
        }
      }),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => collidingAgent),
      failAgentResponse: vi.fn(async () => ({ ...collidingAgent, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={999}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 1,
          } as never
        }
      />
    )

    expect(await screen.findByTestId('cloud-task-activity-message-message-1')).toHaveAttribute(
      'data-side',
      'right'
    )
    expect(screen.getByTestId('cloud-task-activity-message-message-2')).toHaveAttribute(
      'data-side',
      'left'
    )
  })

  it('syncs completed AI activity to local review state without re-saving the task', async () => {
    const completedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: 'Ready for review',
      metadata: { run_id: 'run-123456789', run_status: 'completed' },
      status: 'completed' as const,
    }
    const onTaskUpdated = vi.fn()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => completedAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...completedAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        onTaskUpdated={onTaskUpdated}
        linear
      />
    )

    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(screen.queryByText('已提交结果，等待验收')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(onTaskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'in_review', version: 8 })
      )
    )
    expect(updateLoopItem).not.toHaveBeenCalled()
  })

  it('shows completed when message status is terminal but run metadata is stale', async () => {
    const completedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: '任务已执行完成。',
      metadata: { run_id: 'run-81610026', run_status: 'running' },
      status: 'completed' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => completedAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...completedAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const card = await screen.findByTestId('cloud-task-activity-message-message-2')
    expect(card).toHaveTextContent('任务已执行完成。')
    expect(card).toHaveTextContent('已完成')
    expect(card).not.toHaveTextContent('正在处理')
  })

  it('uses the task activity run status instead of stale Issue AI state', async () => {
    const runningAgentMessage = {
      ...agentMessage,
      metadata: { run_id: 'run-current', run_status: 'running' },
      status: 'streaming' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [runningAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => runningAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...runningAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            status: 'in_progress',
            version: 7,
            ai_state: {
              status: 'waiting_runtime',
              project_chat_message_id: runningAgentMessage.messageId,
            },
          } as never
        }
        linear
      />
    )

    expect(
      await screen.findByTestId(
        `cloud-task-activity-execution-badge-${runningAgentMessage.messageId}`
      )
    ).toHaveAttribute('data-status', 'running')
  })

  it('renders a bound workflow execution as a task summary and opens its task details', async () => {
    const user = userEvent.setup()
    const onOpenTask = vi.fn()
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'text',
      content: '已完成代码修改、单元测试和构建验证。',
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => completedAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...completedAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    const binding = {
      id: 9,
      cloud_project_id: '11',
      loop_item_id: 'WEG-1',
      task_user_id: 1,
      device_id: 'device-1',
      task_id: 'runtime-task-1',
      task_title: '实现 Issue 修改',
      backend_task_id: null,
      workflow_node_id: 'develop',
      linked_at: '2026-08-24T08:00:00Z',
    }

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            status: 'in_progress',
            workflow: {
              nodes: [{ id: 'develop', name: '开发' }],
            },
          } as never
        }
        taskBindings={[binding]}
        onOpenTask={onOpenTask}
        linear
      />
    )

    const card = await screen.findByTestId('cloud-task-activity-message-message-2')
    expect(card).toHaveTextContent('实现 Issue 修改')
    expect(card).toHaveTextContent('开发')
    expect(screen.getByTestId('cloud-task-activity-task-summary-message-2')).toHaveTextContent(
      '已完成代码修改、单元测试和构建验证。'
    )

    await user.click(screen.getByTestId('cloud-task-activity-open-task-message-2'))
    expect(onOpenTask).toHaveBeenCalledWith(binding)
  })

  it('renders a bound Issue execution as a task summary without a workflow stage', async () => {
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'text',
      content: '普通 Issue 执行完成。',
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => completedAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...completedAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={{ id: 'WEG-1', title: 'Inspect changes', status: 'in_progress' } as never}
        taskBindings={[
          {
            id: 10,
            cloud_project_id: '11',
            loop_item_id: 'WEG-1',
            task_user_id: 1,
            device_id: 'device-1',
            task_id: 'runtime-task-1',
            task_title: 'pwd',
            backend_task_id: null,
            workflow_node_id: null,
            linked_at: '2026-08-24T08:00:00Z',
          },
        ]}
        linear
      />
    )

    const card = await screen.findByTestId('cloud-task-activity-message-message-2')
    expect(card).toHaveTextContent('pwd')
    expect(card).toHaveTextContent('AI 执行')
    expect(card).toHaveTextContent('普通 Issue 执行完成。')
  })

  it('refreshes task bindings when a new execution activity has no loaded binding', async () => {
    const onRefreshTaskBindings = vi.fn(async () => undefined)
    const executionMessage: ProjectChatMessage = {
      ...agentMessage,
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [executionMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => executionMessage),
      failAgentResponse: vi.fn(async () => ({ ...executionMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        project={{ id: '11', name: 'Wework' } as never}
        task={{ id: 'WEG-1', title: 'Inspect changes', status: 'in_progress' } as never}
        onRefreshTaskBindings={onRefreshTaskBindings}
        linear
      />
    )

    await waitFor(() => expect(onRefreshTaskBindings).toHaveBeenCalledOnce())
    expect(
      screen.queryByTestId(`cloud-task-activity-task-summary-${executionMessage.messageId}`)
    ).not.toBeInTheDocument()
  })

  it.each([
    ['project_robot', '项目机器人'],
    ['custom', 'AI 托管'],
  ] as const)(
    'keeps the %s WeWork run carrier on its parent comment',
    async (executorType, name) => {
      const automationMessage: ProjectChatMessage = {
        ...agentMessage,
        messageId: `automation-${executorType}`,
        sender: { type: 'agent', id: executorType, name },
        type: 'agent_status',
        content: '',
        metadata: {
          kind: 'project_automation_run',
          executor_type: executorType,
          run_status: 'queued',
        },
        runtimeAddress: null,
        rootMessageId: null,
        status: 'pending',
      }
      const client = {
        subscribe: vi.fn(async () => ({
          snapshot: { messages: [automationMessage], latestSequence: 2, currentUserId: '1' },
          unsubscribe: vi.fn(),
        })),
        send: vi.fn(async () => userMessage),
        startAgentResponse: vi.fn(async () => agentMessage),
        failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
        dispose: vi.fn(),
      } satisfies ProjectChatClient

      render(
        <TaskActivityView
          client={client}
          project={{ id: '11', name: 'Wework' } as never}
          task={{ id: 'WEG-1', title: 'Inspect changes', status: 'in_progress' } as never}
          linear
        />
      )

      const parentComment = await screen.findByTestId(
        `cloud-task-activity-card-${automationMessage.messageId}`
      )
      expect(parentComment).toHaveTextContent(name)
      expect(
        screen.getByTestId(`cloud-task-activity-execution-badge-${automationMessage.messageId}`)
      ).toHaveAttribute('data-status', 'queued')
      expect(
        screen.queryByTestId(`cloud-task-activity-open-execution-${automationMessage.messageId}`)
      ).not.toBeInTheDocument()
    }
  )

  it.each([
    ['queued', 'pending', 'queued', '排队中', false],
    ['running', 'streaming', 'running', '执行中', true],
    ['completed', 'completed', 'succeeded', '已完成', false],
    ['failed', 'failed', 'failed', '执行失败', false],
    ['cancelled', 'cancelled', 'cancelled', '已取消', false],
  ] as const)(
    'shows the Wegent task carrier and the %s execution outcome',
    async (runStatus, messageStatus, expectedKind, expectedLabel, spins) => {
      const user = userEvent.setup()
      const managedMessage: ProjectChatMessage = {
        ...agentMessage,
        type: 'agent_status',
        content: '',
        metadata: {
          backend_task_id: 222,
          execution_url: 'http://localhost:3000/tasks?taskId=222',
          run_status: runStatus,
        },
        status: messageStatus,
      }
      const client = {
        subscribe: vi.fn(async () => ({
          snapshot: { messages: [managedMessage], latestSequence: 2, currentUserId: '1' },
          unsubscribe: vi.fn(),
        })),
        send: vi.fn(async () => userMessage),
        startAgentResponse: vi.fn(async () => agentMessage),
        failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
        dispose: vi.fn(),
      } satisfies ProjectChatClient

      render(
        <TaskActivityView
          client={client}
          currentUserId={1}
          project={{ id: '11', name: 'Wework' } as never}
          task={
            {
              id: 'WEG-1',
              title: 'Inspect changes',
              status: 'in_progress',
              version: 7,
              ai_state: {
                status: runStatus,
                project_chat_message_id: managedMessage.messageId,
              },
            } as never
          }
          linear
        />
      )

      const carrier = await screen.findByTestId(
        `cloud-task-activity-backend-task-${managedMessage.messageId}`
      )
      expect(carrier).toHaveTextContent('Wegent 任务 #222')
      const statusBadge = screen.getByTestId(
        `cloud-task-activity-execution-badge-${managedMessage.messageId}`
      )
      expect(statusBadge).toHaveAttribute('data-status', expectedKind)
      expect(statusBadge).toHaveAccessibleName(expectedLabel)
      expect(Boolean(statusBadge.querySelector('.animate-spin'))).toBe(spins)

      await user.click(
        screen.getByTestId(`cloud-task-activity-open-backend-task-${managedMessage.messageId}`)
      )
      expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost:3000/tasks?taskId=222')
    }
  )

  it('does not expose an invalid backend execution URL', async () => {
    const managedMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'agent_status',
      metadata: {
        backend_task_id: 222,
        execution_url: 'javascript:alert(1)',
        run_status: 'running',
      },
      status: 'streaming',
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [managedMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        project={{ id: '11', name: 'Wework' } as never}
        task={{ id: 'WEG-1', title: 'Inspect changes', status: 'in_progress' } as never}
        linear
      />
    )

    expect(await screen.findByTestId('cloud-task-activity-message-message-2')).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-task-activity-backend-task-message-2')
    ).not.toBeInTheDocument()
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  it('offers human review actions after AI submits a task result', async () => {
    const user = userEvent.setup()
    const completedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: 'Ready for review',
      metadata: { run_id: 'run-123456789', run_status: 'completed' },
      status: 'completed' as const,
    }
    const onTaskUpdated = vi.fn()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => ({ ...agentMessage, messageId: 'message-3' })),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-rerun',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_review',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        onTaskUpdated={onTaskUpdated}
        linear
      />
    )

    await screen.findByTestId('cloud-task-activity-review-actions-WEG-1')
    expect(screen.queryByTestId('cloud-task-activity-continue-WEG-1')).not.toBeInTheDocument()

    await user.click(await screen.findByTestId('cloud-task-activity-rerun-WEG-1'))
    await waitFor(() =>
      expect(client.startAgentResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerMessageId: undefined,
          runtimeTaskId: 'runtime-task-rerun',
          prompt: expect.stringContaining('你是 Code Reviewer，这个项目任务的 AI 执行者'),
        })
      )
    )

    await user.click(screen.getByTestId('cloud-task-activity-accept-WEG-1'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 7,
        status: 'completed',
      })
    )
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('offers manual rerun when the assigned AI run failed', async () => {
    listModels.mockResolvedValue({
      data: [
        {
          name: 'gpt-5.5-codex',
          type: 'runtime',
          displayName: 'GPT 5.5 Codex',
          config: { ui: { family: 'codex-official' } },
        },
      ],
    })
    const user = userEvent.setup()
    const requestedModelMessage = {
      ...userMessage,
      sequenceNumber: 1,
      messageId: 'message-1',
      content: '用大模型继续',
      metadata: { model: 'gpt-5.5-codex' },
    }
    const failedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: 'runtime failed',
      metadata: { run_id: 'run-failed-1', run_status: 'failed' },
      status: 'failed' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [requestedModelMessage, failedAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => ({ ...agentMessage, messageId: 'message-3' })),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-rerun-failed',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
            ai_state: {
              status: 'failed',
              project_chat_message_id: 'message-2',
              last_error: 'runtime failed',
            },
          } as never
        }
        linear
      />
    )

    const rerun = await screen.findByTestId('cloud-task-activity-rerun-WEG-1')
    expect(rerun).toHaveTextContent('重新执行')
    await user.click(rerun)
    await waitFor(() =>
      expect(client.startAgentResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerMessageId: undefined,
          runtimeTaskId: 'runtime-task-rerun-failed',
          prompt: expect.stringContaining('你是 Code Reviewer，这个项目任务的 AI 执行者'),
          model: 'gpt-5.5-codex',
        })
      )
    )
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionModel: expect.objectContaining({ modelId: 'gpt-5.5-codex' }),
      })
    )
  })

  it('renders child-agent activity as a single nested AI message', async () => {
    const subagentMessage = {
      ...agentMessage,
      sequenceNumber: 3,
      messageId: 'message-subagent',
      sender: { type: 'agent' as const, id: '12:tests', name: 'Code Reviewer.测试' },
      type: 'text' as const,
      content: '测试通过',
      metadata: { kind: 'task_ai_subagent', subagent_name: '测试' },
      status: 'completed' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [subagentMessage], latestSequence: 3, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const message = await screen.findByTestId('cloud-task-activity-message-message-subagent')
    expect(message).toHaveTextContent('Code Reviewer.测试')
    expect(message).toHaveTextContent('子任务执行')
    expect(message).toHaveTextContent('测试通过')
    expect(message).not.toHaveTextContent('已提交结果，等待验收')
  })

  it('opens AI execution details in a floating panel without navigating away', async () => {
    runtimeWorkMock.value = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          projectId: null,
          tasks: [{ taskId: 'runtime-task-1', title: 'Managed execution' }],
        },
      ],
      totalTasks: 1,
    }
    const user = userEvent.setup()
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'text',
      content: 'Ready for review',
      metadata: { run_id: 'run-123', model: 'gpt-5.2-codex' },
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.click(await screen.findByTestId('cloud-task-activity-open-execution-message-2'))

    expect(await screen.findByTestId('runtime-execution-detail-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-execution-transcript')).toBeInTheDocument()
    expect(screen.getByText('在任务页打开')).toBeInTheDocument()
    expect(openRuntimeTask).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('runtime-execution-detail-close'))
    expect(screen.queryByTestId('runtime-execution-detail-overlay')).not.toBeInTheDocument()
  })

  it('exposes the current AI manager execution to the workflow summary', async () => {
    runtimeWorkMock.value = {
      projects: [],
      chats: [],
      totalTasks: 0,
    }
    const managerMessage: ProjectChatMessage = {
      ...agentMessage,
      messageId: 'manager-message-1',
      type: 'agent_status',
      content: '',
      metadata: {
        kind: 'project_automation_run',
        automation_run_id: 'manager-run-1',
        run_id: 'manager-run-1',
        run_status: 'queued',
      },
      status: 'pending',
      runtimeAddress: { deviceId: 'device-1', taskId: 'manager-runtime-1' },
    }
    const previousManagerMessage: ProjectChatMessage = {
      ...managerMessage,
      messageId: 'manager-message-previous',
      status: 'completed',
      runtimeAddress: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [previousManagerMessage, managerMessage],
          latestSequence: 3,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    const onWorkflowManagerExecutionChange = vi.fn()

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            status: 'in_progress',
            assignee_agent_id: '12',
          } as never
        }
        workflowManagerRunId="manager-run-1"
        onWorkflowManagerExecutionChange={onWorkflowManagerExecutionChange}
        linear
      />
    )

    await waitFor(() =>
      expect(onWorkflowManagerExecutionChange).toHaveBeenLastCalledWith(expect.any(Function))
    )
    const openExecution = [...onWorkflowManagerExecutionChange.mock.calls]
      .reverse()
      .map(call => call[0])
      .find(candidate => typeof candidate === 'function')
    act(() => openExecution())

    expect(screen.getByTestId('runtime-execution-detail-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-execution-detail-status')).toHaveTextContent('排队中')
  })

  it('refreshes the workflow plan when the AI manager finishes', async () => {
    const managerMessage: ProjectChatMessage = {
      ...agentMessage,
      messageId: 'manager-message-completed',
      type: 'text',
      content: '方案已成功提交，正在等待审批。',
      metadata: {
        kind: 'project_automation_run',
        automation_run_id: 'manager-run-1',
        run_id: 'manager-run-1',
        run_status: 'completed',
      },
      status: 'completed',
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [managerMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    const onWorkflowManagerFinished = vi.fn()

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={{ id: 'WEG-1', title: 'Inspect changes', status: 'in_progress' } as never}
        workflowManagerRunId="manager-run-1"
        onWorkflowManagerFinished={onWorkflowManagerFinished}
        linear
      />
    )

    await waitFor(() => expect(onWorkflowManagerFinished).toHaveBeenCalledTimes(1))
  })

  it('shows the stop action for a running AI run inside the floating panel', async () => {
    runtimeWorkMock.value = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          projectId: null,
          tasks: [{ taskId: 'runtime-task-2', title: 'Managed execution' }],
        },
      ],
      totalTasks: 1,
    }
    const user = userEvent.setup()
    const runningAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'agent_chunk',
      content: 'working…',
      metadata: { run_id: 'run-456' },
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-2' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [runningAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.click(await screen.findByTestId('cloud-task-activity-open-execution-message-2'))

    const stopButton = await screen.findByTestId('runtime-execution-detail-stop')
    expect(stopButton).toBeInTheDocument()
    await user.click(stopButton)
    await waitFor(() =>
      expect(cancelRuntimeTask).toHaveBeenCalledWith({
        deviceId: 'device-1',
        taskId: 'runtime-task-2',
      })
    )
  })

  it('does not expose execution details for an address absent from runtime work', async () => {
    runtimeWorkMock.value = { projects: [], chats: [], totalTasks: 0 }
    const message: ProjectChatMessage = {
      ...agentMessage,
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'missing-runtime-task' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [message], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={{ id: 'WEG-1', title: 'Inspect', status: 'in_progress', version: 1 } as never}
      />
    )

    expect(await screen.findByTestId('cloud-task-activity-message-message-2')).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-task-activity-open-execution-message-2')
    ).not.toBeInTheDocument()
  })

  function sendButtonFor(composerTestId: string) {
    const composer = screen.getByTestId(composerTestId)
    const form = composer.closest('form')
    return within(form as HTMLElement).getByRole('button', { name: '发送消息' })
  }

  it('continues the card AI session from the inline composer', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: '已检查当前改动，发现 2 处问题。',
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
      rootMessageId: userMessage.messageId,
      replyToMessageId: userMessage.messageId,
    }
    const attachment: Attachment = {
      id: 7,
      filename: 'spec.txt',
      file_size: 12,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'txt',
      created_at: '2026-08-06T00:00:00Z',
    }
    attachmentSelectionMock.attachments = [attachment]
    sendRuntimePaneMessage.mockResolvedValue(true)
    runtimeWorkMock.value = {
      projects: [
        {
          project: { id: 91, name: '运营工作区' },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              projectId: 91,
              tasks: [{ taskId: 'parent-session-1', title: '执行任务' }],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [rootMessage, completedAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    runtimeWorkMock.value = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          projectId: null,
          tasks: [{ taskId: 'parent-session-1', title: '执行任务' }],
        },
      ],
      totalTasks: 1,
    }
    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    expect(
      screen.queryByTestId(`cloud-task-activity-reply-${completedAgentMessage.messageId}`)
    ).not.toBeInTheDocument()
    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '继续处理{Enter}'
    )

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: rootMessage.messageId,
      })
    )
    await waitFor(() =>
      expect(sendRuntimePaneMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          address: { deviceId: 'device-1', taskId: 'parent-session-1' },
          message: '继续处理',
          attachmentIds: [7],
        }),
        expect.anything()
      )
    )
    expect(createProjectRuntimeTask).not.toHaveBeenCalled()
  })

  it('continues a Wegent board Task without creating a local runtime task', async () => {
    agentsMock.value = [
      {
        ...agentsMock.value[0],
        runtime: 'wegent',
        wegentTeamId: 32,
      },
    ]
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...agentMessage,
      messageId: 'wegent-result-1',
      content: '请确认下一步。',
      metadata: {
        execution_id: 229,
        executor_type: 'wegent_team',
        backend_task_id: 288,
      },
      status: 'completed',
      rootMessageId: null,
      runtimeAddress: null,
    }
    const triggerMessage: ProjectChatMessage = {
      ...userMessage,
      sequenceNumber: 3,
      messageId: 'confirmation-1',
      content: '确认',
      replyToMessageId: rootMessage.messageId,
      rootMessageId: rootMessage.messageId,
    }
    const continuationMessage: ProjectChatMessage = {
      ...agentMessage,
      sequenceNumber: 4,
      messageId: 'wegent-continuation-1',
      metadata: {
        execution_id: 229,
        executor_type: 'wegent_team',
        backend_task_id: 288,
        backend_subtask_id: 301,
      },
      triggerMessageId: triggerMessage.messageId,
      replyToMessageId: triggerMessage.messageId,
      rootMessageId: rootMessage.messageId,
      runtimeAddress: null,
      status: 'pending',
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => triggerMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      continueWegentTask: vi.fn(async () => continuationMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            status: 'in_review',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '确认{Enter}'
    )

    await waitFor(() => expect(client.continueWegentTask).toHaveBeenCalledOnce())
    expect(client.continueWegentTask).toHaveBeenCalledWith({
      projectId: '11',
      taskId: 'WEG-1',
      triggerMessageId: 'confirmation-1',
      agentId: '12',
      attachmentIds: [],
    })
    expect(createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(
      await screen.findByTestId('cloud-task-activity-message-wegent-continuation-1')
    ).toBeInTheDocument()
  })

  it('continues a custom AI manager from its own comment session', async () => {
    agentsMock.value = [
      {
        ...agentsMock.value[0],
        runtime: 'wegent',
        wegentTeamId: 32,
      },
    ]
    const user = userEvent.setup()
    const managerMessage: ProjectChatMessage = {
      ...agentMessage,
      messageId: 'manager-result-1',
      sender: {
        type: 'agent',
        id: 'automation_manager:rule-1',
        name: '自定义 AI 调度员',
      },
      content: '已完成分派。',
      metadata: {
        kind: 'project_automation_run',
        manager_type: 'custom',
        executor_type: 'automation_manager',
        execution_id: 301,
        run_status: 'completed',
      },
      status: 'completed',
      rootMessageId: null,
      runtimeAddress: { deviceId: 'local-device', taskId: 'manager-runtime-1' },
      agentId: null,
    }
    const triggerMessage: ProjectChatMessage = {
      ...userMessage,
      messageId: 'manager-question-1',
      content: '任务完成了吗？',
      replyToMessageId: managerMessage.messageId,
      rootMessageId: managerMessage.messageId,
    }
    const managerReply: ProjectChatMessage = {
      ...agentMessage,
      messageId: 'manager-reply-1',
      sender: managerMessage.sender,
      content: '',
      metadata: {
        kind: 'automation_manager_continuation',
        manager_type: 'custom',
        conversation_only: true,
        run_status: 'running',
      },
      triggerMessageId: triggerMessage.messageId,
      replyToMessageId: triggerMessage.messageId,
      rootMessageId: managerMessage.messageId,
      runtimeAddress: managerMessage.runtimeAddress,
      status: 'streaming',
      agentId: null,
    }
    runtimeWorkMock.value = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          projectId: null,
          tasks: [{ taskId: 'manager-runtime-1', title: 'AI 调度员' }],
        },
      ],
      totalTasks: 1,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [managerMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => triggerMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...managerReply, status: 'failed' as const })),
      continueAutomationManager: vi.fn(async () => managerReply),
      continueWegentTask: vi.fn(async () => agentMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            status: 'in_progress',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        taskBindings={[
          {
            id: 9,
            cloud_project_id: '11',
            loop_item_id: 'WEG-1',
            task_user_id: 1,
            device_id: 'local-device',
            task_id: 'manager-runtime-1',
            task_title: 'Inspect changes',
            backend_task_id: null,
            workflow_node_id: null,
            linked_at: '2026-08-24T08:00:00Z',
          },
        ]}
        linear
      />
    )

    expect(
      await screen.findByTestId(`cloud-task-activity-message-${managerMessage.messageId}`)
    ).toHaveTextContent('自定义 AI 调度员')
    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${managerMessage.messageId}`),
      '任务完成了吗？{Enter}'
    )

    await waitFor(() => expect(client.continueAutomationManager).toHaveBeenCalledOnce())
    expect(client.continueAutomationManager).toHaveBeenCalledWith({
      projectId: '11',
      taskId: 'WEG-1',
      triggerMessageId: 'manager-question-1',
      managerMessageId: 'manager-result-1',
    })
    expect(client.continueWegentTask).not.toHaveBeenCalled()
    expect(client.startAgentResponse).not.toHaveBeenCalled()
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: [],
        replyToMessageId: 'manager-result-1',
      })
    )
    await waitFor(() =>
      expect(sendRuntimePaneMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          address: { deviceId: 'local-device', taskId: 'manager-runtime-1' },
          message: '任务完成了吗？',
        }),
        expect.anything()
      )
    )
    expect(
      await screen.findByTestId(`cloud-task-activity-message-${managerReply.messageId}`)
    ).toHaveTextContent('自定义 AI 调度员')
  })

  it('replies to the parent comment from the card composer by default', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: '已检查当前改动。',
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
      rootMessageId: userMessage.messageId,
      replyToMessageId: userMessage.messageId,
    }
    sendRuntimePaneMessage.mockResolvedValue(true)
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [rootMessage, completedAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '直接回复父评论{Enter}'
    )

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: rootMessage.messageId,
      })
    )
    expect(
      screen.queryByTestId(`cloud-task-activity-reply-chip-${rootMessage.messageId}`)
    ).not.toBeInTheDocument()
  })

  it('shows a send button on the card composer only after typing', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const composer = await screen.findByTestId(
      `cloud-task-activity-card-composer-${rootMessage.messageId}`
    )
    // Keep the AI start pending so the test proves the draft clears right
    // after the comment is sent, without waiting for the runtime task.
    createProjectRuntimeTask.mockReturnValue(new Promise(() => {}))
    expect(
      screen.queryByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`)
    ).not.toBeInTheDocument()

    await user.type(composer, '继续处理')
    expect(
      screen.getByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`)
    ).toBeInTheDocument()

    await user.click(screen.getByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`))
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '继续处理',
        replyToMessageId: rootMessage.messageId,
      })
    )
    await waitFor(() => expect(composer).toHaveValue(''))
  })

  it('passes comment attachments to the AI run', async () => {
    const user = userEvent.setup()
    const attachment: Attachment = {
      id: 7,
      filename: 'spec.txt',
      file_size: 12,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'txt',
      created_at: '2026-08-06T00:00:00Z',
    }
    attachmentSelectionMock.attachments = [attachment]
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(await screen.findByTestId('cloud-task-activity-composer'), '看下附件')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '看下附件',
        expect.objectContaining({ attachments: [attachment] })
      )
    )
    expect(attachmentSelectionMock.resetAttachments).toHaveBeenCalledOnce()
  })

  it('skips the runtime-task start when the chat client manages execution', async () => {
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        selfManagedExecution
        linear
      />
    )

    await user.type(await screen.findByTestId('cloud-task-activity-composer'), '本地跑一下')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(createProjectRuntimeTask).not.toHaveBeenCalled()
  })

  it('passes attachments from the card composer to the AI run', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const attachment: Attachment = {
      id: 8,
      filename: 'notes.txt',
      file_size: 24,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'txt',
      created_at: '2026-08-06T00:00:00Z',
    }
    attachmentSelectionMock.attachments = [attachment]
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const composer = await screen.findByTestId(
      `cloud-task-activity-card-composer-${rootMessage.messageId}`
    )
    expect(
      screen.getByTestId(`cloud-task-activity-card-attach-${rootMessage.messageId}`)
    ).toBeInTheDocument()
    expect(
      screen.getByTestId(`cloud-task-activity-card-attachment-${rootMessage.messageId}-8`)
    ).toHaveTextContent('notes.txt')

    await user.type(composer, '看下附件')
    await user.click(screen.getByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '看下附件',
        expect.objectContaining({ attachments: [attachment] })
      )
    )
    await waitFor(() => expect(composer).toHaveValue(''))
  })

  it('uploads files pasted into the card composer', async () => {
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const composer = await screen.findByTestId(
      `cloud-task-activity-card-composer-${rootMessage.messageId}`
    )
    const file = new File(['clipboard-image'], 'clip.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [file] },
    })

    fireEvent(composer, pasteEvent)

    expect(attachmentSelectionMock.handleFileSelect).toHaveBeenCalledWith([file])
  })

  it('uploads files selected through the card composer attach button', async () => {
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`)
    const fileInput = screen.getByTestId(`cloud-task-activity-card-file-${rootMessage.messageId}`)
    const file = new File(['report-content'], 'report.pdf', { type: 'application/pdf' })

    fireEvent.change(fileInput, { target: { files: [file] } })

    expect(attachmentSelectionMock.handleFileSelect).toHaveBeenCalledWith([file])
  })

  it('starts a fresh session for a plain new comment even when the task has a previous binding', async () => {
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
            ai_state: {
              status: 'completed',
              runtime_device_id: 'device-1',
              runtime_task_id: 'old-session-1',
            },
          } as never
        }
      />
    )

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(sendButtonFor('cloud-task-activity-composer'))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '新评论',
      expect.objectContaining({
        cloudProjectId: '11',
        origin: {
          type: 'board_comment',
          cloudProjectId: '11',
          loopItemId: 'WEG-1',
          rootCommentId: userMessage.messageId,
        },
      })
    )
  })

  it('queues a card reply while its session is running and sends it after completion', async () => {
    const user = userEvent.setup()
    let emitMessage: ((message: ProjectChatMessage) => void) | null = null
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const runningAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: 'working…',
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
      rootMessageId: userMessage.messageId,
      replyToMessageId: userMessage.messageId,
    }
    const client = {
      subscribe: vi.fn(async (_projectId, _taskId, _afterSequence, onMessage) => {
        emitMessage = onMessage
        return {
          snapshot: {
            messages: [rootMessage, runningAgentMessage],
            latestSequence: 2,
            currentUserId: '1',
          },
          unsubscribe: vi.fn(),
        }
      }),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    runtimeWorkMock.value = {
      projects: [
        {
          project: { id: 91, name: '运营工作区' },
          deviceWorkspaces: [
            {
              deviceId: 'device-1',
              projectId: 91,
              tasks: [{ taskId: 'parent-session-1', title: '执行任务' }],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '继续处理{Enter}'
    )

    expect(client.send).not.toHaveBeenCalled()
    expect(
      within(
        screen.getByTestId(`cloud-task-activity-card-queue-${rootMessage.messageId}`)
      ).getByText('继续处理')
    ).toBeInTheDocument()

    emitMessage?.({ ...runningAgentMessage, status: 'completed' })

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { deviceId: 'device-1', taskId: 'parent-session-1' },
        message: '继续处理',
      }),
      expect.any(Object)
    )
    await waitFor(() =>
      expect(
        within(
          screen.getByTestId(`cloud-task-activity-card-queue-${rootMessage.messageId}`)
        ).queryByText('继续处理')
      ).not.toBeInTheDocument()
    )
  })

  it('allows a plain new comment while another parent session is still running', async () => {
    const user = userEvent.setup()
    const runningAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: 'working…',
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [userMessage, runningAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '新评论',
      expect.objectContaining({ cloudProjectId: '11' })
    )
  })

  it('shows approve/reject for the robot creator and approves the pending run', async () => {
    const user = userEvent.setup()
    approveLoopItemRun.mockResolvedValue({
      id: 'WEG-1',
      title: 'Inspect changes',
      description: '',
      status: 'in_review',
      version: 2,
      assignee_agent_id: '12',
      execution_state: 'queued',
    })
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_review',
            version: 3,
            assignee_agent_id: '12',
            execution_state: 'waiting_approval',
          } as never
        }
      />
    )

    expect(await screen.findByTestId('cloud-task-activity-approve-WEG-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-task-activity-reject-WEG-1')).toBeInTheDocument()
    await user.click(await screen.findByTestId('cloud-task-activity-approve-WEG-1'))
    await waitFor(() => expect(approveLoopItemRun).toHaveBeenCalledWith('11', 'WEG-1', 3))
  })

  it('hides approve/reject for a viewer who is not the robot creator', async () => {
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '2' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={2}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_review',
            version: 3,
            assignee_agent_id: '12',
            execution_state: 'waiting_approval',
          } as never
        }
      />
    )

    await screen.findByTestId('cloud-task-activity-execution-status-WEG-1')
    expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-task-activity-approve-WEG-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-task-activity-reject-WEG-1')).not.toBeInTheDocument()
    const status = screen.getByTestId('cloud-task-activity-execution-status-WEG-1')
    expect(status).toHaveAttribute('data-status', 'waiting_approval')
    expect(status).toHaveAccessibleName('待 Alice 批准')
  })

  it('shows approve/reject when the backend marks the run as approvable by the current user', async () => {
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_review',
            version: 3,
            assignee_agent_id: '12',
            execution_state: 'waiting_approval',
            can_approve: true,
          } as never
        }
      />
    )

    await screen.findByTestId('cloud-task-activity-execution-status-WEG-1')
    expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-task-activity-approve-WEG-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-task-activity-reject-WEG-1')).toBeInTheDocument()
    expect(screen.queryByText('待 Alice 批准')).not.toBeInTheDocument()
  })

  it('shows the execution failed badge and error reason', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_review',
            version: 3,
            assignee_agent_id: '12',
            execution_state: 'failed',
            execution_error: 'Device went offline before dispatch',
          } as never
        }
      />
    )

    await screen.findByTestId('cloud-task-activity-execution-status-WEG-1')
    expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument()
    const status = screen.getByTestId('cloud-task-activity-execution-status-WEG-1')
    expect(status).toHaveAttribute('data-status', 'failed')
    expect(status).toHaveAccessibleName('执行失败')
    await user.click(status)
    expect(screen.getByTestId('cloud-task-activity-execution-error-WEG-1')).toHaveTextContent(
      'Device went offline before dispatch'
    )
    await user.click(screen.getByRole('button', { name: '复制执行详情' }))
    expect(writeText).toHaveBeenCalledWith(
      '状态: 执行失败\n错误: Device went offline before dispatch'
    )
  })
})
