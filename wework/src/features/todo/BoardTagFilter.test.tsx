import userEvent from '@testing-library/user-event'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  useBoardTagFilter,
  useStandardCloudBoardController,
  type SavedBoardView,
} from '@wegent/collaboration/project-board'

const items = ['bug', 'feature', ''].map((tag, index) => ({
  id: `issue-${index}`,
  title: index === 0 ? 'Fix crash' : 'Other issue',
  tags: tag ? [tag, 'shared'] : [],
  parent_id: null,
  status: 'pending',
  priority: 'medium',
  sort_order: index,
  created_at: '2026-11-05T00:00:00Z',
  updated_at: '2026-11-05T00:00:00Z',
}))
const column = {
  key: 'pending',
  groupValue: 'pending',
  label: 'Pending',
  status: 'pending',
  dotClass: '',
}

function Harness({
  scope = 'project-a',
  query = '',
  view,
  tags = ['bug', 'feature', 'shared'],
  locale = 'zh-CN',
}: {
  scope?: string
  query?: string
  view?: SavedBoardView
  tags?: string[]
  locale?: 'zh-CN' | 'en'
}) {
  const filter = useBoardTagFilter({
    scope,
    tags,
    translate: createCollaborationTranslator(locale),
  })
  const controller = useStandardCloudBoardController({
    tagFilter: filter.tags,
    view,
    viewScope: scope,
    items,
    defaultGroupBy: 'status',
    createColumns: () => [column],
    extensions: { getSearchText: item => item.title },
    focusStorageKey: null,
    personalGroupStorageKey: null,
    tagLimitError: 'Too many tags',
    onMove: vi.fn(),
  })
  return (
    <>
      {filter.control}
      <output data-testid="results">
        {controller
          .getColumnItems(column, { ...controller.state, query })
          .map(item => item.id)
          .join(',')}
      </output>
      <output data-testid="count">{controller.filteredItems.length}</output>
      <output data-testid="group">{controller.state.groupBy}</output>
    </>
  )
}

afterEach(cleanup)

describe('quick board tag filtering', () => {
  it('matches any selected tag, preserves grouping and clears including untagged issues', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('cloud-board-tag-filter'))
    await user.click(screen.getByRole('checkbox', { name: 'bug' }))
    expect(screen.getByTestId('results')).toHaveTextContent(/^issue-0$/)
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    await user.click(screen.getByRole('checkbox', { name: 'feature' }))
    expect(screen.getByTestId('results')).toHaveTextContent(/^issue-0,issue-1$/)
    expect(screen.getByTestId('count')).toHaveTextContent('2')
    expect(screen.getByTestId('group')).toHaveTextContent('status')
    await user.click(screen.getByRole('checkbox', { name: 'bug' }))
    expect(screen.getByTestId('results')).toHaveTextContent(/^issue-1$/)
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '清除标签筛选' }))
    expect(screen.getByTestId('results')).toHaveTextContent('issue-0,issue-1,issue-2')
    expect(screen.queryByTestId('cloud-board-tag-filter-clear')).toBeNull()
    expect(screen.getByLabelText('按标签筛选')).toHaveFocus()
  })

  it('intersects search and saved views and recovers from empty results', async () => {
    const user = userEvent.setup()
    const view: SavedBoardView = {
      id: 'view',
      name: 'Features',
      columns: [],
      filter: { tags: ['feature'] },
    }
    const { rerender } = render(<Harness view={view} />)
    await user.click(screen.getByTestId('cloud-board-tag-filter'))
    await user.click(screen.getByRole('checkbox', { name: 'bug' }))
    expect(screen.getByTestId('results')).toBeEmptyDOMElement()
    await user.click(screen.getByRole('checkbox', { name: 'feature' }))
    expect(screen.getByTestId('results')).toHaveTextContent(/^issue-1$/)
    rerender(<Harness view={view} query="crash" />)
    expect(screen.getByTestId('results')).toBeEmptyDOMElement()
    rerender(<Harness query="crash" />)
    expect(screen.getByTestId('results')).toHaveTextContent(/^issue-0$/)
    expect(screen.getByTestId('count')).toHaveTextContent('2')
  })

  it('searches candidates without changing selections and supports empty search results', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('cloud-board-tag-filter'))
    expect(screen.getByRole('searchbox')).toHaveFocus()
    await user.type(screen.getByRole('searchbox'), 'BUG')
    expect(screen.getByRole('checkbox', { name: 'bug' })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: 'feature' })).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: 'bug' }))
    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'missing')
    expect(screen.getByText('没有匹配的标签')).toBeVisible()
    expect(screen.getByTestId('results')).toHaveTextContent(/^issue-0$/)
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('cloud-board-tag-filter')).toHaveFocus()
  })

  it('resets on scope changes and keeps a removed tag clearable until then', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness />)
    await user.click(screen.getByTestId('cloud-board-tag-filter'))
    await user.click(screen.getByRole('checkbox', { name: 'bug' }))
    rerender(<Harness tags={[]} />)
    expect(screen.getByRole('checkbox', { name: 'bug' })).toBeChecked()
    rerender(<Harness scope="project-b" />)
    expect(screen.queryByTestId('cloud-board-tag-filter-popover')).toBeNull()
    expect(screen.queryByTestId('cloud-board-tag-filter-clear')).toBeNull()
    rerender(<Harness />)
    expect(screen.getByTestId('cloud-board-tag-filter')).toHaveTextContent('全部标签')
    rerender(<Harness scope="project-a:view" locale="en" />)
    expect(screen.getByLabelText('Filter by tag')).toHaveTextContent('All tags')
  })
})
