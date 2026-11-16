import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from '@wegent/collaboration'
import i18n from '@/i18n'
import { useIssueDetailDraft } from '@wegent/collaboration'
import { WeworkPersonalHome, type PersonalHomeIssueDetailContext } from './WeworkPersonalHome'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import type { ReactNode } from 'react'

afterEach(cleanup)

it('derives related Issue summary fields from its own project without copying the previous Issue', async () => {
  const original = { ...issue('original'), task_bindings: [] }
  const { renderIssueDetail } = await setup([source(vi.fn().mockResolvedValue([original]))])
  fireEvent.click(await screen.findByTestId('personal-home-issue-original'))
  act(() =>
    renderIssueDetail.mock.lastCall![0].onOpenIssue({
      id: 'related',
      cloud_project_id: 'p2',
      title: 'Related work',
    } as CollaborationIssue)
  )
  expect(renderIssueDetail.mock.lastCall![0].issue).toEqual(
    expect.objectContaining({
      id: 'related',
      project_name: 'Platform',
      has_active_task: false,
    })
  )
  expect(renderIssueDetail.mock.lastCall![0].issue).not.toHaveProperty('task_bindings')
})

it.each([0, 7])(
  'identifies the current assignee when their display name is absent: %s',
  async viewerId => {
    const assigned = { ...issue('mine'), assignee_user_id: viewerId, assignee_name: null }
    const { props, rerender } = await setup([source(vi.fn().mockResolvedValue([assigned]))])
    rerender(
      <WeworkPersonalHome
        {...props}
        userId={viewerId}
        projects={[{ ...projects[0], project_store: viewerId === 0 ? 'local' : 'backend' }]}
      />
    )
    expect(await screen.findByTestId('cloud-todo-card-assignee-mine')).toHaveTextContent('Me')
  }
)

it('replaces the single Issue tab while keeping the assistant tab', async () => {
  await setup([
    source(
      vi.fn().mockResolvedValue(Array.from({ length: 7 }, (_, index) => issue(`fifo-${index}`)))
    ),
  ])
  await screen.findByText('Issue fifo-0')
  for (let index = 0; index < 5; index++)
    fireEvent.click(screen.getByTestId(`personal-home-issue-fifo-${index}`))
  fireEvent.click(screen.getByTestId('personal-home-issue-fifo-5'))
  expect(screen.queryByTestId('personal-home-tab-fifo-0')).not.toBeInTheDocument()
  expect(screen.getByTestId('personal-home-tab-stand-in')).toBeInTheDocument()
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  fireEvent.click(screen.getByTestId('personal-home-issue-fifo-6'))
  expect(screen.queryByTestId('personal-home-tab-fifo-1')).not.toBeInTheDocument()
  expect(screen.getByTestId('personal-home-tab-fifo-6')).toHaveAttribute('aria-selected', 'true')
})

