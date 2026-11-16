import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import '@/i18n'
import type { ExperienceIssueData } from '../data/useExperienceIssue'
import { selectPrivateConversations, selectTaskTimeline } from '../model'
import {
  experienceBindingFixture,
  experienceHumanRequestFixture,
  experienceIssueFixture,
  experienceMessageFixture,
  experienceProjectFixture,
} from '../model/fixtures'
import { TaskTimeline } from './TaskTimeline'

afterEach(cleanup)

it.each([
  ['local', 7, [0, 7], 0],
  ['backend', undefined, 7, 7],
] as const)(
  'uses the authoritative %s reader for its actual pending question',
  (store, actor, reader, recipient) => {
    const props = fixture()
    props.data.project = experienceProjectFixture({ project_store: store, current_user_id: actor })
    props.data.participationViewer = reader
    props.data.issue.human_requests = [
      experienceHumanRequestFixture({
        recipient_user_id: recipient,
        question: 'Actual source question',
      }),
    ]
    const view = render(
      <TaskTimeline
        {...props}
        active={false}
        revision={0}
        onDiscuss={vi.fn()}
        onAttachment={vi.fn()}
        onExecution={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(view.getByTestId('collaboration-exp-current-turn')).toHaveTextContent(
      'Actual source question'
    )
  }
)

it('keeps background collapsed and presents the current reader question after the shared events', () => {
  const props = fixture()
  props.data.issue.human_requests = [
    experienceHumanRequestFixture({
      id: 'another-person',
      recipient_user_id: 8,
      question: 'Another person must decide this',
    }),
    experienceHumanRequestFixture({ question: 'Approve the actual task scope?' }),
  ]
  const onDiscuss = vi.fn()
  const view = render(
    <TaskTimeline
      {...props}
      active={false}
      revision={0}
      onDiscuss={onDiscuss}
      onAttachment={vi.fn()}
      onExecution={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  const background = view.getByTestId('collaboration-exp-background')
  expect(background).not.toHaveAttribute('open')
  fireEvent.click(background.querySelector('summary')!)
  expect(background).toHaveAttribute('open')
  expect(view.getByText('Task background')).toBeVisible()
  const turn = view.getByTestId('collaboration-exp-current-turn')
  expect(turn).toHaveTextContent('Approve the actual task scope?')
  expect(turn).not.toHaveTextContent('Another person must decide this')
  expect(
    view.getByTestId('collaboration-exp-timeline-node-message-1').compareDocumentPosition(turn) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  fireEvent.click(view.getByTestId('collaboration-exp-task-discussion-task-1'))
  expect(onDiscuss).toHaveBeenCalledWith(null, props.stream.conversations.items[0])
})

it('never presents another reader request as the current decision or exposes their private entry', () => {
  const props = fixture()
  props.data.issue.human_requests = [
    experienceHumanRequestFixture({ recipient_user_id: 8, question: 'Foreign private decision' }),
  ]
  props.stream.conversations = { state: 'hidden', items: [] }
  props.stream.timeline.nodes[0] = {
    ...props.stream.timeline.nodes[0],
    conversation: { state: 'hidden', items: [] },
  }
  const view = render(
    <TaskTimeline
      {...props}
      active={false}
      revision={0}
      onDiscuss={vi.fn()}
      onAttachment={vi.fn()}
      onExecution={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  expect(view.queryByTestId('collaboration-exp-current-turn')).toBeNull()
  expect(view.queryByText('Foreign private decision')).toBeNull()
  expect(view.queryByTestId('collaboration-exp-node-discussion-message-1-task-1')).toBeNull()
  expect(
    view.getByTestId('collaboration-exp-timeline-node-message-1').querySelector('time')
  ).toHaveAttribute('dateTime', '2026-11-02T00:00:00Z')
})

it('keeps pane focus for source selection and focuses only an explicit external request', () => {
  const props = fixture()
  const callbacks = {
    onDiscuss: vi.fn(),
    onAttachment: vi.fn(),
    onExecution: vi.fn(),
    onRetry: vi.fn(),
  }
  const content = (selectedNodeId?: string, focusRequest?: string) => (
    <>
      <button data-testid="next-pane-control">Private pane control</button>
      <TaskTimeline
        {...props}
        {...callbacks}
        active
        revision={0}
        selectedNodeId={selectedNodeId}
        focusRequest={focusRequest}
      />
    </>
  )
  const view = render(content())
  const nextPane = view.getByTestId('next-pane-control')
  nextPane.focus()
  view.rerender(content('message-1'))
  expect(document.activeElement).toBe(nextPane)
  view.rerender(content('message-1', 'external-request-1'))
  expect(document.activeElement).toBe(view.getByTestId('collaboration-exp-timeline-node-message-1'))
})

function fixture() {
  const data: ExperienceIssueData = {
    project: experienceProjectFixture(),
    issue: experienceIssueFixture({ description: 'Task background' }),
    taskBindings: [experienceBindingFixture()],
  }
  const messages = [
    experienceMessageFixture({
      content: 'A confirmed public conclusion [spec](wegent://attachments/known)',
    }),
    experienceMessageFixture({
      messageId: 'execution-1',
      sequenceNumber: 2,
      sender: { type: 'agent', id: 'private-agent', name: 'Private assistant name' },
      content: 'Private prompt and execution arguments',
      metadata: {
        runtime_turn_id: 'turn-1',
        trigger_message_id: 'message-1',
        private_prompt: 'SECRET',
      },
      runtimeAddress: { deviceId: 'device-1', taskId: 'task-1' },
    }),
  ]
  const input = { ...data, viewer: 7, messages }
  const api = {
    activity: {},
    attachments: {
      list: vi.fn().mockResolvedValue([
        { id: 'known', display_name: 'spec' },
        { id: 'unknown', display_name: 'Old file' },
      ]),
    },
  } as unknown as SharedWorkspaceApi
  return {
    data,
    api,
    stream: {
      timeline: selectTaskTimeline(input),
      conversations: selectPrivateConversations(input),
      loading: false,
      error: null,
    },
  }
}

it('renders safe shared content and a compact execution entry without private metadata', async () => {
  const props = fixture()
  const onExecution = vi.fn()
  const view = render(
    <TaskTimeline
      {...props}
      active
      revision={0}
      onDiscuss={vi.fn()}
      onAttachment={vi.fn()}
      onExecution={onExecution}
      onRetry={vi.fn()}
    />
  )
  await waitFor(() => expect(view.getByTestId('collaboration-exp-attachment-index')).toBeTruthy())
  expect(view.getByText('Task background')).toBeTruthy()
  expect(view.queryByText('Private assistant name')).toBeNull()
  expect(view.queryByText('Private prompt and execution arguments')).toBeNull()
  expect(view.queryByText('SECRET')).toBeNull()
  fireEvent.click(view.getByTestId('collaboration-exp-execution-execution-1'))
  expect(onExecution).toHaveBeenCalledWith({ deviceId: 'device-1', taskId: 'task-1' })
  expect(view.queryByRole('textbox')).toBeNull()
})

it('keeps exact attachment sources and marks an unattested file without guessing a discussion', async () => {
  const props = fixture()
  const onAttachment = vi.fn()
  const view = render(
    <TaskTimeline
      {...props}
      active
      revision={0}
      onDiscuss={vi.fn()}
      onAttachment={onAttachment}
      onExecution={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  const unknown = await view.findByTestId('collaboration-exp-attachment-unknown')
  expect(unknown.textContent).toContain('来源未知')
  fireEvent.click(unknown)
  expect(onAttachment).toHaveBeenLastCalledWith({
    id: 'unknown',
    name: 'Old file',
    sourceNodeId: null,
  })
  fireEvent.click(view.getByTestId('collaboration-exp-attachment-known'))
  expect(onAttachment).toHaveBeenLastCalledWith({
    id: 'known',
    name: 'spec',
    sourceNodeId: 'message-1',
  })
})

it('filters shared conclusions and retains filter state when a status refresh arrives', async () => {
  const props = fixture()
  const callbacks = {
    onDiscuss: vi.fn(),
    onAttachment: vi.fn(),
    onExecution: vi.fn(),
    onRetry: vi.fn(),
  }
  const view = render(<TaskTimeline {...props} {...callbacks} active revision={0} />)
  await view.findByTestId('collaboration-exp-attachment-index')
  fireEvent.click(view.getByTestId('collaboration-exp-timeline-filter-conclusions'))
  expect(view.queryByTestId('collaboration-exp-timeline-node-execution-1')).toBeNull()
  expect(view.getByTestId('collaboration-exp-timeline-node-message-1')).toBeTruthy()
  view.rerender(<TaskTimeline {...props} {...callbacks} active revision={1} />)
  expect(
    view.getByTestId('collaboration-exp-timeline-filter-conclusions').getAttribute('aria-pressed')
  ).toBe('true')
  expect(view.queryByTestId('collaboration-exp-timeline-node-execution-1')).toBeNull()
  view.rerender(
    <TaskTimeline {...props} {...callbacks} active revision={1} selectedNodeId="message-1" />
  )
  expect(view.getByTestId('collaboration-exp-timeline-filter-all')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(view.getByTestId('collaboration-exp-timeline-node-execution-1')).toBeInTheDocument()
})

it('uses the parent filter for header actions and reports changes without replacing controlled state', () => {
  const props = fixture()
  const callbacks = {
    onDiscuss: vi.fn(),
    onAttachment: vi.fn(),
    onExecution: vi.fn(),
    onRetry: vi.fn(),
    onFilterChange: vi.fn(),
  }
  const view = render(
    <TaskTimeline {...props} {...callbacks} active={false} revision={0} filter="attachments" />
  )
  expect(view.queryByTestId('collaboration-exp-timeline-node-execution-1')).toBeNull()
  expect(view.getByTestId('collaboration-exp-timeline-node-message-1')).toBeInTheDocument()
  fireEvent.click(view.getByTestId('collaboration-exp-timeline-filter-all'))
  expect(callbacks.onFilterChange).toHaveBeenCalledWith('all')
  expect(view.getByTestId('collaboration-exp-timeline-filter-attachments')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  view.rerender(<TaskTimeline {...props} {...callbacks} active={false} revision={0} filter="all" />)
  expect(view.getByTestId('collaboration-exp-timeline-node-execution-1')).toBeInTheDocument()
})

it('presents a stream failure with retry and never fabricates a successful empty timeline', () => {
  const props = fixture()
  const onRetry = vi.fn()
  const view = render(
    <TaskTimeline
      {...props}
      stream={{ ...props.stream, timeline: { state: 'unknown', nodes: [] }, error: 'Disconnected' }}
      active={false}
      revision={0}
      onDiscuss={vi.fn()}
      onAttachment={vi.fn()}
      onExecution={vi.fn()}
      onRetry={onRetry}
    />
  )
  expect(view.getByRole('alert').textContent).toContain('Disconnected')
  fireEvent.click(view.getByTestId('collaboration-exp-timeline-retry'))
  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(props.api.attachments.list as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
})
