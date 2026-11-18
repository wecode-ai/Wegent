import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import type { IssueReferenceResult } from './resolveIssueReference'
import { GlobalTodoSearch } from './GlobalTodoSearch'

afterEach(cleanup)

const project = {
  id: 'project-1',
  name: 'Project',
  project_key: 'WEG',
  description: '',
  project_store: 'backend' as const,
}
const item = {
  id: 'opaque-issue-id',
  sequence_number: 123,
  title: 'Example issue',
  description: '',
  tags: [],
  parent_id: null,
  status: 'pending',
  updated_at: '2026-11-18T00:00:00Z',
} as unknown as CloudLoopItem

function setup(query: string, options: { restricted?: boolean; duplicate?: boolean } = {}) {
  const onSelectItem = vi.fn()
  const firstItem = { ...item, can_view_detail: !options.restricted }
  const secondProject = { ...project, id: 'project-2', project_key: 'OTHER' }
  render(
    <GlobalTodoSearch
      projects={options.duplicate ? [project, secondProject] : [project]}
      projectItems={{
        'backend:project-1': [firstItem],
        ...(options.duplicate ? { 'backend:project-2': [{ ...item, id: 'second' }] } : {}),
      }}
      projectMembers={{}}
      query={query}
      onQueryChange={vi.fn()}
      onClose={vi.fn()}
      onSelectProject={vi.fn()}
      onSelectItem={onSelectItem}
    />
  )
  return { onSelectItem, firstItem }
}

describe('open Issue by reference', () => {
  it.each(['WEG-123', ' weg-123 ', '#123', '123', 'opaque-issue-id'])(
    'opens the unique exact reference %s on Enter',
    query => {
      const { onSelectItem, firstItem } = setup(query)
      expect(screen.getByTestId('cloud-global-search-result-opaque-issue-id')).toHaveTextContent(
        'WEG-123'
      )
      fireEvent.keyDown(screen.getByTestId('cloud-global-search-input'), { key: 'Enter' })
      expect(onSelectItem).toHaveBeenCalledWith(project, firstItem)
    }
  )

  it.each(['#123', 'missing', 'Example'])(
    'keeps ambiguous, missing, or text results open: %s',
    query => {
      const { onSelectItem } = setup(query, { duplicate: true })
      fireEvent.keyDown(screen.getByTestId('cloud-global-search-input'), { key: 'Enter' })
      expect(onSelectItem).not.toHaveBeenCalled()
    }
  )

  it('preserves the detail permission check on Enter', () => {
    const { onSelectItem } = setup('WEG-123', { restricted: true })
    expect(screen.getByTestId('cloud-global-search-result-opaque-issue-id')).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('cloud-global-search-input'), { key: 'Enter' })
    expect(onSelectItem).not.toHaveBeenCalled()
  })

  it('does not navigate while confirming IME composition', () => {
    const { onSelectItem } = setup('WEG-123')
    fireEvent.keyDown(screen.getByTestId('cloud-global-search-input'), {
      key: 'Enter',
      isComposing: true,
    })
    expect(onSelectItem).not.toHaveBeenCalled()
  })
})

function directSearch(resolve: (reference: string) => Promise<IssueReferenceResult[]>) {
  const select = vi.fn()
  const props = {
    projects: [],
    projectItems: {},
    projectMembers: {},
    query: 'WEG-999',
    onQueryChange: vi.fn(),
    onClose: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectItem: select,
    onResolveReference: resolve,
  }
  const view = render(<GlobalTodoSearch {...props} />)
  return { ...view, props, select }
}

it.each(['mouse', 'keyboard'])('queries unloaded Issues using %s', async method => {
  const resolve = vi.fn().mockResolvedValue([{ project, item }])
  const { select } = directSearch(resolve)
  if (method === 'mouse') fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  else fireEvent.keyDown(screen.getByTestId('cloud-global-search-input'), { key: 'Enter' })
  await waitFor(() => expect(select).toHaveBeenCalledWith(project, item))
  expect(resolve).toHaveBeenCalledWith('WEG-999')
})

it('shows access/query failures and allows retry', async () => {
  const resolve = vi
    .fn()
    .mockRejectedValueOnce(new Error('403'))
    .mockResolvedValueOnce([{ project, item }])
  const { select } = directSearch(resolve)
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByRole('alert')).toHaveTextContent('403')
  expect(select).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  await waitFor(() => expect(select).toHaveBeenCalledOnce())
})

it('ignores old lookups after changing the reference', async () => {
  let finish!: (matches: IssueReferenceResult[]) => void
  const { rerender, props, select } = directSearch(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  rerender(<GlobalTodoSearch {...props} query="WEG-1000" />)
  await act(async () => finish([{ project, item }]))
  expect(select).not.toHaveBeenCalled()
})

it('does not navigate to a lookup result without detail permission', async () => {
  const { select } = directSearch(async () => [
    { project, item: { ...item, can_view_detail: false } },
  ])
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByTestId('cloud-global-search-direct-backend:project-1')).toBeDisabled()
  expect(select).not.toHaveBeenCalled()
})

it.each(['12-999', '1ABC-999'])('accepts API-supported numeric project keys: %s', async query => {
  const resolve = vi.fn().mockResolvedValue([{ project, item }])
  const select = vi.fn()
  render(
    <GlobalTodoSearch
      projects={[]}
      projectItems={{}}
      projectMembers={{}}
      query={query}
      onQueryChange={vi.fn()}
      onClose={vi.fn()}
      onSelectProject={vi.fn()}
      onSelectItem={select}
      onResolveReference={resolve}
    />
  )
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(query))
  expect(select).toHaveBeenCalledWith(project, item)
})