it.each(['viewer', 'source'])(
  'clears open Issue details when the %s scope changes',
  async change => {
    const { props, rerender } = await setup([source(vi.fn().mockResolvedValue([issue('private')]))])
    fireEvent.click(await screen.findByTestId('personal-home-issue-private'))
    expect(screen.getByTestId('personal-home-tab-private')).toBeInTheDocument()
    rerender(
      <WeworkPersonalHome
        {...props}
        userId={change === 'viewer' ? 8 : props.userId}
        sources={change === 'source' ? [source()] : props.sources}
      />
    )
    expect(screen.queryByTestId('personal-home-tab-private')).not.toBeInTheDocument()
    expect(screen.getByTestId('personal-home-tab-stand-in')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  }
)

it('merges attention order across stores and puts projects needing intervention first', async () => {
  const ordinary = {
    ...issue('ordinary'),
    attention_order: [3, 0, '2026-11-12T12:00:00Z'] as [number, number, string],
  }
  const pending = {
    ...issue('pending', 'p2'),
    attention_order: [1, 0, '2026-11-12T13:00:00Z'] as [number, number, string],
  }
  const intervention = {
    ...issue('intervention', 'p2'),
    attention_order: [0, 4, '2026-11-01T00:00:00Z'] as [number, number, string],
  }
  const a = source(vi.fn().mockResolvedValue([ordinary, pending]))
  const b = source(vi.fn().mockResolvedValue([intervention]))
  await setup([a, b])
  await screen.findByText('Issue intervention')
  await screen.findByText('Issue pending')
  expect(screen.getAllByTestId(/^personal-home-project-/).map(node => node.dataset.testid)).toEqual(
    ['personal-home-project-p2', 'personal-home-project-p1']
  )
  expect(screen.getAllByTestId(/^personal-home-issue-/).map(node => node.dataset.testid)).toEqual([
    'personal-home-issue-intervention',
    'personal-home-issue-pending',
    'personal-home-issue-ordinary',
  ])
  expect(a.myWork!.page).toHaveBeenCalledWith(
    expect.objectContaining({ order: 'attention', limit: 30 })
  )
})

function issue(id: string, projectId = 'p1', status = 'pending'): WorkspaceMyWorkItem {
  return {
    id,
    cloud_project_id: projectId,
    project_key: 'DEMO',
    project_name: projectId,
    sequence_number: 1,
    title: `Issue ${id}`,
    status,
    human_requests: [],
    assignee_user_id: 7,
    has_active_task: false,
  } as WorkspaceMyWorkItem
}

function source(list = vi.fn().mockResolvedValue([])) {
  return {
    myWork: {
      page: vi.fn(async () => ({ items: await list(), nextCursor: null })),
    },
  } as unknown as SharedWorkspaceApi
}

const projects = [
  { id: 'p1', name: 'Product', project_store: 'backend' },
  { id: 'p2', name: 'Platform', project_store: 'backend' },
] as CollaborationProject[]

function DraftDetail({ issue, onUpdated }: PersonalHomeIssueDetailContext) {
  const { draft, setField } = useIssueDetailDraft({
    source: issue,
    initial: { title: '', description: '', status: 'pending', priority: 'none' },
  })
  return (
    <div>
      <span>Details for {issue.id}</span>
      <input
        aria-label={`Draft ${issue.id}`}
        value={draft.description}
        onChange={event => setField('description', event.target.value)}
      />
      <button
        data-testid={`save-${issue.id}`}
        onClick={() => onUpdated({ ...issue, title: 'Updated issue' })}
      >
        Save
      </button>
    </div>
  )
}

async function setup(sources: SharedWorkspaceApi[]) {
  await i18n.changeLanguage('en')
  const renderIssueDetail = vi.fn((context: PersonalHomeIssueDetailContext) => (
    <DraftDetail {...context} />
  ))
  const props = {
    userId: 7,
    sources,
    projects,
    renderIssueDetail,
    createIssue: <div>Existing issue composer</div>,
    conversation: (active: boolean) => (
      <div>
        <span>Embedded conversation</span>
        <input aria-label="Stand-in draft" data-active={String(active)} />
      </div>
    ),
  }
  const store = new RuntimeTaskLifecycleStore()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeTaskLifecycleProvider store={store}>{children}</RuntimeTaskLifecycleProvider>
  )
  return { ...render(<WeworkPersonalHome {...props} />, { wrapper }), props, renderIssueDetail }
}

