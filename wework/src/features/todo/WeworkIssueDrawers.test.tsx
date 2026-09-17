import '@/i18n'
import { useState, type ComponentProps } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationApp, CollaborationIssue } from '@wegent/collaboration'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'
import type { TodoEditor } from './TodoEditor'
import type { AiChatModal } from './AiChatModal'
import type { CloudTodoBoardCard } from './CloudTodoBoardCard'

const chatCallbacks = vi.hoisted(
  () => new Map<string, ComponentProps<typeof AiChatModal>['onAddressChange']>()
)

const issue = { id: 'TEST-1', title: 'Execute pwd', status: 'pending' } as CollaborationIssue
const getAnimations = vi.fn((): Partial<Animation>[] => [])
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: getAnimations,
  })
})
beforeEach(() => getAnimations.mockReset().mockReturnValue([]))
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
      {props.renderBoardIssueCard?.({
        issue,
        taskBindings: [],
        display: {} as never,
        focused: false,
        onOpen: vi.fn(),
        onMarkRead: vi.fn(),
      })}
      {props.host.location.issueId &&
        props.renderIssueDetail?.({
          api: props.api,
          project: { id: 'project' } as never,
          issue,
          allIssues: [issue],
          assignments: [],
          taskBindings: [],
          onChange: vi.fn(),
          onClose: () => props.host.navigate({ ...props.host.location, issueId: null }),
        })}
    </>
  ),
}))

vi.mock('./CloudTodoBoardCard', () => ({
  CloudTodoBoardCard: (props: ComponentProps<typeof CloudTodoBoardCard>) => (
    <>
      <button disabled={props.previewDisabled} onClick={() => props.onPreviewPinnedChange?.(true)}>
        Open progress
      </button>
      {props.previewPinned && !props.previewDisabled && <div>Board progress preview</div>}
    </>
  ),
}))

vi.mock('./TodoEditor', () => ({
  TodoEditor: (props: ComponentProps<typeof TodoEditor>) => {
    const [draft, setDraft] = useState('')
    return (
      <section
        data-testid="cloud-todo-detail"
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
    chatCallbacks.set(address?.taskId ?? 'new', props.onAddressChange)
    return (
      <aside data-testid="ai-chat-modal" data-address={props.initialAddress?.taskId}>
        <span>Conversation: {address?.taskId}</span>
        <button data-testid="ai-chat-modal-close" onClick={props.onClose}>
          Close conversation
        </button>
      </aside>
    )
  },
}))

function Project() {
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
      api={{ projects: {}, issues: {} } as never}
      project={{ id: 'project', name: 'Project', project_store: 'backend' } as never}
      workspace={{ id: 'workspace' } as never}
      localProjects={[]}
      locale="zh-CN"
      location={location}
      setLocation={setLocation}
      services={{} as never}
      runtimePort={{ bindTask: vi.fn(), unbindTask: vi.fn() }}
      userId={1}
    />
  )
}

describe('Wework Issue conversation drawers', () => {
  it('dismisses board previews when entering details without resurrecting them on return', async () => {
    const user = userEvent.setup()
    render(<Project />)
    await user.click(screen.getByText('Open progress'))
    expect(screen.getByText('Board progress preview')).toBeInTheDocument()
    await user.click(screen.getByText('Open Issue'))
    expect(screen.queryByText('Board progress preview')).not.toBeInTheDocument()
    expect(screen.getByText('Open progress')).toBeDisabled()
    await user.click(screen.getByTestId('cloud-todo-detail-close'))
    expect(screen.getByText('Open progress')).toBeEnabled()
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
