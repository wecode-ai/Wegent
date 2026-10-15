import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { WorkspaceTab } from './workspaceTabs'
import {
  openWorkspaceTabWindow,
  returnWorkspaceTabToMain,
  WORKSPACE_TAB_RETURN_PREFIX,
} from './workspaceWindow'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
} from './workspaceTabTransfer'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
}))

const invokeDesktopHostMock = vi.mocked(invokeDesktopHost)
const tab: WorkspaceTab = {
  id: 'board-project-1',
  kind: 'board',
  title: '产品规划',
  contentRoute: '/todo?projectId=project-1',
  fixed: false,
}

function workspaceReturnStorageKey(): string {
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(WORKSPACE_TAB_RETURN_PREFIX)) return key
  }
  throw new Error('Workspace return request was not staged')
}

describe('openWorkspaceTabWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    invokeDesktopHostMock.mockResolvedValue(undefined)
  })

  test('creates an isolated Electron workspace window through the desktop host', async () => {
    const editor = document.createElement('textarea')
    document.body.append(editor)
    editor.focus()

    await expect(openWorkspaceTabWindow(tab)).resolves.toBe(true)

    expect(document.activeElement).not.toBe(editor)
    expect(invokeDesktopHostMock).toHaveBeenCalledWith(
      'window.openWorkspace',
      expect.objectContaining({
        label: expect.stringMatching(/^workspace-board-project-1-\d+$/),
        route: expect.stringContaining('/todo?projectId=project-1&workspaceTab=board-project-1'),
        title: '产品规划',
      })
    )
    const label = (invokeDesktopHostMock.mock.calls[0]?.[1] as { label: string }).label
    expect(JSON.parse(localStorage.getItem(`wework.workspaceTabs.v3:${label}`) ?? 'null')).toEqual({
      activeTabId: tab.id,
      tabs: [tab],
    })
    editor.remove()
  })

  test('cleans staged state when the Electron host rejects window creation', async () => {
    invokeDesktopHostMock.mockRejectedValue(new Error('window failed'))

    await expect(openWorkspaceTabWindow(tab)).rejects.toThrow('window failed')

    const label = (invokeDesktopHostMock.mock.calls[0]?.[1] as { label: string }).label
    expect(localStorage.getItem(`wework.workspaceTabs.v3:${label}`)).toBeNull()
  })

  test('reuses a stable label when restoring a fixed workspace window', async () => {
    await openWorkspaceTabWindow(
      { ...tab, fixed: true },
      { label: 'workspace-fixed-board', transferState: false }
    )

    expect(invokeDesktopHostMock).toHaveBeenCalledWith(
      'window.openWorkspace',
      expect.objectContaining({ label: 'workspace-fixed-board' })
    )
    expect(
      JSON.parse(localStorage.getItem('wework.workspaceTabs.v3:workspace-fixed-board') ?? 'null')
    ).toEqual({
      activeTabId: tab.id,
      tabs: [{ ...tab, fixed: true }],
    })
  })

  test('waits for main window acceptance and stages the draft', async () => {
    publishWorkspaceTabTransferState(tab.id, { draftInputByScope: { blank: 'draft' } })
    const returning = returnWorkspaceTabToMain(tab)
    await vi.waitFor(() => expect(localStorage.length).toBe(2))
    const key = workspaceReturnStorageKey()
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(tab)
    expect(consumeWorkspaceTabTransfer(tab.id)).toEqual({ draftInputByScope: { blank: 'draft' } })
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }))
    await expect(returning).resolves.toBeUndefined()
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('window.showMain')
  })

  test('cleans up an unaccepted return without dropping the source tab', async () => {
    vi.useFakeTimers()
    try {
      const returning = returnWorkspaceTabToMain(tab)
      const rejected = expect(returning).rejects.toThrow('Main window did not accept')
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(localStorage.length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test('rejects a main-window error and clears the staged draft', async () => {
    publishWorkspaceTabTransferState(tab.id, { draftInputByScope: { blank: 'draft' } })
    const returning = returnWorkspaceTabToMain(tab)
    const rejected = expect(returning).rejects.toThrow('Preferences failed')
    await vi.waitFor(() => expect(localStorage.length).toBe(2))
    const key = workspaceReturnStorageKey()
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: JSON.stringify({ error: 'Preferences failed' }),
      })
    )
    await rejected
    expect(consumeWorkspaceTabTransfer(tab.id)).toBeNull()
    expect(localStorage.length).toBe(0)
  })
})
