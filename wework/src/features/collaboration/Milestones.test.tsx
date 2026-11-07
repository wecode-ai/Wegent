// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '../../../../packages/collaboration/src/ports/SharedWorkspaceApi'
import type {
  CollaborationIssue,
  CollaborationProject,
} from '../../../../packages/collaboration/src/types'
import type {
  Milestone,
  MilestonesApi,
} from '../../../../packages/collaboration/src/milestones/types'
import { MilestonesPage } from '../../../../packages/collaboration/src/milestones/MilestonesPage'
import { MilestonePicker } from '../../../../packages/collaboration/src/milestones/MilestonePicker'
import { MilestoneBulkAction } from '../../../../packages/collaboration/src/milestones/MilestoneBulkAction'

afterEach(cleanup)

const milestone: Milestone = {
  id: 'ms-one',
  project_id: 'p1',
  title: 'Release one',
  description: 'Deliver the release',
  state: 'open',
  due_on: '2026-12-01',
  version: 2,
  open_issues: 3,
  closed_issues: 1,
}
const project = { id: 'p1', project_store: 'local', task_provider: 'local' } as CollaborationProject

function api() {
  const milestones: MilestonesApi = {
    list: vi.fn().mockResolvedValue([milestone]),
    create: vi.fn().mockResolvedValue(milestone),
    update: vi.fn().mockResolvedValue({ ...milestone, version: 3 }),
    remove: vi.fn().mockResolvedValue(undefined),
  }
  return {
    milestones,
    issues: { update: vi.fn(), get: vi.fn() },
  } as unknown as SharedWorkspaceApi & {
    milestones: MilestonesApi
  }
}

async function chooseMilestone(testId: string, value: string) {
  await waitFor(() => expect(screen.getByTestId(testId)).toBeEnabled())
  fireEvent.click(screen.getByTestId(testId))
  fireEvent.click(await screen.findByTestId(`${testId}-option-${value || 'empty'}`))
  await waitFor(() => expect(screen.getByTestId(testId)).toBeEnabled())
}

