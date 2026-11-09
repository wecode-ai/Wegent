// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MilestonesPage } from '../../../../packages/collaboration/src/milestones/MilestonesPage'
import { useMilestoneFilter } from '../../../../packages/collaboration/src/milestones/useMilestoneFilter'
import type { MilestoneFilterValue } from '../../../../packages/collaboration/src/milestones/useMilestoneFilter'
import type { SharedWorkspaceApi } from '../../../../packages/collaboration/src/ports/SharedWorkspaceApi'
import type {
  CollaborationIssue,
  CollaborationProject,
} from '../../../../packages/collaboration/src/types'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

const project = { id: 'p', project_store: 'local', task_provider: 'local' } as CollaborationProject
const milestones = [
  { id: 'M1', title: 'First release', state: 'open', open_issues: 1, closed_issues: 1 },
  { id: 'M2', title: 'Next release', state: 'open', open_issues: 2, closed_issues: 0 },
]
const issues = [
  { id: 'one', title: 'First task', milestone_id: 'M1' },
  { id: 'two', title: 'Next task', milestone_id: 'M2' },
  { id: 'none', title: 'Unassigned task', milestone_id: null },
] as CollaborationIssue[]

function fixture(items = milestones) {
  return { milestones: { list: vi.fn().mockResolvedValue(items) } } as unknown as SharedWorkspaceApi
}

