import { useEffect, useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceTaskBinding } from '@wegent/collaboration'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { navigateTo } from '@/lib/navigation'
import type { ExperiencePanesProps } from './shell/types'
import type { PrivateDiscussionPaneProps } from './private/PrivateDiscussionPane'
import type { AssistantHomeProps } from './assistant/types'
import type { AssistantConversationPaneProps } from './assistant/AssistantConversationPane'
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

vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => workbench }))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({ isConnected: true, apiBaseUrl: cloudBaseUrl }),
}))
vi.mock('@/features/todo/useCollaborationMarkdownServices', () => ({
  useCollaborationMarkdownServices: () => ({}),
}))
vi.mock('./assistant', () => ({
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
}))
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
          <section key={pane.id} data-testid={`pane-${pane.id}`}>
            <h1>{pane.title}</h1>
            {pane.onBack ? (
              <button type="button" data-testid={`back-${pane.id}`} onClick={pane.onBack}>
                Back
              </button>
            ) : null}
            {pane.content}
          </section>
        ))}
      </div>
    ),
  }
})
vi.mock('./tasks/ProjectExperience', () => ({
  ProjectExperience: ({ project }: { project: { name: string } }) => (
    <div data-testid="project-leaf">{project.name}</div>
  ),
}))
vi.mock('./private', () => ({
  PrivateDiscussionPane: (props: PrivateDiscussionPaneProps) => {
    privateProps(props)
    return <div data-testid="private-leaf">{props.conversation.address.taskId}</div>
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
    fireEvent.click(screen.getByTestId('back-discussion'))
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
      expect(node).toHaveClass('bg-muted')
      expect(screen.getByTestId('collaboration-exp-timeline-node-message-2')).not.toHaveClass(
        'bg-muted'
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
      expect(restored).toHaveClass('bg-muted')
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
      expect(execution).toHaveClass('bg-muted')
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
      expect(node).not.toHaveClass('bg-muted')
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
})