describe('Milestones', () => {
  it('keeps a named icon and selected text for the compact board filter', async () => {
    const client = api()
    const onChange = vi.fn()
    render(
      <MilestonePicker
        api={client.milestones}
        projectId="p1"
        value="all"
        onChange={onChange}
        label="里程碑"
        allLabel="全部里程碑"
        noneLabel="无里程碑"
        errorLabel="加载失败"
        retryLabel="重试"
        testId="milestone-filter"
        compact
      />
    )
    const filter = screen.getByRole('button', { name: '里程碑' })
    expect(filter).toHaveClass('project-board-compact-action')
    expect(filter.querySelector('.project-board-action-icon')).not.toBeNull()
    expect(filter.querySelector('.project-board-action-label')).toHaveTextContent('全部里程碑')
    await chooseMilestone('milestone-filter', milestone.id)
    expect(onChange).toHaveBeenCalledWith(milestone.id)
  })

  it.each(['success', 'error'] as const)(
    'hides prior permission counters immediately on downgrade, including %s recovery',
    async outcome => {
      const client = api()
      let resolveRead!: (items: Milestone[]) => void
      let rejectRead!: (error: Error) => void
      vi.mocked(client.milestones.list)
        .mockResolvedValueOnce([milestone])
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            resolveRead = resolve
            rejectRead = reject
          })
        )
      const props = { api: client, issues: [], locale: 'en' as const, renderIssues: () => null }
      const cloudProject = {
        ...project,
        project_store: 'backend' as const,
        access_role: 'Owner' as const,
      }
      const view = render(<MilestonesPage {...props} project={cloudProject} />)
      await screen.findByText('25% · 1 Completed · 3 Remaining')
      fireEvent.click(screen.getByTestId('milestone-edit-ms-one'))
      view.rerender(
        <MilestonesPage {...props} project={{ ...cloudProject, access_role: 'Viewer' }} />
      )
      expect(screen.queryByText('25% · 1 Completed · 3 Remaining')).toBeNull()
      expect(screen.queryByTestId('milestone-form')).toBeNull()
      await waitFor(() => expect(client.milestones.list).toHaveBeenCalledTimes(2))
      await act(async () => {
        if (outcome === 'error') rejectRead(new Error('offline'))
        else resolveRead([{ ...milestone, open_issues: 0, closed_issues: 0 }])
      })
      if (outcome === 'error') await screen.findByRole('alert')
      else await screen.findByText('0% · 0 Completed · 0 Remaining')
      expect(screen.queryByText('25% · 1 Completed · 3 Remaining')).toBeNull()
    }
  )

  it('isolates a late privileged read from a newer project permission scope', async () => {
    const client = api()
    let resolveOwner!: (items: Milestone[]) => void
    vi.mocked(client.milestones.list)
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveOwner = resolve
        })
      )
      .mockResolvedValueOnce([{ ...milestone, open_issues: 0, closed_issues: 0 }])
    const props = { api: client, issues: [], locale: 'en' as const, renderIssues: () => null }
    const cloudProject = {
      ...project,
      project_store: 'backend' as const,
      access_role: 'Owner' as const,
    }
    const view = render(<MilestonesPage {...props} project={cloudProject} />)
    await waitFor(() => expect(client.milestones.list).toHaveBeenCalledTimes(1))
    view.rerender(
      <MilestonesPage {...props} project={{ ...cloudProject, access_role: 'Viewer' }} />
    )
    await screen.findByText('0% · 0 Completed · 0 Remaining')
    await act(async () => resolveOwner([milestone]))
    expect(screen.queryByText('25% · 1 Completed · 3 Remaining')).toBeNull()
  })

  it('shows server-authorized progress and sends only versioned milestone fields when closing', async () => {
    const client = api()
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    await screen.findByText('Release one')
    expect(screen.getByText('25% · 1 Completed · 3 Remaining')).toBeTruthy()
    fireEvent.click(screen.getByTestId('milestone-state-ms-one'))
    await waitFor(() =>
      expect(client.milestones.update).toHaveBeenCalledWith('p1', 'ms-one', {
        title: milestone.title,
        description: milestone.description,
        due_on: milestone.due_on,
        version: 2,
        state: 'closed',
      })
    )
  })

  it('keeps deletion behind an explicit confirmation and sends its current version', async () => {
    const client = api()
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    await screen.findByText('Release one')
    fireEvent.click(screen.getByTestId('milestone-delete-ms-one'))
    expect(client.milestones.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('milestone-delete-confirm'))
    await waitFor(() => expect(client.milestones.remove).toHaveBeenCalledWith('p1', 'ms-one', 2))
  })

  it('hides management from cloud viewers and recovers a failed list without displaying an empty success', async () => {
    const client = api()
    vi.mocked(client.milestones.list).mockRejectedValueOnce(new Error('offline'))
    render(
      <MilestonesPage
        api={client}
        project={{ ...project, project_store: 'backend', access_role: 'Viewer' }}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    await screen.findByRole('alert')
    expect(screen.queryByTestId('milestone-create')).toBeNull()
    expect(screen.queryByText('No milestones')).toBeNull()
    fireEvent.click(screen.getByTestId('milestones-retry'))
    await screen.findByText('Release one')
    expect(screen.queryByTestId('milestone-delete-ms-one')).toBeNull()
  })

  it('creates a milestone with a date and description through the owning project', async () => {
    const client = api()
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    fireEvent.click(screen.getByTestId('milestone-create'))
    fireEvent.change(screen.getByTestId('milestone-title'), { target: { value: ' v2 ' } })
    fireEvent.change(screen.getByTestId('milestone-description'), {
      target: { value: 'Next release' },
    })
    fireEvent.change(screen.getByTestId('milestone-due'), { target: { value: '2027-01-01' } })
    fireEvent.submit(screen.getByTestId('milestone-form'))
    await waitFor(() =>
      expect(client.milestones.create).toHaveBeenCalledWith('p1', {
        title: 'v2',
        description: 'Next release',
        due_on: '2027-01-01',
        state: 'open',
      })
    )
  })

  it('discards late picker results after switching projects', async () => {
    const client = api()
    let resolveFirst!: (items: Milestone[]) => void
    vi.mocked(client.milestones.list)
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveFirst = resolve
        })
      )
      .mockResolvedValueOnce([
        { ...milestone, id: 'ms-two', project_id: 'p2', title: 'Project two' },
      ])
    const props = {
      api: client.milestones,
      value: null,
      onChange: vi.fn(),
      label: 'Milestone',
      noneLabel: 'None',
      retryLabel: 'Retry',
      errorLabel: 'Failed',
    }
    const view = render(<MilestonePicker {...props} projectId="p1" />)
    view.rerender(<MilestonePicker {...props} projectId="p2" />)
    await waitFor(() => expect(screen.getByTestId('issue-milestone')).toBeEnabled())
    fireEvent.click(screen.getByTestId('issue-milestone'))
    await screen.findByText('Project two')
    await act(async () => resolveFirst([milestone]))
    expect(screen.queryByText('Release one')).toBeNull()
    expect(screen.getByText('Project two')).toBeTruthy()
  })

  it('refreshes the editor version after a conflict instead of resubmitting a stale form', async () => {
    const client = api()
    vi.mocked(client.milestones.list)
      .mockResolvedValueOnce([milestone])
      .mockResolvedValueOnce([{ ...milestone, title: 'Server edited', version: 3 }])
    vi.mocked(client.milestones.update).mockRejectedValueOnce(new Error('version conflict'))
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    await screen.findByText('Release one')
    fireEvent.click(screen.getByTestId('milestone-edit-ms-one'))
    fireEvent.submit(screen.getByTestId('milestone-form'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTestId('milestones-retry'))
    await screen.findByText('Server edited')
    expect(screen.queryByTestId('milestone-form')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByTestId('milestone-edit-ms-one'))
    fireEvent.submit(screen.getByTestId('milestone-form'))
    await waitFor(() =>
      expect(client.milestones.update).toHaveBeenLastCalledWith(
        'p1',
        'ms-one',
        expect.objectContaining({ version: 3 })
      )
    )
  })

  it('keeps archived completion visible and opens the existing archive from details', async () => {
    const client = api()
    vi.mocked(client.milestones.list).mockResolvedValue([
      { ...milestone, open_issues: 0, closed_issues: 1, archived_issues: 1 },
    ])
    const openArchive = vi.fn()
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={(_issues, _assignments, emptyLabel) => <p>{emptyLabel}</p>}
        onOpenArchive={openArchive}
      />
    )
    await screen.findByText('100% · 1 Completed · 0 Remaining · 1 archived, included in progress')
    fireEvent.click(screen.getByTestId('milestone-open-ms-one'))
    expect(screen.getByText('No unarchived linked Issues')).toBeTruthy()
    fireEvent.click(screen.getByTestId('milestone-view-archive'))
    expect(openArchive).toHaveBeenCalledOnce()
  })

  it('invalidates an older pending list after creating a milestone', async () => {
    const client = api()
    let resolveOld!: (items: Milestone[]) => void
    vi.mocked(client.milestones.list)
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveOld = resolve
        })
      )
      .mockResolvedValueOnce([{ ...milestone, title: 'Fresh release' }])
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    await waitFor(() => expect(client.milestones.list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('milestone-create'))
    fireEvent.change(screen.getByTestId('milestone-title'), { target: { value: 'Fresh release' } })
    fireEvent.submit(screen.getByTestId('milestone-form'))
    await screen.findByText('Fresh release')
    await act(async () => resolveOld([milestone]))
    expect(screen.queryByText('Release one')).toBeNull()
    expect(client.milestones.list).toHaveBeenCalledTimes(2)
  })

  it('separates pending reads when the account changes on the same transport', async () => {
    const client = api()
    let scope = 'first-user'
    client.milestones.getCacheScope = () => scope
    let resolveOld!: (items: Milestone[]) => void
    vi.mocked(client.milestones.list)
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveOld = resolve
        })
      )
      .mockResolvedValueOnce([{ ...milestone, title: 'Second user release' }])
    const props = {
      api: client.milestones,
      projectId: 'p1',
      value: null,
      onChange: vi.fn(),
      label: 'Milestone',
      noneLabel: 'None',
      retryLabel: 'Retry',
      errorLabel: 'Failed',
    }
    const view = render(<MilestonePicker {...props} />)
    await waitFor(() => expect(client.milestones.list).toHaveBeenCalledTimes(1))
    scope = 'second-user'
    view.rerender(<MilestonePicker {...props} />)
    await waitFor(() => expect(screen.getByTestId('issue-milestone')).toBeEnabled())
    fireEvent.click(screen.getByTestId('issue-milestone'))
    await screen.findByText('Second user release')
    await act(async () => resolveOld([milestone]))
    expect(screen.queryByText('Release one')).toBeNull()
  })

  it('reports each failed bulk update while publishing successful updates', async () => {
    const client = api()
    const issues = [
      { id: 'I-1', title: 'First delivery', version: 1 },
      { id: 'I-2', title: 'Second delivery', version: 2 },
    ] as CollaborationIssue[]
    vi.mocked(client.issues.update)
      .mockResolvedValueOnce({ ...issues[0], milestone_id: milestone.id })
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce({ ...issues[1], version: 4, milestone_id: milestone.id })
    vi.mocked(client.issues.get).mockResolvedValue({ ...issues[1], version: 3 })
    const updated = vi.fn()
    render(
      <MilestoneBulkAction
        api={client}
        projectId="p1"
        issues={issues}
        locale="en"
        onUpdated={updated}
      />
    )
    expect(screen.getByTestId('milestone-bulk-apply')).toBeDisabled()
    await chooseMilestone('milestone-bulk-select', milestone.id)
    fireEvent.click(screen.getByTestId('milestone-bulk-apply'))
    expect((await screen.findByRole('alert')).textContent).toContain('Second delivery')
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(2))
    expect(client.issues.update).toHaveBeenCalledWith('I-2', {
      version: 2,
      milestoneId: milestone.id,
    })
    fireEvent.click(screen.getByTestId('milestone-bulk-apply'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(client.issues.update).toHaveBeenLastCalledWith('I-2', {
      version: 3,
      milestoneId: milestone.id,
    })
    expect(client.issues.update).toHaveBeenCalledTimes(3)
  })

  it('prevents accidental unlinking while a milestone list is unavailable', async () => {
    const client = api()
    vi.mocked(client.milestones.list).mockRejectedValue(new Error('offline'))
    render(
      <MilestoneBulkAction
        api={client}
        projectId="p1"
        issues={[{ id: 'I-1', version: 1, milestone_id: milestone.id } as CollaborationIssue]}
        locale="en"
        onUpdated={vi.fn()}
      />
    )
    expect(screen.getByTestId('milestone-bulk-apply')).toBeDisabled()
    await screen.findByRole('alert')
    expect(screen.getByTestId('milestone-bulk-apply')).toBeDisabled()
    fireEvent.click(screen.getByTestId('milestone-bulk-apply'))
    expect(client.issues.update).not.toHaveBeenCalled()
  })

  it('publishes a batch together before moved Issues leave the current milestone filter', async () => {
    const client = api()
    const issues = [
      { id: 'I-1', version: 1, milestone_id: 'previous' },
      { id: 'I-2', version: 1, milestone_id: 'previous' },
    ] as CollaborationIssue[]
    const resolvers: Array<(issue: CollaborationIssue) => void> = []
    vi.mocked(client.issues.update).mockImplementation(
      () => new Promise(resolve => resolvers.push(resolve))
    )
    const updated = vi.fn()
    render(
      <MilestoneBulkAction
        api={client}
        projectId="p1"
        issues={issues}
        locale="en"
        onUpdated={updated}
      />
    )
    await chooseMilestone('milestone-bulk-select', milestone.id)
    fireEvent.click(screen.getByTestId('milestone-bulk-apply'))
    await waitFor(() => expect(resolvers).toHaveLength(2))
    await act(async () => resolvers[0]({ ...issues[0], milestone_id: milestone.id }))
    expect(updated).not.toHaveBeenCalled()
    await act(async () => resolvers[1]({ ...issues[1], milestone_id: milestone.id }))
    await waitFor(() => expect(updated).toHaveBeenCalledTimes(2))
  })

  it('leaves retry mode when the failed Issue is no longer selected', async () => {
    const client = api()
    const failed = { id: 'I-1', title: 'Failed delivery', version: 1 } as CollaborationIssue
    vi.mocked(client.issues.update).mockRejectedValue(new Error('conflict'))
    vi.mocked(client.issues.get).mockResolvedValue(failed)
    const props = {
      api: client,
      projectId: 'p1',
      issues: [failed],
      locale: 'en' as const,
      onUpdated: vi.fn(),
    }
    const view = render(<MilestoneBulkAction {...props} />)
    await chooseMilestone('milestone-bulk-select', milestone.id)
    fireEvent.click(screen.getByTestId('milestone-bulk-apply'))
    await screen.findByRole('alert')
    view.rerender(<MilestoneBulkAction {...props} issues={[{ ...failed, id: 'I-2' }]} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('milestone-bulk-apply')).toHaveTextContent(/^Apply milestone$/)
  })
})