function renderIssues(items: CollaborationIssue[]) {
  return (
    <ul data-testid="filtered-issues">
      {items.map(item => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  )
}

function props(api = fixture()) {
  return { api, project, issues, locale: 'en' as const, renderIssues }
}

describe('controlled milestone page', () => {
  it('uses new props immediately without echoing changes or keeping a selection copy', async () => {
    const onFilterChange = vi.fn()
    const common = props()
    const view = render(
      <StrictMode>
        <MilestonesPage
          {...common}
          filter={{ milestoneId: 'M1' }}
          onFilterChange={onFilterChange}
        />
      </StrictMode>
    )
    await screen.findByText('First task')
    expect(screen.queryByText('Next task')).toBeNull()
    fireEvent.click(screen.getByTestId('milestones-filter-clear'))
    expect(onFilterChange.mock.calls).toEqual([['all']])
    expect(screen.getByText('First task')).toBeTruthy()
    view.rerender(
      <StrictMode>
        <MilestonesPage
          {...common}
          filter={{ milestoneId: 'M2' }}
          onFilterChange={onFilterChange}
        />
      </StrictMode>
    )
    expect(screen.getByText('Next task')).toBeTruthy()
    expect(screen.queryByText('First task')).toBeNull()
    expect(onFilterChange).toHaveBeenCalledTimes(1)
    view.rerender(
      <MilestonesPage {...common} filter={{ milestoneId: null }} onFilterChange={onFilterChange} />
    )
    await screen.findByText('Unassigned task')
    expect(screen.queryByText('Next task')).toBeNull()
    expect(onFilterChange).toHaveBeenCalledTimes(1)
  })

  it('emits exactly one callback when a milestone is opened', async () => {
    const onFilterChange = vi.fn()
    render(
      <MilestonesPage
        {...props()}
        filter={{ milestoneId: 'all' }}
        onFilterChange={onFilterChange}
      />
    )
    fireEvent.click(await screen.findByTestId('milestone-open-M1'))
    expect(onFilterChange.mock.calls).toEqual([['M1']])
    expect(screen.queryByTestId('filtered-issues')).toBeNull()
  })

  it('distinguishes selecting no milestone from clearing and ignores status-tab changes', async () => {
    const onFilterChange = vi.fn()
    render(
      <MilestonesPage
        {...props()}
        filter={{ milestoneId: 'all' }}
        onFilterChange={onFilterChange}
      />
    )
    await screen.findByTestId('milestone-open-M1')
    fireEvent.click(screen.getByTestId('milestones-closed'))
    fireEvent.click(screen.getByTestId('milestones-open'))
    expect(onFilterChange).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('milestones-filter')).toBeEnabled())
    fireEvent.click(screen.getByTestId('milestones-filter'))
    fireEvent.click(await screen.findByTestId('milestones-filter-option-empty'))
    await waitFor(() => expect(onFilterChange.mock.calls).toEqual([[null]]))
    expect(screen.getByTestId('milestones-filter')).toHaveTextContent('All milestones')
  })

  it('does not show unrelated milestones or clear a missing controlled id', async () => {
    const onFilterChange = vi.fn()
    render(
      <MilestonesPage
        {...props()}
        filter={{ milestoneId: 'missing' }}
        onFilterChange={onFilterChange}
      />
    )
    expect(await screen.findByTestId('milestones-empty')).toHaveTextContent(
      'No matching milestones'
    )
    expect(screen.queryByTestId('milestone-open-M1')).toBeNull()
    expect(screen.queryByTestId('milestone-open-M2')).toBeNull()
    expect(onFilterChange).not.toHaveBeenCalled()
  })

  it.each(['light', 'dark'])(
    'retains the same filtered content and progress in %s theme',
    async theme => {
      document.documentElement.dataset.theme = theme
      render(<MilestonesPage {...props()} filter={{ milestoneId: 'M1' }} />)
      await screen.findByText('First task')
      expect(screen.getByTestId('milestones-filter')).toHaveTextContent('First release')
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
      expect(screen.queryByText('Next task')).toBeNull()
      fireEvent.click(screen.getByTestId('milestones-back'))
      expect(screen.getByText('First task')).toBeTruthy()
    }
  )

  it.each([
    undefined,
    { milestoneId: 'all' },
    { milestoneId: null },
    { milestoneId: 'missing' },
  ] as Array<MilestoneFilterValue | undefined>)(
    'preserves the empty state and create action with filter %j',
    async filter => {
      const onFilterChange = vi.fn()
      render(
        <MilestonesPage
          {...props(fixture([]))}
          issues={[]}
          filter={filter}
          onFilterChange={onFilterChange}
        />
      )
      expect(await screen.findByTestId('milestones-empty')).toHaveTextContent('No milestones')
      fireEvent.click(screen.getByTestId('milestone-create'))
      expect(screen.getByTestId('milestone-form')).toBeTruthy()
      expect(onFilterChange).not.toHaveBeenCalled()
    }
  )

  it('shares a single selection across mounted and unmounted views, including no milestone and clear', async () => {
    const api = fixture()
    function ProjectViews() {
      const [view, setView] = useState('milestones')
      const selection = useMilestoneFilter('p', view, issues)
      return (
        <>
          {['milestones', 'board', 'table'].map(name => (
            <button key={name} onClick={() => setView(name)}>
              {name}
            </button>
          ))}
          {view === 'milestones' ? (
            <MilestonesPage
              {...props(api)}
              filter={selection.filter}
              onFilterChange={selection.select}
            />
          ) : (
            <>
              <button onClick={() => selection.select(null)}>No milestone</button>
              <button onClick={selection.clear}>Clear</button>
              {renderIssues(selection.filteredIssues)}
            </>
          )}
        </>
      )
    }
    render(<ProjectViews />)
    fireEvent.click(await screen.findByTestId('milestone-open-M1'))
    await screen.findByText('First task')
    for (const name of ['board', 'table', 'milestones']) {
      fireEvent.click(screen.getByRole('button', { name, exact: true }))
      await screen.findByText('First task')
      expect(screen.queryByText('Next task')).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: 'board', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'No milestone', exact: true }))
    expect(screen.getByTestId('filtered-issues')).toHaveTextContent(/^Unassigned task$/)
    fireEvent.click(screen.getByRole('button', { name: 'milestones', exact: true }))
    await screen.findByText('Unassigned task')
    expect(screen.getByTestId('milestones-filter')).toHaveTextContent('No milestone')
    fireEvent.click(screen.getByTestId('milestones-filter-clear'))
    await waitFor(() => expect(screen.queryByTestId('filtered-issues')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'table', exact: true }))
    expect(screen.getByTestId('filtered-issues').children).toHaveLength(3)
  })
})
