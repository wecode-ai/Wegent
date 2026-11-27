import { useLayoutEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import type { IssueReferenceLookup } from './resolveIssueReference'
import { GlobalTodoSearch } from './GlobalTodoSearch'

afterEach(cleanup)

const project = {
  id: 'project-1',
  name: 'Project',
  project_key: 'WEG',
  description: '',
  project_store: 'backend' as const,
  location: 'cloud' as const,
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

function directSearch(
  resolve: (reference: string) => Promise<IssueReferenceLookup>,
  query = 'WEG-999'
) {
  const select = vi.fn()
  const props = {
    projects: [],
    projectItems: {},
    projectMembers: {},
    query,
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
  const resolve = vi.fn().mockResolvedValue({ matches: [{ project, item }], failures: [] })
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
    .mockResolvedValueOnce({ matches: [{ project, item }], failures: [] })
  const { select } = directSearch(resolve)
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByRole('alert')).toHaveTextContent('403')
  expect(select).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  await waitFor(() => expect(select).toHaveBeenCalledOnce())
})

it('ignores old lookups after changing the reference', async () => {
  let finish!: (result: IssueReferenceLookup) => void
  const { rerender, props, select } = directSearch(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  rerender(<GlobalTodoSearch {...props} query="WEG-1000" />)
  await act(async () => finish({ matches: [{ project, item }], failures: [] }))
  expect(select).not.toHaveBeenCalled()
})

it('allows a new lookup after returning to an abandoned reference', async () => {
  let finish!: (result: IssueReferenceLookup) => void
  const resolve = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<IssueReferenceLookup>(done => {
          finish = done
        })
    )
    .mockResolvedValueOnce({ matches: [{ project, item }], failures: [] })
  const { rerender, props, select } = directSearch(resolve)
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  rerender(<GlobalTodoSearch {...props} query="WEG-1000" />)
  await act(async () => finish({ matches: [{ project, item }], failures: [] }))
  rerender(<GlobalTodoSearch {...props} />)
  expect(screen.getByTestId('cloud-global-search-open-issue')).toBeEnabled()
  fireEvent.keyDown(screen.getByTestId('cloud-global-search-input'), { key: 'Enter' })
  await waitFor(() => expect(select).toHaveBeenCalledWith(project, item))
  expect(resolve).toHaveBeenCalledTimes(2)
})

it('does not navigate to a lookup result without detail permission', async () => {
  const { select } = directSearch(async () => ({
    matches: [{ project, item: { ...item, can_view_detail: false } }],
    failures: [],
  }))
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByTestId('cloud-global-search-direct-backend:project-1')).toBeDisabled()
  expect(select).not.toHaveBeenCalled()
})

it.each(['12-999', '1ABC-999'])('accepts API-supported numeric project keys: %s', async query => {
  const resolve = vi.fn().mockResolvedValue({ matches: [{ project, item }], failures: [] })
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

it('retains matches with source labels after a partial lookup failure and permits explicit choice', async () => {
  const { select } = directSearch(async () => ({
    matches: [{ project, item }],
    failures: [{ location: 'local', message: 'Connection lost' }],
  }))
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
  expect(select).not.toHaveBeenCalled()
  const choice = screen.getByTestId('cloud-global-search-direct-backend:project-1')
  expect(choice).toHaveTextContent('云端')
  fireEvent.click(choice)
  expect(select).toHaveBeenCalledWith(project, item)
})

it('clears pending lookup results when its account scope remounts', async () => {
  let finish!: (result: IssueReferenceLookup) => void
  const { rerender, props, select } = directSearch(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  rerender(<GlobalTodoSearch key="new-account" {...props} />)
  await act(async () => finish({ matches: [{ project, item }], failures: [] }))
  expect(select).not.toHaveBeenCalled()
  expect(
    screen.queryByTestId('cloud-global-search-direct-backend:project-1')
  ).not.toBeInTheDocument()
})

it('distinguishes identical references from local and cloud sources', async () => {
  const localProject = { ...project, location: 'local' as const, project_store: 'local' as const }
  const { select } = directSearch(async () => ({
    matches: [
      { project, item },
      { project: localProject, item },
    ],
    failures: [],
  }))
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByTestId('cloud-global-search-direct-local:project-1')).toHaveTextContent(
    '本地'
  )
  expect(screen.getByTestId('cloud-global-search-direct-backend:project-1')).toHaveTextContent(
    '云端'
  )
  expect(select).not.toHaveBeenCalled()
})

it('reports a missing or inaccessible reference', async () => {
  const { select } = directSearch(async () => ({ matches: [], failures: [] }))
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Issue 不存在或你没有访问权限')
  expect(select).not.toHaveBeenCalled()
})

it('completes a lookup submitted before passive effects have run', async () => {
  const select = vi.fn()
  function EarlySubmit() {
    useLayoutEffect(() => {
      screen.getByTestId('cloud-global-search-open-issue').click()
    }, [])
    return (
      <GlobalTodoSearch
        projects={[]}
        projectItems={{}}
        projectMembers={{}}
        query="WEG-999"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectItem={select}
        onResolveReference={async () => ({ matches: [{ project, item }], failures: [] })}
      />
    )
  }
  render(<EarlySubmit />)
  await waitFor(() => expect(select).toHaveBeenCalledWith(project, item))
})

it('invalidates queries and displayed results when source scope changes without remounting', async () => {
  let finish!: (result: IssueReferenceLookup) => void
  const { props, rerender, select } = directSearch(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
  rerender(<GlobalTodoSearch {...props} lookupScope="new-backend" />)
  await act(async () => finish({ matches: [{ project, item }], failures: [] }))
  expect(select).not.toHaveBeenCalled()
  expect(
    screen.queryByTestId('cloud-global-search-direct-backend:project-1')
  ).not.toBeInTheDocument()
  expect(screen.getByTestId('cloud-global-search-open-issue')).toBeEnabled()
})

it.each([
  ['team.web-999', 'TEAM.WEB-999'],
  ['team:beta-999', 'TEAM:BETA-999'],
  ['工程-999', '工程-999'],
  ['café-999', 'CAFé-999'],
])(
  'accepts native project-key references without changing Unicode: %s',
  async (query, reference) => {
    const resolve = vi.fn().mockResolvedValue({ matches: [{ project, item }], failures: [] })
    const { select } = directSearch(resolve, query)
    fireEvent.click(screen.getByTestId('cloud-global-search-open-issue'))
    await waitFor(() => expect(select).toHaveBeenCalledWith(project, item))
    expect(resolve).toHaveBeenCalledWith(reference)
  }
)
