import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  CollaborationApp,
  CollaborationIssue,
  SharedWorkspaceApi,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { useState, type ComponentProps } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatModal } from './AiChatModal'
import type { CloudTodoBoardCard } from './CloudTodoBoardCard'
import type { TodoEditor } from './TodoEditor'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'

const chatCallbacks = vi.hoisted(
  () => new Map<string, ComponentProps<typeof AiChatModal>['onAddressChange']>()
)
const chatPreparations = vi.hoisted(
  () => new Map<string, ComponentProps<typeof AiChatModal>['prepareTask']>()
)
const chatCompletions = vi.hoisted(
  () => new Map<string, ComponentProps<typeof AiChatModal>['onTaskCreated']>()
)

const issue = {
  id: 'TEST-1',
  sequence_number: 1,
  title: 'Execute pwd',
  status: 'pending',
  can_edit: true,
} as CollaborationIssue
let taskBindings: WorkspaceTaskBinding[] = []
let boardColumnKeys = ['pending']
let chatMountCount = 0
let latestExecutionEnvironment: ComponentProps<
  typeof WeworkSharedProject
>['project']['execution_environment']
const getAnimations = vi.fn((): Partial<Animation>[] => [])
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: getAnimations,
  })
})
beforeEach(() => {
  chatCallbacks.clear()
  chatPreparations.clear()
  chatCompletions.clear()
  getAnimations.mockReset().mockReturnValue([])
  taskBindings = []
  boardColumnKeys = ['pending']
  chatMountCount = 0
  latestExecutionEnvironment = undefined
  issue.human_task_binding = undefined
})
afterAll(() => {
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, 'getAnimations', originalGetAnimations)
  } else {
    Reflect.deleteProperty(Element.prototype, 'getAnimations')
  }
})

function startMotion() {
  let resolve!: () => void
  let reject!: () => void
  const finished = new Promise<Animation>((done, cancel) => {
    resolve = () => done({} as Animation)
    reject = () => cancel(new DOMException('Transition cancelled', 'AbortError'))
  })
  getAnimations.mockReturnValue([{ finished }])
  return {
    finish: async () => {
      await act(async () => {
        getAnimations.mockReturnValue([])
        resolve()
      })
    },
    cancel: async () => {
      await act(async () => {
        getAnimations.mockReturnValue([])
        reject()
      })
    },
  }
}

vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  CollaborationApp: (props: ComponentProps<typeof CollaborationApp>) => (
    <>
      <button onClick={() => props.host.navigate({ ...props.host.location, issueId: issue.id })}>
        Open Issue
      </button>
      <button onClick={() => props.host.navigate({ ...props.host.location, issueId: 'TEST-2' })}>
        Open another Issue
      </button>
      <button
        data-testid="save-execution-environment"
        onClick={async () => {
          const initialProject = props.initialProject
          if (!initialProject) throw new Error('The fixture requires an initial project')
          const updatedProject = await props.api.projects.get(String(initialProject.id))
          props.onProjectChange?.({ ...initialProject, ...updatedProject })
        }}
      >
        Save execution environment
      </button>
      <button
        data-testid="create-issue-without-environment"
        onClick={() => {
          props.host.notify?.('请先完成项目执行环境初始化，再创建 Issue。', 'error')
          props.host.navigate({
            ...props.host.location,
            issueId: null,
            view: 'manage',
            projectSettingsSection: 'environments',
          })
        }}
      >
        Create Issue without environment
      </button>
      {boardColumnKeys.map(key => (
        <div key={key}>
          {props.renderBoardIssueCard?.({
            column: { key, groupValue: key, label: key, status: '', dotClass: '' },
            defaultCard: null,
            issue,
            taskBindings,
            display: {} as never,
            focused: false,
            onOpen: () => props.host.navigate({ ...props.host.location, issueId: issue.id }),
            onMarkRead: vi.fn(),
            previewDisabled: Boolean(props.host.location.issueId),
          })}
        </div>
      ))}
      {props.host.location.issueId &&
        props.renderIssueDetail?.({
          api: props.api,
          project: { id: 'project' } as never,
          issue: { ...issue, id: props.host.location.issueId },
          allIssues: [issue],
          assignments: [],
          taskBindings,
          onChange: vi.fn(),
          onCreateTask: () =>
            props.onCreateTask?.(
              {
                ...props.initialProject,
                ...(latestExecutionEnvironment
                  ? { execution_environment: latestExecutionEnvironment }
                  : {}),
              } as never,
              issue
            ),
          onClose: () => props.host.navigate({ ...props.host.location, issueId: null }),
        })}
    </>
  ),
}))