it('groups participating issues by project, filters finished work and opens the original issue', async () => {
  const open = issue('open')
  const { renderIssueDetail } = await setup([
    source(vi.fn().mockResolvedValue([open, issue('finished', 'p2', 'completed')])),
  ])
  await screen.findByText('Issue open')
  expect(screen.getByText('Product')).toBeInTheDocument()
  expect(screen.queryByText('Issue finished')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-issue-open'))
  expect(screen.getByTestId('personal-home-tab-open')).toHaveTextContent('Issue open')
  expect(screen.getByTestId('personal-home-tab-open')).toHaveAttribute(
    'title',
    'Product · #1 Issue open'
  )
  expect(screen.getByTestId('personal-home-issue-open')).not.toHaveTextContent('DEMO')
  expect(renderIssueDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({ issue: open, active: true })
  )
  expect(screen.getByTestId('personal-home')).toBeInTheDocument()
  fireEvent.change(screen.getByTestId('personal-home-filter'), { target: { value: 'all' } })
  expect(await screen.findByText('Platform')).toBeInTheDocument()
  expect(screen.getByText('Issue finished')).toBeInTheDocument()
})

it('defaults to assigned-to-me work and makes other participating issues available in their own scope', async () => {
  const other = { ...issue('other'), assignee_user_id: 8 }
  await setup([source(vi.fn().mockResolvedValue([issue('mine'), other]))])
  await screen.findByText('Issue mine')
  expect(screen.getByTestId('personal-home-scope-assigned')).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('Issue other')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-scope-participating'))
  expect(await screen.findByText('Issue other')).toBeInTheDocument()
  expect(screen.getByText('Issue mine')).toBeInTheDocument()
})

it('uses the local participation identities without treating them as cloud assignees', async () => {
  const local = { ...issue('local', 'p1'), assignee_user_id: 0 }
  const remote = { ...issue('remote', 'p2'), assignee_user_id: 0 }
  const { props, rerender } = await setup([source(vi.fn().mockResolvedValue([local, remote]))])
  rerender(
    <WeworkPersonalHome
      {...props}
      localUserIds={[0, 7]}
      projects={[{ ...projects[0], project_store: 'local' }, projects[1]]}
    />
  )
  await screen.findByText('Issue local')
  expect(screen.queryByText('Issue remote')).not.toBeInTheDocument()
})

it('replaces the Issue detail, restores its draft on reopening and closes back to the assistant', async () => {
  await setup([source(vi.fn().mockResolvedValue([issue('first'), issue('second')]))])
  await screen.findByText('Issue first')
  fireEvent.change(screen.getByLabelText('Stand-in draft'), {
    target: { value: 'Keep my conversation draft' },
  })
  fireEvent.click(screen.getByTestId('personal-home-issue-first'))
  fireEvent.change(screen.getByLabelText('Draft first'), {
    target: { value: 'Keep my issue draft' },
  })
  fireEvent.click(screen.getByTestId('personal-home-issue-second'))
  expect(screen.queryByLabelText('Draft first')).not.toBeInTheDocument()
  expect(screen.queryByTestId('personal-home-tab-first')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-issue-first'))
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  expect(screen.getByLabelText('Draft first')).toHaveValue('Keep my issue draft')
  expect(screen.getByLabelText('Stand-in draft')).toHaveAttribute('data-active', 'false')
  fireEvent.click(screen.getByTestId('personal-home-tab-stand-in'))
  expect(screen.getByLabelText('Stand-in draft')).toHaveValue('Keep my conversation draft')
  expect(screen.getByLabelText('Stand-in draft')).toHaveAttribute('data-active', 'true')
  fireEvent.click(screen.getByTestId('personal-home-tab-first'))
  fireEvent.click(screen.getByTestId('personal-home-tab-first-close-button'))
  expect(screen.getByTestId('personal-home-tab-stand-in')).toHaveAttribute('aria-selected', 'true')
})

it('keeps arrow navigation working after clicking an inner title button', async () => {
  await setup([source(vi.fn().mockResolvedValue([issue('first')]))])
  await screen.findByText('Issue first')
  fireEvent.click(screen.getByTestId('personal-home-issue-first'))
  const tab = screen.getByTestId('personal-home-tab-first')
  const button = tab.querySelector('button')!
  button.focus()
  fireEvent.click(button)
  expect(document.activeElement).toBe(tab)
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
  const assistant = screen.getByTestId('personal-home-tab-stand-in')
  expect(document.activeElement).toBe(assistant)
  expect(assistant).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(tab)
  expect(tab).toHaveAttribute('aria-selected', 'true')
})

it('keeps closed Issue drafts when a localized API wrapper changes in the same source scope', async () => {
  const items = [issue('first'), issue('second')]
  const { props, rerender } = await setup([source(vi.fn().mockResolvedValue(items))])
  const draftScope = {}
  rerender(<WeworkPersonalHome {...props} draftScope={draftScope} />)
  fireEvent.click(await screen.findByTestId('personal-home-issue-first'))
  fireEvent.change(screen.getByLabelText('Draft first'), { target: { value: 'Retained edit' } })
  fireEvent.click(screen.getByTestId('personal-home-issue-second'))
  rerender(
    <WeworkPersonalHome
      {...props}
      sources={[source(vi.fn().mockResolvedValue(items))]}
      draftScope={draftScope}
    />
  )
  fireEvent.click(await screen.findByTestId('personal-home-issue-first'))
  expect(screen.getByLabelText('Draft first')).toHaveValue('Retained edit')
})

it('updates the original list row when an issue is saved in the right workspace', async () => {
  await setup([source(vi.fn().mockResolvedValue([issue('editable')]))])
  await screen.findByText('Issue editable')
  fireEvent.click(screen.getByTestId('personal-home-issue-editable'))
  fireEvent.click(screen.getByTestId('save-editable'))
  expect(screen.getByTestId('personal-home-issue-editable')).toHaveTextContent('Updated issue')
  expect(screen.getByTestId('personal-home-tab-editable')).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByTestId('personal-home-tab-editable')).toHaveTextContent('Updated issue')
})

it('shows the updated title in the newly created pinned Issue without restoring its creation snapshot', async () => {
  const { props, rerender } = await setup([source()])
  rerender(
    <WeworkPersonalHome
      {...props}
      createdIssue={{ key: 'created', issue: issue('new'), project: projects[0] }}
    />
  )
  fireEvent.click(await screen.findByTestId('save-new'))
  expect(screen.getByTestId('personal-home-tab-new')).toHaveTextContent('Updated issue')
  expect(screen.getByTestId('personal-home-issue-new')).toHaveTextContent('Updated issue')
})

it('keeps refreshed task bindings and assignment context when pinning a newly created Issue', async () => {
  const created = issue('new')
  const refreshed = {
    ...created,
    task_bindings: [
      {
        id: 'binding',
        projectId: 'p1',
        issueId: 'new',
        deviceId: 'device',
        taskId: 'task',
        taskTitle: 'Current task',
      },
    ],
    assignment_context: { body: 'Current assignment', created_at: '2026-11-12' },
  }
  const { props, rerender } = await setup([source(vi.fn().mockResolvedValue([refreshed]))])
  await screen.findByText('Current task')
  rerender(
    <WeworkPersonalHome
      {...props}
      createdIssue={{ key: 'created', issue: created, project: projects[0] }}
    />
  )
  expect(screen.getByTestId('personal-home-task-new-binding')).toHaveTextContent('Current task')
  expect(screen.getByTestId('personal-home-assignment-new')).toHaveTextContent('Current assignment')
})

it('requests the selected ordering before pagination and keeps a newly created Issue visible across refreshes', async () => {
  const api = source(vi.fn().mockResolvedValue([issue('older')]))
  const { props, rerender } = await setup([api])
  await screen.findByText('Issue older')
  fireEvent.change(screen.getByTestId('personal-home-sort'), { target: { value: 'assignment' } })
  await waitFor(() =>
    expect(api.myWork!.page).toHaveBeenLastCalledWith(
      expect.objectContaining({ order: 'assignment' })
    )
  )
  rerender(
    <WeworkPersonalHome
      {...props}
      createdIssue={{ key: 'created', issue: issue('new'), project: projects[0] }}
    />
  )
  await screen.findByTestId('personal-home-issue-new')
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(api.myWork!.page).toHaveBeenCalledTimes(4))
  expect(screen.getAllByTestId(/^personal-home-issue-/)[0]).toHaveAttribute(
    'data-testid',
    'personal-home-issue-new'
  )
})

