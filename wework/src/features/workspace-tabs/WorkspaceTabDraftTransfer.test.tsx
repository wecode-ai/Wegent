import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, Suspense } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { useWorkspaceTabDraftInput } from '@/features/workbench/useWorkspaceTabDraftInput'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { labels } from './workspaceTabsTestLabels'
import { WORKSPACE_TAB_RETURN_PREFIX } from './workspaceWindow'
import { publishWorkspaceTabTransferState, stageWorkspaceTabTransfer } from './workspaceTabTransfer'

const preferencesApi = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: preferencesApi.get,
  updateAppPreferences: preferencesApi.update,
}))

function DraftProbe({ tabId }: { tabId: string }) {
  const { inputs, setInput } = useWorkspaceTabDraftInput(tabId)
  return (
    <input
      data-testid={`draft-${tabId}`}
      value={inputs['blank:0'] ?? ''}
      onChange={event => setInput('blank:0', event.target.value)}
    />
  )
}

function stageDraft(tabId: string, value: string) {
  publishWorkspaceTabTransferState(tabId, { draftInputByScope: { 'blank:0': value } })
  stageWorkspaceTabTransfer(tabId)
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron', desktopWindowLabel: 'main' }
  preferencesApi.get.mockReset().mockResolvedValue(defaultAppPreferences)
  preferencesApi.update.mockReset().mockResolvedValue(defaultAppPreferences)
})

afterEach(() => vi.restoreAllMocks())

test.each([false, true])(
  'restores a returned draft into an already mounted tab before acknowledgement (fixed: %s)',
  async fixed => {
    render(
      <WorkspaceTabsProvider pathname="/" search="" storageScope="main" labels={labels}>
        <DraftProbe tabId="returned" />
        <DraftProbe tabId="unrelated" />
      </WorkspaceTabsProvider>
    )
    fireEvent.change(screen.getByTestId('draft-unrelated'), {
      target: { value: '另一个标签页正在编辑的草稿' },
    })
    stageDraft('returned', '固定标签页移回后保留的草稿')
    const key = `${WORKSPACE_TAB_RETURN_PREFIX}draft`
    const value = JSON.stringify({
      id: 'returned',
      kind: 'task',
      title: 'Returned',
      contentRoute: '/',
      fixed,
    })
    localStorage.setItem(key, value)
    let draftAtAcknowledgement: string | undefined
    const removeItem = Storage.prototype.removeItem
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      keyToRemove: string
    ) {
      if (keyToRemove === key) {
        draftAtAcknowledgement = (screen.getByTestId('draft-returned') as HTMLInputElement).value
      }
      removeItem.call(this, keyToRemove)
    })
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
    })
    expect(localStorage.getItem(key)).toBeNull()
    expect(draftAtAcknowledgement).toBe('固定标签页移回后保留的草稿')
    expect(screen.getByTestId('draft-returned')).toHaveValue('固定标签页移回后保留的草稿')
    expect(screen.getByTestId('draft-unrelated')).toHaveValue('另一个标签页正在编辑的草稿')
  }
)

test('retains an incoming draft when StrictMode checks initialization twice', () => {
  stageDraft('new-tab', '草稿必须在工作台提交后再消费')
  render(
    <StrictMode>
      <DraftProbe tabId="new-tab" />
    </StrictMode>
  )
  expect(screen.getByTestId('draft-new-tab')).toHaveValue('草稿必须在工作台提交后再消费')
})

test('keeps the transfer available until a suspended destination commits', async () => {
  stageDraft('suspended-tab', '未提交的渲染不能消费草稿')
  let ready = false
  let resume!: () => void
  const pending = new Promise<void>(resolve => {
    resume = resolve
  })
  function SuspendedDraft() {
    const { inputs } = useWorkspaceTabDraftInput('suspended-tab')
    if (!ready) throw pending
    return <input data-testid="suspended-draft" value={inputs['blank:0'] ?? ''} readOnly />
  }
  render(
    <Suspense fallback={<span>Loading</span>}>
      <SuspendedDraft />
    </Suspense>
  )
  await act(async () => {
    ready = true
    resume()
  })
  expect(screen.getByTestId('suspended-draft')).toHaveValue('未提交的渲染不能消费草稿')
})