vi.mock('./CloudTodoBoardCard', () => ({
  CloudTodoBoardCard: (props: ComponentProps<typeof CloudTodoBoardCard>) => {
    const [localPreviewPinned, setLocalPreviewPinned] = useState(false)
    const previewPinned = props.previewPinned ?? localPreviewPinned
    return (
      <>
        <button onClick={props.onClick}>Open project card</button>
        <button onClick={props.issueDetailOnly ? props.onClick : undefined}>Open task area</button>
        <button
          disabled={props.previewDisabled || props.issueDetailOnly}
          onClick={() => {
            setLocalPreviewPinned(true)
            props.onPreviewPinnedChange?.(true)
          }}
        >
          Open progress
        </button>
        {previewPinned && !props.previewDisabled && !props.issueDetailOnly && (
          <div>Board progress preview</div>
        )}
      </>
    )
  },
}))

vi.mock('./TodoEditor', () => ({
  TodoEditor: (props: ComponentProps<typeof TodoEditor>) => {
    const [draft, setDraft] = useState('')
    return (
      <section
        data-testid="cloud-todo-detail"
        data-issue-id={props.item?.id}
        data-has-global-team-directory={props.teamApi ? 'true' : 'false'}
        data-read-first={props.readFirst ? 'true' : 'false'}
        data-selected-task-id={props.selectedTaskId ?? ''}
        data-task-status={props.taskExecutionStates?.['binding-1']?.status ?? ''}
        data-current-user-id={props.currentUserId}
        data-archive-label={props.deleteLabel}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            ;(props.onEscape ?? props.onClose)()
          }
        }}
      >
        <button data-testid="cloud-todo-detail-close" onClick={props.onClose}>
          Close Issue
        </button>
        <textarea
          aria-label="Issue draft"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <div data-testid="cloud-todo-detail-scroll" />
        <div data-testid="cloud-todo-detail-device-name">{props.deviceNamesById?.device ?? ''}</div>
        {props.onCreateTask && <button onClick={() => props.onCreateTask?.()}>Add task</button>}
        {['run-1', 'run-2'].map(taskId => (
          <button
            key={taskId}
            onClick={() =>
              props.onOpenTaskConversation?.({
                device_id: 'device',
                task_id: taskId,
              } as never)
            }
          >
            {taskId}
          </button>
        ))}
      </section>
    )
  },
}))

vi.mock('./AiChatModal', () => ({
  AiChatModal: (props: ComponentProps<typeof AiChatModal>) => {
    // Like the real composer, the conversation address is initialized on mount.
    const [address] = useState(props.initialAddress)
    const [mountId] = useState(() => ++chatMountCount)
    chatCallbacks.set(address?.taskId ?? 'new', props.onAddressChange)
    chatPreparations.set(address?.taskId ?? 'new', props.prepareTask)
    chatCompletions.set(address?.taskId ?? 'new', props.onTaskCreated)
    return (
      <aside
        data-testid="ai-chat-modal"
        data-address={props.initialAddress?.taskId}
        data-device-id={props.initialTaskRequest?.deviceId}
        data-initial-input={props.initialTaskInput}
        data-mount-id={mountId}
        data-workspace-path={props.initialTaskRequest?.workspacePath}
        data-origin={JSON.stringify(props.initialTaskRequest?.origin)}
      >
        <span>Conversation: {address?.taskId}</span>
        <button data-testid="ai-chat-modal-close" onClick={props.onClose}>
          Close conversation
        </button>
      </aside>
    )
  },
}))