it('separates list controls from milestone detail and retains a clear empty closed state', async () => {
  render(
    <MilestonesPage
      api={api()}
      project={project}
      issues={[]}
      locale="en"
      renderIssues={() => null}
    />
  )
  await screen.findByTestId('milestone-open-ms-one')
  expect(screen.getByRole('heading', { name: 'Milestones' })).toBeTruthy()
  fireEvent.click(screen.getByTestId('milestone-open-ms-one'))
  expect(screen.queryByTestId('milestones-toolbar')).toBeNull()
  expect(screen.queryByTestId('milestone-create')).toBeNull()
  expect(screen.getByTestId('milestones-back')).toBeTruthy()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  fireEvent.click(screen.getByTestId('milestones-back'))
  fireEvent.click(screen.getByTestId('milestones-closed'))
  expect(screen.getByTestId('milestones-empty')).toHaveTextContent('No closed milestones')
})

it.each([
  { open: 3, completed: 0, percent: 0 },
  { open: 0, completed: 0, percent: 0 },
  { open: 1, completed: 1, percent: 50 },
  { open: 0, completed: 2, percent: 100 },
])(
  'renders a determinate $percent% milestone fill for $completed completed and $open remaining',
  async ({ open, completed, percent }) => {
    const client = api()
    vi.mocked(client.milestones.list).mockResolvedValue([
      { ...milestone, open_issues: open, closed_issues: completed },
    ])
    render(
      <MilestonesPage
        api={client}
        project={project}
        issues={[]}
        locale="en"
        renderIssues={() => null}
      />
    )
    const progress = await screen.findByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuenow', String(percent))
    expect(progress).toHaveAttribute('aria-valuemin', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    expect(screen.getByTestId('milestone-progress-fill-ms-one')).toHaveStyle({
      width: `${percent}%`,
    })
  }
)
