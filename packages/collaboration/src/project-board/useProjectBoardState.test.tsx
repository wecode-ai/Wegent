// @vitest-environment jsdom
import { act, createRef, StrictMode, useImperativeHandle, type Ref } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useProjectBoardState, type ProjectBoardStateOptions } from './useProjectBoardState'

type State = ReturnType<typeof useProjectBoardState>
const result = createRef<State>()
let root: Root
let container: HTMLDivElement
const defaults: ProjectBoardStateOptions = {
  defaultGroupBy: 'priority',
  viewScope: 'first',
  personalGroupStorageKey: 'group',
  personalSortStorageKey: 'sort',
  focusStorageKey: 'focus',
}
function Harness({ options, ref }: { options: ProjectBoardStateOptions; ref: Ref<State> }) {
  const { scrollRef, ...state } = useProjectBoardState(options)
  useImperativeHandle(ref, () => ({ ...state, scrollRef }), [state, scrollRef])
  return <div ref={scrollRef} />
}
async function render(options = defaults) {
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness options={options} ref={result} />
      </StrictMode>
    )
  )
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

test('initial committed state uses validated personal grouping and focus preferences', async () => {
  localStorage.setItem('group', 'assignee')
  localStorage.setItem('invalid-group', 'invalid')
  localStorage.setItem('focus', 'true')
  await render()
  expect(result.current).toMatchObject({ groupBy: 'assignee', focusExecutionColumns: true })
  await render({ ...defaults, personalGroupStorageKey: 'invalid-group' })
  expect(result.current?.groupBy).toBe('priority')
})

test('view changes reset only the view-local filters, search and quick-create state', async () => {
  await render()
  await act(async () => {
    result.current!.setQuery('draft')
    result.current!.setGroupFilter('high')
    result.current!.setQuickCreateStatus('open')
    result.current!.setExternalQuery('external')
    result.current!.toggleFocusExecutionColumns()
  })
  await render({ ...defaults, viewScope: 'second' })
  expect(result.current).toMatchObject({
    query: '',
    groupFilter: '',
    quickCreateStatus: null,
    externalQuery: 'external',
    focusExecutionColumns: true,
  })
})

test('changing the focus key preserves view-local search, and changing grouping defaults resets it', async () => {
  await render()
  await act(async () => {
    result.current!.setQuery('keep')
    result.current!.toggleFocusExecutionColumns()
  })
  await render({ ...defaults, focusStorageKey: 'other-focus' })
  expect(result.current).toMatchObject({ query: 'keep', focusExecutionColumns: false })
  await render({ ...defaults, defaultGroupBy: 'tag', focusStorageKey: 'other-focus' })
  expect(result.current).toMatchObject({ query: '', groupBy: 'tag' })
})

test('user grouping resets the horizontal scroll and keeps sorting scoped by grouping and column', async () => {
  await render({ ...defaults, personalSortStorageKey: null })
  await act(async () => result.current!.selectColumnSort('high', ['created-asc']))
  expect(result.current!.getColumnSort('high')).toEqual(['created-asc'])
  result.current!.scrollRef.current!.scrollLeft = 120
  await act(async () => result.current!.selectGroupBy('status'))
  expect(result.current!.scrollRef.current!.scrollLeft).toBe(0)
  expect(localStorage.getItem('group')).toBe('status')
  expect(result.current!.getColumnSort('high')).toEqual(['priority-desc'])
  await act(async () => result.current!.selectGroupBy('priority'))
  expect(result.current!.getColumnSort('high')).toEqual(['created-asc'])
})

test('new sort scopes use their own defaults and stop reading changes from the old scope', async () => {
  await render()
  await act(async () => result.current!.selectColumnSort('high', ['updated-desc']))
  await render({
    ...defaults,
    personalSortStorageKey: 'other-sort',
    defaultColumnSorts: { high: ['created-asc'] },
  })
  expect(result.current!.getColumnSort('high')).toEqual(['created-asc'])
  await act(async () => {
    localStorage.setItem(
      `sort:${JSON.stringify(['priority', 'high'])}`,
      JSON.stringify(['priority-asc'])
    )
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
  })
  expect(result.current!.getColumnSort('high')).toEqual(['created-asc'])
})

test('two toggles within one action use current preference state in StrictMode', async () => {
  await render()
  await act(async () => {
    result.current!.toggleFocusExecutionColumns()
    result.current!.toggleFocusExecutionColumns()
  })
  expect(result.current!.focusExecutionColumns).toBe(false)
  expect(localStorage.getItem('focus')).toBeNull()
})

test('hydrates with server defaults before applying personal preferences and committing legacy migration', async () => {
  act(() => root.unmount())
  localStorage.setItem('group', 'assignee')
  localStorage.setItem('focus', 'true')
  localStorage.setItem(
    'sort',
    JSON.stringify({ [JSON.stringify(['assignee', 'high'])]: ['created-asc'] })
  )
  function HydrationHarness() {
    const state = useProjectBoardState(defaults)
    return (
      <output>
        {JSON.stringify({
          group: state.groupBy,
          focus: state.focusExecutionColumns,
          sort: state.getColumnSort('high'),
        })}
      </output>
    )
  }
  container.innerHTML = renderToString(<HydrationHarness />)
  expect(container.textContent).toBe(
    JSON.stringify({ group: 'priority', focus: false, sort: ['priority-desc'] })
  )
  expect(localStorage.getItem('sort')).not.toBeNull()
  const recovered = vi.fn()
  await act(async () => {
    root = hydrateRoot(container, <HydrationHarness />, { onRecoverableError: recovered })
  })
  expect(recovered).not.toHaveBeenCalled()
  expect(container.textContent).toBe(
    JSON.stringify({ group: 'assignee', focus: true, sort: ['created-asc'] })
  )
  expect(localStorage.getItem('sort')).toBeNull()
})