function Project({
  executionEnvironment,
  runtimeWork,
  runtimePort = { bindTask: vi.fn(), unbindTask: vi.fn() },
  issues,
}: {
  executionEnvironment?: ComponentProps<
    typeof WeworkSharedProject
  >['project']['execution_environment']
  runtimeWork?: ComponentProps<typeof WeworkSharedProject>['runtimeWork']
  runtimePort?: ComponentProps<typeof WeworkSharedProject>['runtimePort']
  issues?: Pick<SharedWorkspaceApi['issues'], 'get' | 'update'>
} = {}) {
  const [location, setLocation] = useState<ComponentProps<typeof WeworkSharedProject>['location']>({
    platformView: 'spaces',
    workspaceId: 'workspace',
    workspaceView: 'projects',
    projectId: 'project',
    projectView: 'board',
    issueId: null,
  })
  return (
    <WeworkSharedProject
      api={
        {
          projects: {
            get: vi.fn(async () => ({
              id: 'project',
              execution_environment: latestExecutionEnvironment ?? executionEnvironment,
            })),
            listExecutionEnvironments: vi.fn(async () => [
              {
                id: 'environment-22',
                device_id: 22,
                device_key: 'shared-runtime-device',
                name: 'Shared runtime',
                kind: 'cloud_host',
                coding_tools: ['codex'],
                owner_type: 'workspace',
                owner_id: 'workspace',
                owner_name: 'Workspace',
                status: 'online',
                updated_at: '2026-09-21T00:00:00Z',
              },
            ]),
          },
          issues: issues ?? {
            get: vi.fn(async () => ({ ...issue, tags: [], version: 1 })),
            update: vi.fn(async (_id, update) => ({ ...issue, ...update, version: 2 })),
          },
          taskBindings: {
            list: vi.fn(async () =>
              ['run-1', 'run-2'].map(taskId => ({
                id: `binding-${taskId}`,
                projectId: 'project',
                issueId: issue.id,
                taskUserId: 9001,
                deviceId: 'device',
                taskId,
                backendTaskId: null,
                linkedAt: '2026-09-20T00:00:00Z',
              }))
            ),
          },
        } as never
      }
      project={
        {
          id: 'project',
          project_key: 'TEST',
          name: 'Project',
          project_store: 'backend',
          current_user_id: 1,
          // The shell snapshot can predate settings saved inside CollaborationApp.
          execution_environment: undefined,
        } as never
      }
      workspace={{ id: 'workspace' } as never}
      localProjects={[]}
      locale="zh-CN"
      location={location}
      setLocation={setLocation}
      services={
        {
          teamApi: { listTeams: vi.fn(async () => []) },
          standInApi: {
            deviceIdentity: vi.fn(async () => ({ backendDeviceId: 'device' })),
            readTask: vi.fn(async () => ({ success: true })),
          },
        } as never
      }
      runtimeWork={runtimeWork}
      runtimePort={runtimePort}
      sendRuntimePaneMessage={vi.fn(async () => true)}
      userId={9001}
    />
  )
}

