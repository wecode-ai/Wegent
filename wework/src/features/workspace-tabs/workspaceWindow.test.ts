import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { WorkspaceTab } from './workspaceTabs'
import { openWorkspaceTabWindow } from './workspaceWindow'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
}))

const invokeDesktopHostMock = vi.mocked(invokeDesktopHost)
const tab: WorkspaceTab = {
  id: 'board-project-1',
  kind: 'board',
  title: '产品规划',
  contentRoute: '/todo?projectId=project-1',
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
})