it('keeps the stand-in draft and tabs when creating an issue or reselecting My work', async () => {
  const { props, rerender } = await setup([source(vi.fn().mockResolvedValue([issue('retained')]))])
  await screen.findByText('Issue retained')
  fireEvent.change(screen.getByLabelText('Stand-in draft'), {
    target: { value: 'Retained conversation' },
  })
  fireEvent.click(screen.getByTestId('personal-home-issue-retained'))
  expect(screen.getByText('Existing issue composer')).toBeInTheDocument()
  expect(screen.getByTestId('personal-home-tab-retained')).toHaveAttribute('aria-selected', 'true')
  rerender(<WeworkPersonalHome {...props} entryRequestKey={1} />)
  expect(screen.getByText('Existing issue composer')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-tab-stand-in'))
  expect(screen.getByLabelText('Stand-in draft')).toHaveValue('Retained conversation')
})

it('keeps successful local work and the embedded conversation usable while cloud is pending or fails', async () => {
  let rejectCloud!: (reason: Error) => void
  const cloud = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCloud = reject
        })
    )
    .mockResolvedValue([issue('cloud', 'p2')])
  await setup([source(vi.fn().mockResolvedValue([issue('local')])), source(cloud)])
  await screen.findByText('Issue local')
  expect(screen.getByText('Embedded conversation')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Loading issues')
  await act(async () => rejectCloud(new Error('offline')))
  expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded')
  expect(screen.queryByText('No matching issues')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-retry'))
  await screen.findByText('Issue cloud')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('Issue local')).toBeInTheDocument()
})