describe('Wework Issue conversation drawers', () => {
  it('binds before execution and advances the Issue only after task creation is accepted', async () => {
    const source = { ...issue, tags: [], version: 3 }
    let finishUpdate!: (value: typeof source) => void
    const update = new Promise<typeof source>(resolve => {
      finishUpdate = resolve
    })
    const issues = {
      get: vi.fn(async () => source),
      update: vi.fn(() => update),
    }
    const runtimePort = { bindTask: vi.fn(), unbindTask: vi.fn() }
    render(<Project issues={issues} runtimePort={runtimePort} />)
    await userEvent.click(screen.getByText('Open Issue'))
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))
    const address = { deviceId: 'device', taskId: 'prepared-task' }
    let prepared = false
    const preparation = Promise.resolve(chatPreparations.get('new')!(address, null)).then(
      rollback => {
        prepared = true
        return rollback
      }
    )
    await act(async () => {
      await preparation
    })
    expect(runtimePort.bindTask).toHaveBeenCalledOnce()
    expect(prepared).toBe(true)
    expect(issues.get).not.toHaveBeenCalled()
    expect(issues.update).not.toHaveBeenCalled()
    const completion = chatCompletions.get('new')!(address, null, null)
    await waitFor(() =>
      expect(issues.update).toHaveBeenCalledWith(issue.id, {
        version: 3,
        status: 'in_progress',
      })
    )
    await act(async () => {
      finishUpdate({ ...source, status: 'in_progress', version: 4 })
      await completion
    })
    expect(prepared).toBe(true)
    expect(issues.get).toHaveBeenCalledOnce()
    expect(issues.update).toHaveBeenCalledOnce()
    const rollback = await preparation
    await act(async () => {
      if (rollback) await rollback()
    })
    expect(runtimePort.unbindTask).toHaveBeenCalledOnce()
  })

  it('leaves the Issue untouched when a prepared execution is rolled back without acceptance', async () => {
    const issues = { get: vi.fn(), update: vi.fn() }
    const runtimePort = { bindTask: vi.fn(), unbindTask: vi.fn() }
    render(<Project issues={issues} runtimePort={runtimePort} />)
    await userEvent.click(screen.getByText('Open Issue'))
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await act(async () => {
      const rollback = await chatPreparations.get('new')!(
        { deviceId: 'device', taskId: 'rejected-task' },
        null
      )
      await rollback?.()
    })
    expect(runtimePort.bindTask).toHaveBeenCalledOnce()
    expect(runtimePort.unbindTask).toHaveBeenCalledOnce()
    expect(issues.get).not.toHaveBeenCalled()
    expect(issues.update).not.toHaveBeenCalled()
  })

  it('does not update the Issue when binding the task is denied', async () => {
    const issues = { get: vi.fn(), update: vi.fn() }
    const runtimePort = {
      bindTask: vi.fn().mockRejectedValue(new Error('Task binding denied')),
      unbindTask: vi.fn(),
    }
    render(<Project issues={issues} runtimePort={runtimePort} />)
    await userEvent.click(screen.getByText('Open Issue'))
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await expect(
      chatPreparations.get('new')!({ deviceId: 'device', taskId: 'prepared-task' }, null)
    ).rejects.toThrow('Task binding denied')
    expect(issues.get).not.toHaveBeenCalled()
    expect(issues.update).not.toHaveBeenCalled()
  })

  it('keeps the assignee directory scoped to the current project', async () => {
    render(<Project />)

    await userEvent.click(screen.getByText('Open Issue'))

    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute(
      'data-has-global-team-directory',
      'false'
    )
  })

  it('lets the personal task composer choose the current computer', async () => {
    taskBindings = [
      {
        id: 'binding-existing',
        projectId: 'project',
        issueId: issue.id,
        taskUserId: 1,
        deviceId: 'previous-device',
        taskId: 'previous-task',
        taskTitle: 'Previous execution',
        backendTaskId: null,
        linkedAt: '2026-09-20T00:00:00Z',
      },
    ]
    const user = userEvent.setup()
    render(
      <Project
        executionEnvironment={{
          repositories: [],
          setup_steps: [],
          devices: {
            'shared-runtime-device': {
              status: 'ready',
              workspace_path: '/srv/collaboration/project',
            },
          },
        }}
      />
    )

    await user.click(screen.getByText('Open Issue'))
    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute('data-current-user-id', '1')
    await user.click(screen.getByRole('button', { name: 'Add task' }))

    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-device-id')
    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-workspace-path')
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-initial-input',
      '[$TEST-1 · Execute pwd](wework-issue://project/TEST-1)'
    )
  })

  it('can start the first task without an existing task binding', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    expect(screen.getByTestId('ai-chat-modal')).toBeInTheDocument()
  })

  it('keeps human AI assistance on the current computer while preserving its assignment binding', async () => {
    const binding = {
      humanAssignmentId: 'human-assignment-1',
      dispatchId: 'dispatch-1',
      dispatchRoundId: 'round-1',
      assignmentId: 'assignment-1',
    }
    issue.human_task_binding = binding
    render(
      <Project
        executionEnvironment={{
          repositories: [],
          setup_steps: [],
          devices: {
            'shared-runtime-device': {
              status: 'ready',
              workspace_path: '/srv/collaboration/project',
            },
          },
        }}
      />
    )
    latestExecutionEnvironment = {
      repositories: [],
      setup_steps: [],
      devices: {
        'shared-runtime-device': {
          status: 'ready',
          workspace_path: '/srv/collaboration/fresh-environment',
        },
      },
    }
    const user = userEvent.setup()
    await user.click(screen.getByText('Save execution environment'))
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'Add task' }))

    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-device-id')
    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-workspace-path')
    expect(JSON.parse(screen.getByTestId('ai-chat-modal').getAttribute('data-origin')!)).toEqual({
      type: 'issue_dispatch',
      cloudProjectId: 'project',
      loopItemId: issue.id,
      dispatchId: binding.dispatchId,
      roundId: binding.dispatchRoundId,
      assignmentId: binding.assignmentId,
      humanAssignmentId: binding.humanAssignmentId,
    })
  })

  it('can start another task after returning from an existing execution', async () => {
    taskBindings = [
      {
        id: 'binding-1',
        projectId: 'project',
        issueId: issue.id,
        taskUserId: 1,
        deviceId: 'device',
        taskId: 'run-1',
        taskTitle: 'Existing execution',
        backendTaskId: null,
        linkedAt: '2026-09-18T00:00:00Z',
      },
    ]
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    await user.click(screen.getByTestId('ai-chat-modal-close'))
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-address')
    expect(screen.getByTestId('issue-conversation-drawers')).toHaveAttribute(
      'data-has-conversation',
      'true'
    )
  })

  it('finishes exit when reduced motion cancels the transition', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    const motion = startMotion()
    await user.click(screen.getByTestId('ai-chat-modal-close'))
    await motion.cancel()
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
  })
})
