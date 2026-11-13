import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceTaskBinding } from '@wegent/collaboration'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { ProjectSpaceApis } from '@/features/workbench/workbenchServices'
import { navigateTo } from '@/lib/navigation'
import type { ExperiencePanesProps } from './shell/types'
import type { PrivateDiscussionPaneProps } from './private/PrivateDiscussionPane'
import type { AssistantHomeProps } from './assistant/types'
import type { AssistantConversationPaneProps } from './assistant/AssistantConversationPane'
import type { AssistantTeamRelayProps } from './assistant/AssistantTeamRelay'
import {
  experienceBindingFixture,
  experienceIssueFixture,
  experienceMessageFixture,
  experienceProjectFixture,
} from './model/fixtures'
import CollaborationExpApp from './CollaborationExpApp'
import '@/i18n'

let workbench: WorkbenchContextValue
let cloudBaseUrl = ''
const privateProps = vi.hoisted(() => vi.fn())
const assistantProps = vi.hoisted(() => vi.fn())
const assistantConversationProps = vi.hoisted(() => vi.fn())
const teamRelayProps = vi.hoisted(() => vi.fn())
const issueDetailsProps = vi.hoisted(() => vi.fn())
type IssueDetailsProps = ComponentProps<
  typeof import('./timeline/ExperienceIssueDetails').ExperienceIssueDetails
>

vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => workbench }))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({ isConnected: true, apiBaseUrl: cloudBaseUrl }),
}))
vi.mock('@/features/todo/useCollaborationMarkdownServices', () => ({
  useCollaborationMarkdownServices: () => ({}),
}))
vi.mock('./assistant', async importOriginal => {
  const original = await importOriginal<typeof import('./assistant')>()
  return {
    ...original,
    AssistantTeamRelay: (props: AssistantTeamRelayProps) => {
      teamRelayProps(props)
      return <div data-testid="team-relay-leaf" />
    },
    AssistantHome: (props: AssistantHomeProps) => {
      assistantProps(props)
      return (
        <div data-testid="assistant-leaf">
          {props.conversations?.map(conversation => (
            <button
              type="button"
              key={conversation.key}
              data-testid={`recent-${conversation.address.taskId}`}
              onClick={() => props.onOpenConversation?.(conversation)}
            >
              {conversation.title}
            </button>
          ))}
          <button
            type="button"
            data-testid="open-ordinary-conversation"
            onClick={() =>
              props.onOpenConversation?.({
                key: JSON.stringify(['assistant-device', 'ordinary-conversation']),
                address: { deviceId: 'assistant-device', taskId: 'ordinary-conversation' },
                bindingIds: [],
                sourceNodeIds: [],
                ownerUserId: 7,
                title: 'Ordinary conversation',
                linkedAt: null,
              })
            }
          >
            Open ordinary conversation
          </button>
        </div>
      )
    },
    AssistantConversationPane: (props: AssistantConversationPaneProps) => {
      assistantConversationProps(props)
      return <div data-testid="assistant-conversation-leaf">{props.address.taskId}</div>
    },
  }
})
vi.mock('@wegent/collaboration/markdown', () => ({
  MarkdownServicesProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@wegent/collaboration', async importOriginal => {
  const original = await importOriginal<typeof import('@wegent/collaboration')>()
  return {
    ...original,
    IssueActivityMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
    BrowserAttachmentPreview: ({
      attachmentId,
      onClose,
    }: {
      attachmentId: string
      onClose(): void
    }) => (
      <div data-testid="attachment-leaf">
        <span>{attachmentId}</span>
        <button type="button" data-testid="attachment-close" onClick={onClose}>
          Close
        </button>
      </div>
    ),
  }
})
vi.mock('./shell', async importOriginal => {
  const original = await importOriginal<typeof import('./shell')>()
  return {
    ...original,
    ExperiencePanes: ({ panes, navigation }: ExperiencePanesProps) => (
      <div>
        {navigation}
        {panes.map(pane => (
          <section
            key={pane.id}
            data-testid={`pane-${pane.id}`}
            data-back-visibility={pane.backVisibility}
          >
            {pane.header === null
              ? null
              : (pane.header ?? (
                  <header>
                    <h1>{pane.title}</h1>
                    {pane.onBack ? (
                      <button type="button" data-testid={`back-${pane.id}`} onClick={pane.onBack}>
                        Back
                      </button>
                    ) : null}
                    {pane.actions}
                  </header>
                ))}
            {typeof pane.content === 'function'
              ? pane.content(pane.onBack ?? (() => {}))
              : pane.content}
          </section>
        ))}
      </div>
    ),
  }
})
vi.mock('./tasks/ProjectExperience', () => ({
  ProjectExperience: ({
    project,
    view,
    planView,
    onOpenIssue,
  }: {
    project: { name: string }
    view: string
    planView: string
    onOpenIssue(id: string): void
  }) => (
    <div data-testid="project-leaf" data-project-view={view} data-plan-view={planView}>
      {project.name}
      <button data-testid="open-project-task" onClick={() => onOpenIssue('EXP-1')}>
        Open task from plan
      </button>
    </div>
  ),
}))
vi.mock('./private', () => ({
  PrivateDiscussionPane: (props: PrivateDiscussionPaneProps) => {
    privateProps(props)
    return (
      <div data-testid="private-leaf">
        {props.conversation.address.taskId}
        <button data-testid="private-context-back" onClick={props.onClose}>
          Task progress
        </button>
      </div>
    )
  },
}))
vi.mock('./timeline/ExperienceIssueDetails', () => ({
  ExperienceIssueDetails: (props: IssueDetailsProps) => {
    issueDetailsProps(props)
    return (
      <div data-testid="issue-details-leaf">
        <span>{props.data.issue.title}</span>
        <button
          type="button"
          data-testid="issue-details-save-leaf"
          onClick={() => props.onChange(currentIssue)}
        >
          Saved
        </button>
        <button type="button" data-testid="issue-details-close-leaf" onClick={props.onClose}>
          Close
        </button>
      </div>
    )
  },
}))

const project = experienceProjectFixture({ name: 'Release project' })
const otherProject = experienceProjectFixture({
  id: 'project-2',
  name: 'Second project',
  project_key: 'TWO',
})
const issue = experienceIssueFixture({ title: 'Release documentation' })
const otherIssue = experienceIssueFixture({
  id: 'EXP-2',
  cloud_project_id: otherProject.id,
  title: 'Release followup',
})
let bindings: WorkspaceTaskBinding[]
let messages: ProjectChatMessage[]
let currentIssue = issue
let api: SharedWorkspaceApi

function createApi() {
  return {
    projects: {
      list: vi.fn(async () => [project, otherProject]),
      get: vi.fn(async (id: string) => (id === project.id ? project : otherProject)),
    },
    issues: {
      list: vi.fn(async (id: string) => (id === project.id ? [currentIssue] : [otherIssue])),
      get: vi.fn(async (id: string) => (id === issue.id ? currentIssue : otherIssue)),
    },
    myWork: {
      page: vi.fn(async () => ({
        items: [
          { ...currentIssue, task_bindings: bindings },
          { ...otherIssue, task_bindings: [] },
        ],
        nextCursor: null,
      })),
    },
    taskBindings: { list: vi.fn(async () => bindings) },
    activity: {
      subscribe: vi.fn(async () => ({
        snapshot: { currentUserId: '7', messages },
        unsubscribe: vi.fn(),
      })),
      subscribeLoopItemChanges: vi.fn(async () => vi.fn()),
    },
    attachments: { list: vi.fn(async () => []), read: vi.fn() },
    members: { list: vi.fn(async () => []) },
  } as unknown as SharedWorkspaceApi
}

function Harness({ active = true }: { active?: boolean }) {
  const [search, setSearch] = useState(window.location.search)
  useEffect(() => {
    const receive = () => setSearch(window.location.search)
    window.addEventListener('popstate', receive)
    return () => window.removeEventListener('popstate', receive)
  }, [])
  return <CollaborationExpApp active={active} search={search} />
}

function open(search: Record<string, string>) {
  window.history.replaceState(
    {},
    '',
    `/collaboration-exp?${new URLSearchParams({ view: 'tasks', relevance: 'all', ...search })}`
  )
  return render(<Harness />)
}

describe('CollaborationExpApp integration', () => {
  beforeEach(() => {
    cloudBaseUrl = 'https://first-backend.example'
    privateProps.mockClear()
    assistantProps.mockClear()
    assistantConversationProps.mockClear()
    teamRelayProps.mockClear()
    issueDetailsProps.mockClear()
    currentIssue = issue
    bindings = [experienceBindingFixture()]
    messages = []
    api = createApi()
    workbench = {
      state: { user: { id: 7, user_name: 'Member' }, runtimeWork: null, devices: [], projects: [] },
      services: { sharedWorkspaceApi: api },
    } as unknown as WorkbenchContextValue
    window.history.replaceState({}, '', '/collaboration-exp')
  })
  afterEach(cleanup)

  test.each([
    { cloudAvailable: false, projectStore: undefined },
    { cloudAvailable: true, projectStore: undefined },
    { cloudAvailable: true, projectStore: 'local' },
    { cloudAvailable: true, projectStore: 'backend' },
  ] as const)(
    'initializes standalone tasks in the native local container with cloud=$cloudAvailable and explicit source=$projectStore',
    async ({ cloudAvailable, projectStore }) => {
      const localProject = experienceProjectFixture({
        id: 'default-work-items',
        project_store: 'local',
        metadata: { system_kind: 'default_work_items' },
      })
      const listLocalProjects = vi.fn(async () => ({ items: [localProject] }))
      const local = {
        listCloudProjects: listLocalProjects,
        listMyWork: vi.fn(async () => ({ items: [], next_cursor: null })),
      } as unknown as ProjectSpaceApis['local']
      vi.mocked(api.projects.get).mockImplementation(async id => {
        if (id === localProject.id) throw new Error('No cloud standalone container exists')
        return id === project.id ? project : otherProject
      })
      workbench = {
        ...workbench,
        services: {
          ...workbench.services,
          sharedWorkspaceApi: cloudAvailable ? api : undefined,
          projectSpaceApis: { local, defaultLocation: 'cloud' },
          localParticipationIdentity: {
            nativeOwnerUserId: 0,
            currentUser: workbench.state.user,
            viewerUserIds: [0, 7],
          },
        },
      } as unknown as WorkbenchContextValue
      open(projectStore ? { projectStore } : {})
      await waitFor(() => expect(listLocalProjects).toHaveBeenCalled())
      const localReads = listLocalProjects.mock.calls.length
      fireEvent.click(screen.getByTestId('collaboration-exp-task-create'))
      const dialog = await screen.findByTestId('collaboration-exp-create-dialog')
      fireEvent.change(within(dialog).getByTestId('collaboration-exp-create-goal'), {
        target: { value: 'Create in the selected available source' },
      })
      await waitFor(() =>
        expect(within(dialog).getByTestId('collaboration-exp-create-submit')).toBeEnabled()
      )
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
      expect(listLocalProjects).toHaveBeenCalledTimes(localReads + 1)
      expect(api.projects.get).not.toHaveBeenCalledWith('default-work-items')
      expect(api.members.list).not.toHaveBeenCalled()
    }
  )

  test('opens a task without narrowing the global list and returns to the same list state', async () => {
    open({ search: 'Release', status: 'pending', future: 'keep' })
    const task = await screen.findByTestId(`collaboration-exp-task-${issue.id}`)
    expect(screen.getByTestId(`collaboration-exp-task-${otherIssue.id}`)).toBeInTheDocument()
    const scroller = screen.getByTestId('collaboration-exp-tasks').querySelector('[aria-busy]')!
    scroller.scrollTop = 120
    fireEvent.click(task)
    await screen.findByTestId('collaboration-exp-timeline')

    const selected = new URLSearchParams(window.location.search)
    expect(selected.get('projectStore')).toBe('backend')
    expect(selected.get('projectId')).toBe(project.id)
    expect(selected.has('projectScope')).toBe(false)
    expect(selected.get('search')).toBe('Release')
    expect(selected.get('status')).toBe('pending')
    expect(selected.get('future')).toBe('keep')
    expect(screen.getByTestId(`collaboration-exp-task-${otherIssue.id}`)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('back-timeline'))

    expect(screen.queryByTestId('collaboration-exp-timeline')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-exp-tasks').querySelector('[aria-busy]')).toBe(
      scroller
    )
    expect(scroller.scrollTop).toBe(120)
    expect(new URLSearchParams(window.location.search).get('search')).toBe('Release')
  })

  test('keeps the list project filter separate from a deep-linked task in another project', async () => {
    const scope = JSON.stringify(['backend', project.id])
    open({
      projectScope: scope,
      projectId: otherProject.id,
      projectStore: 'backend',
      issueId: otherIssue.id,
    })
    await screen.findByTestId('collaboration-exp-timeline')
    expect(screen.getByTestId(`collaboration-exp-task-${issue.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`collaboration-exp-task-${otherIssue.id}`)).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('projectScope')).toBe(scope)
    expect(api.projects.get).toHaveBeenCalledWith(otherProject.id)
    expect(api.issues.get).toHaveBeenCalledWith(otherIssue.id)
    fireEvent.click(screen.getByTestId('back-timeline'))
    expect(new URLSearchParams(window.location.search).get('projectScope')).toBe(scope)
    expect(screen.getByTestId('collaboration-exp-clear-projectKey')).toBeInTheDocument()
  })

  test('returns from a project task to the same plan, project scope, filters and mounted scroll', async () => {
    const scope = JSON.stringify(['backend', project.id])
    open({
      view: 'tasks',
      projectStore: 'backend',
      projectId: project.id,
      projectScope: scope,
      projectView: 'plan',
      planView: 'gantt',
      search: 'Implement',
      status: 'pending',
    })
    const plan = await screen.findByTestId('project-leaf')
    plan.scrollTop = 240
    fireEvent.click(screen.getByTestId('open-project-task'))
    await screen.findByTestId('collaboration-exp-timeline')
    expect(screen.getByTestId('pane-timeline')).toHaveAttribute(
      'data-back-visibility',
      'collapsed-parent'
    )
    fireEvent.click(screen.getByTestId('back-timeline'))
    expect(screen.queryByTestId('collaboration-exp-timeline')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-leaf')).toBe(plan)
    expect(plan).toHaveAttribute('data-project-view', 'plan')
    expect(plan).toHaveAttribute('data-plan-view', 'gantt')
    expect(plan.scrollTop).toBe(240)
    const restored = new URLSearchParams(window.location.search)
    expect(restored.get('projectScope')).toBe(scope)
    expect(restored.get('projectId')).toBe(project.id)
    expect(restored.get('projectView')).toBe('plan')
    expect(restored.get('planView')).toBe('gantt')
    expect(restored.get('search')).toBe('Implement')
    expect(restored.get('status')).toBe('pending')
  })

  test('restores an exact owned private binding from the URL without creating a conversation', async () => {
    const discussion = JSON.stringify(['device-1', 'task-1'])
    open({ projectStore: 'backend', projectId: project.id, issueId: issue.id, discussion })
    expect(await screen.findByTestId('private-leaf')).toHaveTextContent('task-1')
    expect(privateProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        api: expect.any(Object),
        project,
        issue,
        historyScope: 'task',
        conversation: expect.objectContaining({
          bindingIds: ['binding-1'],
          ownerUserId: 7,
          address: { deviceId: 'device-1', taskId: 'task-1' },
        }),
      })
    )
    expect(api.taskBindings.list).toHaveBeenCalledExactlyOnceWith(issue.id, project.id)
    fireEvent.click(screen.getByTestId('private-context-back'))
    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).has('discussion')).toBe(false)
  })

  test('anchors canonical and client comment ids and repeats focus for another notification', async () => {
    messages = [
      experienceMessageFixture({ clientMessageId: 'client-message-1' }),
      experienceMessageFixture({
        messageId: 'message-2',
        sequenceNumber: 2,
        type: 'execution',
        sender: { type: 'agent', id: 'agent' },
        runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
      }),
    ]
    const scroll = vi.fn()
    const originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      open({
        projectStore: 'backend',
        projectId: project.id,
        issueId: issue.id,
        commentId: 'message-1',
        focusRequest: 'first',
      })
      const node = await screen.findByTestId('collaboration-exp-timeline-node-message-1')
      await waitFor(() => expect(node).toHaveFocus())
      expect(node).toHaveAttribute('data-linked', 'true')
      expect(screen.getByTestId('collaboration-exp-timeline-node-message-2')).not.toHaveAttribute(
        'data-linked'
      )
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' })
      const firstCount = scroll.mock.calls.length
      fireEvent.click(screen.getByTestId('collaboration-exp-timeline-filter-attachments'))
      expect(
        screen.queryByTestId('collaboration-exp-timeline-node-message-1')
      ).not.toBeInTheDocument()

      const params = new URLSearchParams(window.location.search)
      params.set('commentId', 'client-message-1')
      params.set('focusRequest', 'second')
      act(() => navigateTo(`/collaboration-exp?${params}`))
      const restored = await screen.findByTestId('collaboration-exp-timeline-node-message-1')
      await waitFor(() => expect(restored).toHaveFocus())
      expect(restored).toHaveAttribute('data-linked', 'true')
      expect(scroll.mock.calls.length).toBeGreaterThan(firstCount)
      const secondCount = scroll.mock.calls.length

      params.set('focusRequest', 'third')
      act(() => navigateTo(`/collaboration-exp?${params}`))
      await waitFor(() => expect(scroll.mock.calls.length).toBeGreaterThan(secondCount))
      expect(restored).toHaveFocus()
      expect(screen.queryByTestId('collaboration-exp-comment-unavailable')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('collaboration-exp-timeline-filter-attachments'))
      params.delete('commentId')
      params.delete('focusRequest')
      params.set('nodeId', 'message-2')
      const executionScrollCount = scroll.mock.calls.length
      act(() => navigateTo(`/collaboration-exp?${params}`))
      const execution = await screen.findByTestId('collaboration-exp-timeline-node-message-2')
      await waitFor(() => expect(scroll.mock.calls.length).toBeGreaterThan(executionScrollCount))
      expect(execution).toHaveAttribute('data-linked', 'true')
      expect(execution).not.toHaveFocus()
      expect(screen.getByTestId('collaboration-exp-timeline-filter-all')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll
    }
  })

  test('does not select another canonical comment when the notification anchor is unavailable', async () => {
    messages = [
      experienceMessageFixture(),
      experienceMessageFixture({ messageId: 'message-2', sequenceNumber: 2 }),
    ]
    open({
      projectStore: 'backend',
      projectId: project.id,
      issueId: issue.id,
      commentId: 'missing-comment',
    })
    expect(await screen.findByTestId('collaboration-exp-comment-unavailable')).toBeInTheDocument()
    for (const id of ['message-1', 'message-2']) {
      const node = screen.getByTestId(`collaboration-exp-timeline-node-${id}`)
      expect(node).not.toHaveAttribute('data-linked')
      expect(node).not.toHaveFocus()
    }
    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
  })

  test('makes a node discussion and its attachment mutually exclusive without losing the node identity', async () => {
    messages = [
      experienceMessageFixture({ content: '[Report](wegent://attachments/file-1)' }),
      experienceMessageFixture({
        messageId: 'agent-1',
        sequenceNumber: 2,
        sender: { type: 'agent', id: 'agent' },
        type: 'execution',
        triggerMessageId: 'message-1',
        runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
        metadata: { runtime_turn_id: 'turn-1' },
      }),
    ]
    open({ projectStore: 'backend', projectId: project.id, issueId: issue.id })
    fireEvent.click(await screen.findByTestId('collaboration-exp-node-discussion-message-1-task-1'))
    expect(await screen.findByTestId('private-leaf')).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('nodeId')).toBe('message-1')
    expect(privateProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceNodeId: 'message-1', historyScope: 'source' })
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-node-attachment-message-1-file-1'))

    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
    expect(screen.getByTestId('attachment-leaf')).toHaveTextContent('file-1')
    expect(new URLSearchParams(window.location.search).has('discussion')).toBe(false)
    expect(new URLSearchParams(window.location.search).get('nodeId')).toBe('message-1')
    fireEvent.click(screen.getByTestId('collaboration-exp-node-discussion-message-1-task-1'))
    expect(screen.queryByTestId('attachment-leaf')).not.toBeInTheDocument()
    expect(screen.getByTestId('private-leaf')).toBeInTheDocument()
  })

  test('does not guess another source when a local target shares a backend identifier', async () => {
    open({
      projectStore: 'local',
      projectId: project.id,
      issueId: issue.id,
      discussion: JSON.stringify(['device-1', 'task-1']),
    })
    await screen.findByTestId(`collaboration-exp-task-${issue.id}`)
    expect(api.projects.get).not.toHaveBeenCalled()
    expect(api.issues.get).not.toHaveBeenCalled()
    expect(api.taskBindings.list).not.toHaveBeenCalled()
    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
  })

  test('clears attachment selection when the same user changes backend origin', async () => {
    messages = [experienceMessageFixture({ content: '[Report](wegent://attachments/file-1)' })]
    const view = open({ projectStore: 'backend', projectId: project.id, issueId: issue.id })
    fireEvent.click(await screen.findByTestId('collaboration-exp-node-attachment-message-1-file-1'))
    expect(screen.getByTestId('attachment-leaf')).toHaveTextContent('file-1')

    cloudBaseUrl = 'https://second-backend.example'
    view.rerender(<Harness />)

    expect(screen.queryByTestId('attachment-leaf')).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('issueId')).toBe(issue.id)
  })

  test('rejects a hidden Issue before reading or mounting its private discussion', async () => {
    currentIssue = experienceIssueFixture({ can_view_detail: false, title: 'SECRET hidden Issue' })
    open({
      projectStore: 'backend',
      projectId: project.id,
      issueId: issue.id,
      discussion: JSON.stringify(['device-1', 'task-1']),
    })
    await screen.findByTestId('collaboration-exp-detail-retry')
    expect(api.taskBindings.list).not.toHaveBeenCalled()
    expect(api.activity?.subscribe).not.toHaveBeenCalled()
    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
    expect(screen.queryByText('SECRET hidden Issue')).not.toBeInTheDocument()
  })

  test('an inactive experiment makes no business reads', async () => {
    render(<Harness active={false} />)
    await act(async () => {})
    expect(api.projects.list).not.toHaveBeenCalled()
    expect(api.issues.list).not.toHaveBeenCalled()
    expect(api.myWork?.page).not.toHaveBeenCalled()
    expect(api.activity?.subscribeLoopItemChanges).not.toHaveBeenCalled()
    expect(assistantProps).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }))
  })

  test('a recent bound discussion opens the same Issue and owned private identity while retaining list scope', async () => {
    const scope = JSON.stringify(['backend', otherProject.id])
    open({ view: 'assistant', projectScope: scope, search: 'Release', future: 'keep' })
    fireEvent.click(await screen.findByTestId('recent-task-1'))

    expect(await screen.findByTestId('private-leaf')).toHaveTextContent('task-1')
    const selected = new URLSearchParams(window.location.search)
    expect(selected.get('view')).toBe('tasks')
    expect(selected.get('projectStore')).toBe('backend')
    expect(selected.get('projectId')).toBe(project.id)
    expect(selected.get('issueId')).toBe(issue.id)
    expect(selected.get('discussion')).toBe(JSON.stringify(['device-1', 'task-1']))
    expect(selected.get('projectScope')).toBe(scope)
    expect(selected.get('search')).toBe('Release')
    expect(selected.get('future')).toBe('keep')
    expect(privateProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project,
        issue,
        historyScope: 'task',
        conversation: expect.objectContaining({
          ownerUserId: 7,
          bindingIds: ['binding-1'],
          address: { deviceId: 'device-1', taskId: 'task-1' },
        }),
      })
    )
    fireEvent.click(screen.getByTestId('back-discussion'))
    fireEvent.click(screen.getByTestId('collaboration-exp-navigation-assistant'))
    fireEvent.click(await screen.findByTestId('recent-task-1'))
    await screen.findByTestId('private-leaf')
    expect(privateProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project,
        issue,
        conversation: expect.objectContaining({
          ownerUserId: 7,
          address: { deviceId: 'device-1', taskId: 'task-1' },
        }),
      })
    )
  })

  test('an ordinary assistant callback uses its own URL and pane without an Issue or project write', async () => {
    open({ view: 'assistant', future: 'keep' })
    fireEvent.click(await screen.findByTestId('open-ordinary-conversation'))

    expect(await screen.findByTestId('assistant-conversation-leaf')).toHaveTextContent(
      'ordinary-conversation'
    )
    const selected = new URLSearchParams(window.location.search)
    expect(selected.get('view')).toBe('assistant')
    expect(selected.get('assistantDeviceId')).toBe('assistant-device')
    expect(selected.get('assistantTaskId')).toBe('ordinary-conversation')
    expect(selected.get('future')).toBe('keep')
    expect(selected.has('issueId')).toBe(false)
    expect(selected.has('discussion')).toBe(false)
    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
    expect(api.issues.get).not.toHaveBeenCalled()
    expect(assistantConversationProps).toHaveBeenLastCalledWith({
      active: true,
      address: { deviceId: 'assistant-device', taskId: 'ordinary-conversation' },
    })
    fireEvent.click(screen.getByTestId('back-assistant-conversation'))
    expect(screen.queryByTestId('assistant-conversation-leaf')).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).has('assistantTaskId')).toBe(false)
  })

  test('opens the current work through the same task selection and retains the task team source', async () => {
    currentIssue = { ...issue, status: 'in_progress', execution_state: 'running' }
    const scope = JSON.stringify([project.project_store, project.id])
    open({ projectScope: scope, search: 'Release', future: 'keep' })
    const current = await screen.findByTestId('collaboration-exp-task-rhythm-current')
    expect(current).toHaveTextContent(issue.title)
    expect(screen.getByTestId('team-relay-leaf')).toBeInTheDocument()
    expect(teamRelayProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: true,
        projects: expect.arrayContaining([expect.objectContaining({ project })]),
      })
    )
    fireEvent.click(current)
    await screen.findByTestId('pane-timeline')
    const selected = new URLSearchParams(window.location.search)
    expect(selected.get('issueId')).toBe(issue.id)
    expect(selected.get('projectStore')).toBe(project.project_store)
    expect(selected.get('projectId')).toBe(project.id)
    expect(selected.get('projectScope')).toBe(scope)
    expect(selected.get('search')).toBe('Release')
    expect(selected.get('future')).toBe('keep')
    expect(assistantProps).not.toHaveBeenCalled()
  })

  test('controls the same timeline filter from both the header attachment action and filter tabs', async () => {
    messages = [
      experienceMessageFixture({ content: 'Plain shared comment' }),
      experienceMessageFixture({
        messageId: 'with-file',
        sequenceNumber: 2,
        content: '[Report](wegent://attachments/file-1)',
      }),
    ]
    const scope = JSON.stringify(['backend', project.id])
    open({
      projectStore: 'backend',
      projectId: project.id,
      issueId: issue.id,
      commentId: 'message-1',
      focusRequest: 'header-filter',
      projectScope: scope,
      search: 'Release',
      status: 'pending',
      future: 'keep',
    })
    await screen.findByTestId('collaboration-exp-timeline-node-message-1')
    expect(screen.getByTestId('collaboration-exp-timeline-node-with-file')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-header-attachments'))
    expect(new URLSearchParams(window.location.search).get('timelineFilter')).toBe('attachments')
    for (const key of ['nodeId', 'commentId', 'focusRequest'])
      expect(new URLSearchParams(window.location.search).has(key)).toBe(false)
    expect(screen.getByTestId('collaboration-exp-timeline-filter-attachments')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen.queryByTestId('collaboration-exp-timeline-node-message-1')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-exp-timeline-node-with-file')).toBeInTheDocument()
    const anchored = new URLSearchParams(window.location.search)
    anchored.set('nodeId', 'message-1')
    anchored.set('commentId', 'message-1')
    anchored.set('focusRequest', 'tab-filter')
    act(() => navigateTo(`/collaboration-exp?${anchored}`))
    expect(await screen.findByTestId('collaboration-exp-timeline-node-message-1')).toHaveAttribute(
      'data-linked',
      'true'
    )
    expect(new URLSearchParams(window.location.search).get('timelineFilter')).toBe('attachments')
    expect(screen.getByTestId('collaboration-exp-timeline-filter-all')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-header-attachments'))
    expect(new URLSearchParams(window.location.search).get('timelineFilter')).toBe('attachments')
    for (const key of ['nodeId', 'commentId', 'focusRequest'])
      expect(new URLSearchParams(window.location.search).has(key)).toBe(false)
    expect(screen.getByTestId('collaboration-exp-timeline-filter-attachments')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(
      screen.queryByTestId('collaboration-exp-timeline-node-message-1')
    ).not.toBeInTheDocument()
    act(() => navigateTo(`/collaboration-exp?${anchored}`))
    expect(await screen.findByTestId('collaboration-exp-timeline-node-message-1')).toHaveAttribute(
      'data-linked',
      'true'
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-timeline-filter-conclusions'))
    expect(new URLSearchParams(window.location.search).get('timelineFilter')).toBe('conclusions')
    for (const key of ['nodeId', 'commentId', 'focusRequest'])
      expect(new URLSearchParams(window.location.search).has(key)).toBe(false)
    expect(screen.getByTestId('collaboration-exp-timeline-node-message-1')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-header-attachments'))
    fireEvent.click(screen.getByTestId('collaboration-exp-header-attachments'))
    const selected = new URLSearchParams(window.location.search)
    expect(selected.has('timelineFilter')).toBe(false)
    expect(selected.get('issueId')).toBe(issue.id)
    expect(selected.get('projectScope')).toBe(scope)
    expect(selected.get('search')).toBe('Release')
    expect(selected.get('status')).toBe('pending')
    expect(selected.get('future')).toBe('keep')
    expect(screen.getByTestId('collaboration-exp-timeline-filter-all')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('collaboration-exp-timeline-node-message-1')).toBeInTheDocument()
  })

  test('opens the summary before native configuration and reloads authoritative task data after save', async () => {
    open({
      projectStore: 'backend',
      projectId: project.id,
      issueId: issue.id,
      discussion: JSON.stringify(['device-1', 'task-1']),
      search: 'Release',
    })
    await screen.findByTestId('private-leaf')
    fireEvent.click(screen.getByTestId('collaboration-exp-header-details'))
    const summary = await screen.findByTestId('collaboration-exp-issue-summary')
    expect(summary).toHaveTextContent(issue.title)
    expect(screen.queryByTestId('issue-details-leaf')).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('inspector')).toBe('summary')
    expect(screen.queryByTestId('private-leaf')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-issue-summary-configure'))
    expect(await screen.findByTestId('issue-details-leaf')).toHaveTextContent(issue.title)
    expect(screen.queryByTestId('collaboration-exp-issue-summary')).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('inspector')).toBe('details')
    expect(new URLSearchParams(window.location.search).has('discussion')).toBe(false)
    const initialReads = vi.mocked(api.issues.get).mock.calls.length
    const initialRevision = (issueDetailsProps.mock.lastCall?.[0] as IssueDetailsProps).revision
    currentIssue = { ...issue, title: 'Release documentation saved', version: issue.version + 1 }
    fireEvent.click(screen.getByTestId('issue-details-save-leaf'))
    await waitFor(() => expect(api.issues.get).toHaveBeenCalledTimes(initialReads + 1))
    await waitFor(() =>
      expect(issueDetailsProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ issue: currentIssue, project }),
          active: true,
          revision: initialRevision + 1,
        })
      )
    )
    expect(screen.getByTestId('issue-details-leaf')).toHaveTextContent(currentIssue.title)
    expect(api.myWork?.page).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('issue-details-close-leaf'))
    expect(screen.queryByTestId('issue-details-leaf')).not.toBeInTheDocument()
    expect(screen.getByTestId('collaboration-exp-timeline')).toBeInTheDocument()
    const selected = new URLSearchParams(window.location.search)
    expect(selected.has('inspector')).toBe(false)
    expect(selected.get('issueId')).toBe(issue.id)
    expect(selected.get('search')).toBe('Release')
  })

  test('closes the summary with Escape and opens its actual associated project without a stale inspector', async () => {
    open({ projectStore: 'backend', projectId: project.id, issueId: issue.id, search: 'Release' })
    const trigger = await screen.findByTestId('collaboration-exp-header-details')
    trigger.focus()
    fireEvent.click(trigger)
    const summary = await screen.findByTestId('collaboration-exp-issue-summary')
    fireEvent.keyDown(summary, { key: 'Escape' })
    expect(screen.queryByTestId('collaboration-exp-issue-summary')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(new URLSearchParams(window.location.search).has('inspector')).toBe(false)
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByTestId('collaboration-exp-issue-summary-project'))
    expect(await screen.findByTestId('project-leaf')).toHaveTextContent(project.name)
    expect(screen.queryByTestId('collaboration-exp-issue-summary')).not.toBeInTheDocument()
    const selected = new URLSearchParams(window.location.search)
    expect(selected.get('projectId')).toBe(project.id)
    expect(selected.get('projectStore')).toBe('backend')
    expect(selected.get('projectView')).toBe('overview')
    expect(selected.get('search')).toBe('Release')
    expect(selected.has('inspector')).toBe(false)
    expect(selected.has('issueId')).toBe(false)
  })

  test('returns both navigation entries to their home while retaining project scope and list filters', async () => {
    const scope = JSON.stringify(['backend', project.id])
    open({
      projectStore: 'backend',
      projectId: otherProject.id,
      issueId: otherIssue.id,
      inspector: 'details',
      timelineFilter: 'attachments',
      projectScope: scope,
      search: 'Release',
      status: 'pending',
      future: 'keep',
    })
    await screen.findByTestId('issue-details-leaf')
    fireEvent.click(screen.getByTestId('collaboration-exp-navigation-tasks'))
    expect(await screen.findByTestId('collaboration-exp-task-home')).toBeInTheDocument()
    expect(screen.queryByTestId('collaboration-exp-timeline')).not.toBeInTheDocument()
    expect(screen.queryByTestId('issue-details-leaf')).not.toBeInTheDocument()
    let selected = new URLSearchParams(window.location.search)
    expect(selected.get('view')).toBe('tasks')
    expect(selected.has('issueId')).toBe(false)
    expect(selected.has('inspector')).toBe(false)
    for (const [key, value] of Object.entries({
      projectScope: scope,
      search: 'Release',
      status: 'pending',
      future: 'keep',
    }))
      expect(selected.get(key)).toBe(value)
    fireEvent.click(screen.getByTestId('collaboration-exp-navigation-assistant'))
    expect(await screen.findByTestId('assistant-leaf')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('collaboration-exp-assistant-toolbar-recent'))
    expect(assistantProps).toHaveBeenLastCalledWith(expect.objectContaining({ panel: 'recent' }))
    fireEvent.click(screen.getByTestId('open-ordinary-conversation'))
    await screen.findByTestId('assistant-conversation-leaf')
    fireEvent.click(screen.getByTestId('collaboration-exp-navigation-assistant'))
    expect(screen.queryByTestId('assistant-conversation-leaf')).not.toBeInTheDocument()
    expect(assistantProps).toHaveBeenLastCalledWith(expect.objectContaining({ panel: null }))
    selected = new URLSearchParams(window.location.search)
    expect(selected.get('view')).toBe('assistant')
    expect(selected.has('assistantTaskId')).toBe(false)
    expect(selected.has('assistantDeviceId')).toBe(false)
    for (const [key, value] of Object.entries({
      projectScope: scope,
      search: 'Release',
      status: 'pending',
      future: 'keep',
    }))
      expect(selected.get(key)).toBe(value)
  })
})