it('never displays another source scope or applies a late response from it', async () => {
  let finishOld!: (items: WorkspaceMyWorkItem[]) => void
  const oldSource = source(
    vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          finishOld = resolve
        })
    )
  )
  const { rerender, props } = await setup([oldSource])
  const nextSources = [source(vi.fn().mockResolvedValue([issue('new')]))]
  rerender(<WeworkPersonalHome {...props} sources={nextSources} />)
  await screen.findByText('Issue new')
  await act(async () => finishOld([issue('old')]))
  expect(screen.queryByText('Issue old')).not.toBeInTheDocument()
})

it('keeps recording inline without replacing My work or the assistant', async () => {
  await setup([source()])
  expect(screen.getByText('Existing issue composer')).toBeInTheDocument()
  expect(screen.getByTestId('personal-home')).toBeInTheDocument()
  expect(screen.getByText('Embedded conversation')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('No matching issues')).toBeInTheDocument())
})

it('keeps human handoffs in the issue row without a duplicate pending-work section', async () => {
  const pending = issue('question')
  pending.human_requests = [
    { status: 'pending', recipient_user_id: 7 } as NonNullable<
      WorkspaceMyWorkItem['human_requests']
    >[number],
  ]
  await setup([source(vi.fn().mockResolvedValue([pending]))])
  await screen.findByText('Issue question')
  expect(screen.getByTestId('personal-home-issue-question')).toHaveTextContent('Needs my input')
  expect(screen.getAllByText('Needs my input')).toHaveLength(1)
})

it('does not label another participant’s pending question as needing me or replace business status with execution state', async () => {
  const pending = issue('other', 'p1', 'in_progress')
  pending.human_requests = [
    { status: 'pending', recipient_user_id: 8 } as NonNullable<
      WorkspaceMyWorkItem['human_requests']
    >[number],
  ]
  pending.has_active_task = true
  await setup([source(vi.fn().mockResolvedValue([pending]))])
  await screen.findByText('Issue other')
  expect(screen.getByTestId('personal-home-issue-other')).toHaveTextContent('In progress')
  expect(screen.queryByText('Needs my input')).not.toBeInTheDocument()
})

it('keeps cached work during refresh and exposes failure without turning it into an empty list', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce([issue('cached')])
    .mockRejectedValueOnce(new Error('offline'))
  await setup([source(list)])
  await screen.findByText('Issue cached')
  fireEvent(window, new Event('focus'))
  await screen.findByRole('alert')
  expect(screen.getByText('Issue cached')).toBeInTheDocument()
  expect(screen.queryByText('No matching issues')).not.toBeInTheDocument()
})

it('does not load or refresh issue sources while the collaboration tab is inactive', async () => {
  const list = vi.fn().mockResolvedValue([issue('active')])
  const sources = [source(list)]
  const { props, rerender } = await setup([])
  rerender(<WeworkPersonalHome {...props} sources={sources} active={false} />)
  fireEvent(window, new Event('focus'))
  await act(async () => {})
  expect(list).not.toHaveBeenCalled()
  rerender(<WeworkPersonalHome {...props} sources={sources} active />)
  await screen.findByText('Issue active')
  expect(list).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'opens the newly created Issue on the right and opens only an explicitly started task: %s',
  async withTask => {
    const task = withTask ? { deviceId: 'device', taskId: 'task' } : undefined
    const { props, rerender, renderIssueDetail } = await setup([source()])
    const created = { ...issue('created'), description: 'Original one-line request' }
    rerender(
      <WeworkPersonalHome
        {...props}
        createdIssue={{ key: 'created-once', issue: created, project: projects[0], task }}
      />
    )
    expect(screen.getByText('Existing issue composer')).toBeInTheDocument()
    expect(screen.getByTestId('personal-home-tab-created')).toHaveAttribute('aria-selected', 'true')
    expect(renderIssueDetail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        issue: created,
        taskRequest: task ? { key: 'created-once', address: task } : undefined,
      })
    )
    rerender(
      <WeworkPersonalHome
        {...props}
        createdIssue={{ key: 'created-once', issue: created, project: projects[0], task }}
      />
    )
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  }
)
