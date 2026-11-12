import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Activity, useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { useWorkspaceTabDraftInput } from '@/features/workbench/useWorkspaceTabDraftInput'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { useWorkspaceTabs } from './workspaceTabsContextValue'
import { labels } from './workspaceTabsTestLabels'
import { WORKSPACE_TAB_RETURN_PREFIX } from './workspaceWindow'
import { publishWorkspaceTabTransferState, stageWorkspaceTabTransfer } from './workspaceTabTransfer'

const preferences = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: preferences.get,
  updateAppPreferences: preferences.update,
}))
const mounted = vi.fn()
const target = {
  id: 'handoff',
  kind: 'task' as const,
  title: 'Task',
  contentRoute: '/',
  fixed: true,
}
const other = { ...target, id: 'other' }
const requestKey = `${WORKSPACE_TAB_RETURN_PREFIX}handoff`

function stage(id: string, values: Record<string, string>) {
  publishWorkspaceTabTransferState(id, { draftInputByScope: values })
  stageWorkspaceTabTransfer(id)
}

function DraftOwner({ id }: { id: string }) {
  const draft = useWorkspaceTabDraftInput(id)
  const [count, setCount] = useState(0)
  useEffect(() => {
    mounted(id)
  }, [id])
  return (
    <div>
      <input
        data-testid={`draft-${id}`}
        value={draft.inputs['blank:0'] ?? ''}
        onChange={event => draft.setInput('blank:0', event.target.value)}
      />
      <output data-testid={`revision-${id}`}>{draft.getRevision('blank:0')}</output>
      <button data-testid={`count-${id}`} onClick={() => setCount(count + 1)}>
        {count}
      </button>
      <output data-testid={`scopes-${id}`}>{Object.keys(draft.inputs).sort().join(',')}</output>
    </div>
  )
}

function Owners({ suspendInactive }: { suspendInactive: boolean }) {
  const { tabs, activeTabId, selectTab } = useWorkspaceTabs()
  return (
    <>
      <button data-testid="select-other" onClick={() => selectTab(other.id)}>
        Other
      </button>
      {tabs.map(tab => (
        <Activity
          key={tab.id}
          mode={!suspendInactive || activeTabId === tab.id ? 'visible' : 'hidden'}
        >
          <DraftOwner id={tab.id} />
        </Activity>
      ))}
    </>
  )
}

function mount(includeTarget = true, suspendInactive = false) {
  return render(
    <WorkspaceTabsProvider
      pathname="/"
      search=""
      storageScope="handoff-test"
      fixedTabs={includeTarget ? [target, other] : [other]}
      labels={labels}
    >
      <Owners suspendInactive={suspendInactive} />
    </WorkspaceTabsProvider>
  )
}

async function receive() {
  await act(async () => {
    const value = JSON.stringify(target)
    localStorage.setItem(requestKey, value)
    window.dispatchEvent(new StorageEvent('storage', { key: requestKey, newValue: value }))
  })
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron', desktopWindowLabel: 'main' }
  preferences.get
    .mockReset()
    .mockResolvedValue({ ...defaultAppPreferences, fixedWorkspaceTabs: [target, other] })
  preferences.update.mockReset().mockResolvedValue(defaultAppPreferences)
  mounted.mockClear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete window.__WEWORK_RUNTIME_CONFIG__
})

test('applies returned drafts to an existing owner before acknowledgment without remounting', async () => {
  stage(target.id, { 'blank:0': 'old draft', obsolete: 'old context' })
  stage(other.id, { 'blank:0': 'other draft' })
  mount()
  fireEvent.click(screen.getByTestId('count-handoff'))
  const initialRevision = Number(screen.getByTestId('revision-handoff').textContent)
  const input = screen.getByTestId('draft-handoff')
  const acknowledgmentValues: string[] = []
  const remove = localStorage.removeItem.bind(localStorage)
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(key => {
    if (key === requestKey) acknowledgmentValues.push((input as HTMLInputElement).value)
    remove(key)
  })
  stage(target.id, { 'blank:0': 'new draft' })

  await receive()

  await waitFor(() => expect(input).toHaveValue('new draft'))
  expect(acknowledgmentValues).toEqual(['new draft'])
  expect(screen.getByTestId('draft-handoff')).toBe(input)
  expect(screen.getByTestId('count-handoff')).toHaveTextContent('1')
  expect(mounted.mock.calls.filter(([id]) => id === target.id)).toHaveLength(1)
  expect(screen.getByTestId('revision-handoff').textContent).toBe(String(initialRevision + 1))
  expect(screen.getByTestId('scopes-handoff').textContent).toBe('blank:0')
  expect(screen.getByTestId('draft-other')).toHaveValue('other draft')
})

test('consumes a returned draft when its owner is first mounted', async () => {
  mount(false)
  stage(target.id, { 'blank:0': 'new owner draft' })
  await receive()
  expect(screen.getByTestId('draft-handoff')).toHaveValue('new owner draft')
})

test('clears stale inputs on an empty transfer and ignores an already consumed duplicate', async () => {
  stage(target.id, { 'blank:0': 'stale' })
  mount()
  stage(target.id, {})
  await receive()
  expect(screen.getByTestId('draft-handoff')).toHaveValue('')
  fireEvent.change(screen.getByTestId('draft-handoff'), { target: { value: 'after return' } })
  await receive()
  expect(screen.getByTestId('draft-handoff')).toHaveValue('after return')
})

test('receives the draft after revealing a previously hidden owner', async () => {
  stage(target.id, { 'blank:0': 'before hiding' })
  mount(true, true)
  const input = screen.getByTestId('draft-handoff')
  fireEvent.click(screen.getByTestId('select-other'))
  stage(target.id, { 'blank:0': 'returned from another window' })

  await receive()

  expect(screen.getByTestId('draft-handoff')).toBe(input)
  expect(input).toHaveValue('returned from another window')
})
