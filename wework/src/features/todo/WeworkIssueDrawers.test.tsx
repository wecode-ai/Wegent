import '@/i18n'
import { useState, type ComponentProps } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CollaborationApp,
  CollaborationIssue,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'
import type { TodoEditor } from './TodoEditor'
import type { AiChatModal } from './AiChatModal'
import type { CloudTodoBoardCard } from './CloudTodoBoardCard'

const chatCallbacks = vi.hoisted(
  () => new Map<string, ComponentProps<typeof AiChatModal>['onAddressChange']>()
)
const chatPreparations = vi.hoisted(
  () => new Map<string, ComponentProps<typeof AiChatModal>['prepareTask']>()
)

const issue = {
  id: 'TEST-1',
  sequence_number: 1,
  title: 'Execute pwd',
  status: 'pending',
  can_edit: true,
} as CollaborationIssue
let taskBindings: WorkspaceTaskBinding[] = []
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
  getAnimations.mockReset().mockReturnValue([])
  taskBindings = []
  chatMountCount = 0
  latestExecutionEnvironment = undefined
  issue.human_work = undefined
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
      {props.renderBoardIssueCard?.({
        issue,
        taskBindings,
        display: {} as never,
        focused: false,
        onOpen: () => props.host.navigate({ ...props.host.location, issueId: issue.id }),
        onMarkRead: vi.fn(),
        previewDisabled: Boolean(props.host.location.issueId),
      })}
      {props.host.location.issueId &&
        props.renderIssueDetail?.({
          api: props.api,
          project: { id: 'project' } as never,
          issue,
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
}: {
  executionEnvironment?: ComponentProps<
    typeof WeworkSharedProject
  >['project']['execution_environment']
  runtimeWork?: ComponentProps<typeof WeworkSharedProject>['runtimeWork']
  runtimePort?: ComponentProps<typeof WeworkSharedProject>['runtimePort']
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
          issues: {},
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
  it('keeps the missing environment explanation visible after opening environment settings', async () => {
    render(<Project />)

    await userEvent.click(screen.getByTestId('create-issue-without-environment'))

    expect(screen.getByTestId('transient-notice')).toHaveTextContent(
      '请先完成项目执行环境初始化，再创建 Issue。'
    )
  })

  it('opens an editable Issue without the read-first content lock', async () => {
    render(<Project />)

    await userEvent.click(screen.getByText('Open Issue'))
    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute(
      'data-archive-label',
      '归档任务'
    )

    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute('data-read-first', 'false')
  })

  it('keeps the assignee directory scoped to the current project', async () => {
    render(<Project />)

    await userEvent.click(screen.getByText('Open Issue'))

    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute(
      'data-has-global-team-directory',
      'false'
    )
  })

  it('passes runtime device names to the Issue task list', async () => {
    render(
      <Project
        runtimeWork={
          {
            projects: [
              {
                project: { id: 1, key: 'project', name: 'Project' },
                deviceWorkspaces: [
                  {
                    deviceId: 'device',
                    deviceName: 'Wework 开发设备',
                    workspacePath: '/tmp/project',
                    available: true,
                    tasks: [],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 0,
          } as never
        }
      />
    )

    await userEvent.click(screen.getByText('Open Issue'))

    expect(screen.getByTestId('cloud-todo-detail-device-name')).toHaveTextContent('Wework 开发设备')
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

  it('uses the freshly initialized project instead of the stale host project', async () => {
    taskBindings = [
      {
        id: 'binding-existing',
        projectId: 'project',
        issueId: issue.id,
        taskUserId: 1,
        deviceId: 'previous-device',
        taskId: 'previous-task',
        backendTaskId: null,
        linkedAt: '2026-09-20T00:00:00Z',
      },
    ]
    render(<Project />)
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

    await userEvent.click(screen.getByText('Save execution environment'))
    await userEvent.click(screen.getByText('Open Issue'))
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-device-id',
      'shared-runtime-device'
    )
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-workspace-path',
      '/srv/collaboration/fresh-environment'
    )
  })

  it('can start the first task without an existing task binding', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    expect(screen.getByTestId('ai-chat-modal')).toBeInTheDocument()
  })

  it('preserves the selected model across the shared Issue task-binding port', async () => {
    const runtimePort = { bindTask: vi.fn(), unbindTask: vi.fn() }
    const modelSelection = {
      modelName: 'selected-cloud-model',
      modelType: 'public' as const,
      options: { reasoning: 'high' },
    }
    render(<Project runtimePort={runtimePort} />)
    await userEvent.click(screen.getByText('Open Issue'))
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }))

    let rollback: Awaited<
      ReturnType<NonNullable<ComponentProps<typeof AiChatModal>['prepareTask']>>
    >
    await act(async () => {
      rollback = await chatPreparations.get('new')?.({
        deviceId: 'remote-device',
        taskId: 'selected-model-task',
        runtimeHandle: { modelSelection },
      })
    })

    const task = { deviceId: 'remote-device', taskId: 'selected-model-task', modelSelection }
    expect(runtimePort.bindTask).toHaveBeenCalledWith(issue.id, task, issue.title, null)
    await act(async () => {
      if (typeof rollback === 'function') await rollback()
    })
    expect(runtimePort.unbindTask).toHaveBeenCalledWith(issue.id, task)
  })

  it('preserves the human AI-assistance binding when refreshing the execution environment', async () => {
    const binding = {
      humanAssignmentId: 'human-assignment-1',
      dispatchId: 'dispatch-1',
      dispatchRoundId: 'round-1',
      assignmentId: 'assignment-1',
    }
    issue.human_work = {
      assignment_id: binding.assignmentId,
      ai_task_binding: binding,
      assignee_user_id: 1,
      reviewer_user_id: 2,
      submission_message_id: null,
      submitted_by_user_id: null,
      state: 'none',
      result: '',
      return_reason: '',
      ai_draft_delivery_id: null,
      can_start: false,
      can_submit: true,
      can_review: false,
    }
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
    const user = userEvent.setup()
    await user.click(screen.getByText('Save execution environment'))
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'Add task' }))

    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute(
      'data-device-id',
      'shared-runtime-device'
    )
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

  it('mounts a fresh composer for every consecutive new task request', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    const firstMountId = screen.getByTestId('ai-chat-modal').getAttribute('data-mount-id')

    await user.click(screen.getByRole('button', { name: 'Add task' }))

    expect(screen.getByTestId('ai-chat-modal')).not.toHaveAttribute('data-mount-id', firstMountId)
  })

  it('marks the opened execution as the current Issue conversation', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))

    await user.click(screen.getByRole('button', { name: 'run-2' }))

    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute(
      'data-selected-task-id',
      'run-2'
    )
  })

  it('passes the live execution status to the Issue task list', async () => {
    taskBindings = [
      {
        id: 'binding-1',
        projectId: 'project',
        issueId: issue.id,
        taskUserId: 1,
        deviceId: 'device',
        taskId: 'run-1',
        taskTitle: 'Running execution',
        backendTaskId: null,
        linkedAt: '2026-09-18T00:00:00Z',
      },
    ]
    render(
      <Project
        runtimeWork={
          {
            projects: [
              {
                project: { id: 1, key: 'project', name: 'Project' },
                deviceWorkspaces: [
                  {
                    deviceId: 'device',
                    workspacePath: '/tmp/project',
                    available: true,
                    tasks: [
                      {
                        taskId: 'run-1',
                        workspacePath: '/tmp/project',
                        title: 'Running execution',
                        runtime: 'codex',
                        running: true,
                        status: 'running',
                      },
                    ],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 1,
          } as never
        }
      />
    )
    await userEvent.click(screen.getByText('Open Issue'))

    expect(screen.getByTestId('cloud-todo-detail')).toHaveAttribute('data-task-status', 'running')
  })

  it('opens only the Issue drawer from a collaboration card task area', async () => {
    taskBindings = [
      {
        id: 'binding-1',
        projectId: 'project',
        issueId: issue.id,
        taskUserId: 1,
        deviceId: 'device',
        taskId: 'run-1',
        taskTitle: 'Running execution',
        backendTaskId: null,
        linkedAt: '2026-09-22T00:00:00Z',
      },
    ]
    const user = userEvent.setup()
    render(<Project />)

    expect(screen.getByText('Open progress')).toBeDisabled()
    await user.click(screen.getByText('Open task area'))

    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByText('Open progress')).toBeDisabled()
    expect(screen.queryByText('Board progress preview')).not.toBeInTheDocument()
  })

  it('retains the inert conversation until the shared track finishes returning', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    const chat = screen.getByTestId('ai-chat-modal')
    const motion = startMotion()
    await user.click(screen.getByTestId('ai-chat-modal-close'))
    expect(screen.getByTestId('ai-chat-modal')).toBe(chat)
    expect(chat.parentElement).toHaveAttribute('inert')
    expect(screen.getByTestId('issue-conversation-drawers')).toHaveAttribute(
      'data-has-conversation',
      'false'
    )
    expect(screen.getByRole('button', { name: 'run-1' })).toHaveFocus()
    await motion.finish()
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
  })

  it('reopening during exit preserves both panes and ignores the old completion', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    const detail = screen.getByTestId('cloud-todo-detail')
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    const chat = screen.getByTestId('ai-chat-modal')
    const motion = startMotion()
    await user.click(screen.getByTestId('ai-chat-modal-close'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    await motion.cancel()
    expect(screen.getByTestId('cloud-todo-detail')).toBe(detail)
    expect(screen.getByTestId('ai-chat-modal')).toBe(chat)
    expect(chat.parentElement).not.toHaveAttribute('inert')
    expect(screen.getByTestId('issue-conversation-drawers')).toHaveAttribute(
      'data-has-conversation',
      'true'
    )
  })

  it('slides the entire pair out before dismissing the Issue', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    const motion = startMotion()
    await user.click(screen.getByTestId('cloud-todo-detail-close'))
    expect(screen.getByTestId('issue-conversation-drawers')).toHaveAttribute(
      'data-dismissing',
      'true'
    )
    expect(screen.getByTestId('ai-chat-modal')).toBeInTheDocument()
    await motion.finish()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Open Issue')).toHaveFocus()
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

  it('owns both panes in one overlay and preserves the Issue draft and scroll position', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    const detail = screen.getByTestId('cloud-todo-detail')
    const scroller = screen.getByTestId('cloud-todo-detail-scroll')
    scroller.scrollTop = 180
    await user.type(screen.getByLabelText('Issue draft'), 'Keep this draft')
    await user.click(screen.getByRole('button', { name: 'run-1' }))

    const drawers = screen.getByTestId('issue-conversation-drawers')
    expect(within(drawers).getByTestId('cloud-todo-detail')).toBe(detail)
    expect(within(drawers).getByTestId('ai-chat-modal')).toHaveTextContent('Conversation: run-1')
    expect(screen.getByTestId('ai-chat-modal-close')).toHaveFocus()

    await user.click(screen.getByTestId('ai-chat-modal-close'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail')).toBe(detail)
    expect(screen.getByLabelText('Issue draft')).toHaveValue('Keep this draft')
    expect(scroller.scrollTop).toBe(180)
    expect(screen.getByRole('button', { name: 'run-1' })).toHaveFocus()
  })

  it('replaces the right conversation and Escape in either pane closes only the conversation', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    await user.click(screen.getByRole('button', { name: 'run-2' }))
    act(() => chatCallbacks.get('run-1')?.({ deviceId: 'device', taskId: 'stale-run-1' }))
    expect(screen.getAllByTestId('ai-chat-modal')).toHaveLength(1)
    expect(screen.getByTestId('ai-chat-modal')).toHaveTextContent('Conversation: run-2')
    expect(screen.getByTestId('ai-chat-modal')).toHaveAttribute('data-address', 'run-2')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'run-2' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'run-1' }))
    fireEvent.keyDown(screen.getByTestId('cloud-todo-detail'), { key: 'Escape' })
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('cloud-todo-detail')).not.toBeInTheDocument()
    expect(screen.getByText('Open Issue')).toHaveFocus()
  })

  it('dismisses the conversation first from the backdrop and closes both from the Issue close button', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open Issue'))
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    await user.click(screen.getByRole('dialog'))
    expect(screen.queryByTestId('ai-chat-modal')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'run-1' }))
    await user.click(screen.getByTestId('cloud-todo-detail-close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
