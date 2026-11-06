import { getWorkspaceCodeText, installPierreEditorTestPlatform } from '@/test/pierreCode'
import { registerMcpAppPanel } from '@/features/mcp-apps/workspacePanels'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor } from '@pierre/diffs/edit'
import type { ComponentProps } from 'react'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { FileWorkspacePanel } from './FileWorkspacePanel'
import { RightWorkspacePanel } from './RightWorkspacePanel'

beforeAll(installPierreEditorTestPlatform)
vi.mock('@/components/code/PierreCodeProvider', () => ({
  PierreCodeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('./WorkspaceBrowserPanelContainer', () => ({
  WorkspaceBrowserPanel: ({
    active,
    transferredUrl,
    onUrlChange,
  }: {
    active: boolean
    transferredUrl?: string | null
    onUrlChange?: (url: string | null) => void
  }) => (
    <button
      type="button"
      data-testid="workspace-browser-panel"
      data-active={String(active)}
      data-transferred-url={transferredUrl ?? ''}
      onClick={() => onUrlChange?.('https://example.test/next')}
    />
  ),
}))

vi.mock('./WorkspaceAddMenu', () => ({
  WorkspaceAddMenu: () => <button data-testid="right-workspace-new-tab-button" />,
}))

const browserState = {
  label: 'workspace-browser-runtime-1',
  browserSessionId: '1',
  url: 'https://www.baidu.com/',
  title: 'Baidu',
  faviconUrl: null,
  isLoading: false,
  hasActiveDownload: false,
  openRequest: null,
}

test.each([false, true])(
  'saves the reloaded document against its matching disk revision (older save pending: %s)',
  async pendingSave => {
    const edit = vi.spyOn(Editor.prototype, 'edit')
    const target: WorkspaceTarget = { deviceId: 'fixture', path: '/repo', source: 'project' }
    const initial = {
      path: '/repo/file.ts',
      name: 'file.ts',
      content: 'const old = 1',
      revision: 'revision-1',
      editable: true,
      truncated: false,
      size: 13,
    }
    const external = { ...initial, content: 'const external = 2', revision: 'revision-2' }
    let finishOlderSave!: (file: typeof initial) => void
    const olderSave = new Promise<typeof initial>(resolve => {
      finishOlderSave = resolve
    })
    const api = {
      listWorkspaceEntries: vi.fn(async () => ({ path: target.path, entries: [] })),
      readWorkspaceTextFile: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(external),
      writeWorkspaceTextFile: vi.fn(async (_device: string, _path: string, content: string) => ({
        ...external,
        content,
        revision: 'revision-3',
      })),
    }
    const panel = (id: number) => (
      <FileWorkspacePanel
        target={target}
        workspaceFileApi={api}
        openFileRequest={{ path: initial.path, id }}
        onAddCodeComment={vi.fn()}
      />
    )
    const attachedEditor = async () => {
      await waitFor(() =>
        expect(
          document
            .querySelector('diffs-container')
            ?.shadowRoot?.querySelector('[data-testid="workspace-file-editor-content"]')
        ).not.toBeNull()
      )
      return edit.mock.contexts.at(-1) as Editor
    }
    const insert = (editor: Editor, text: string) =>
      act(() =>
        editor.applyEdits([
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: text,
          },
        ])
      )
    const save = () =>
      fireEvent.keyDown(screen.getByTestId('workspace-file-editor'), { key: 's', ctrlKey: true })
    try {
      const { rerender } = render(panel(1))
      await waitFor(() => expect(getWorkspaceCodeText()).toContain(initial.content))
      if (pendingSave) {
        api.writeWorkspaceTextFile.mockImplementationOnce(() => olderSave)
        insert(await attachedEditor(), '// before reload\n')
        save()
        await waitFor(() => expect(api.writeWorkspaceTextFile).toHaveBeenCalledOnce())
      }
      rerender(panel(2))
      if (pendingSave) {
        expect(api.readWorkspaceTextFile).toHaveBeenCalledOnce()
        await act(async () =>
          finishOlderSave({
            ...initial,
            content: `// before reload\n${initial.content}`,
            revision: 'older-save',
          })
        )
        await waitFor(() =>
          expect(screen.queryByTestId('workspace-file-saving-status')).not.toBeInTheDocument()
        )
      }
      await waitFor(() => expect(getWorkspaceCodeText()).toContain(external.content))
      const editor = await attachedEditor()
      insert(editor, '// next\n')
      save()
      await waitFor(() =>
        expect(api.writeWorkspaceTextFile).toHaveBeenLastCalledWith(
          target.deviceId,
          initial.path,
          `// next\n${external.content}`,
          external.revision
        )
      )
      await waitFor(() =>
        expect(screen.queryByTestId('workspace-file-saving-status')).not.toBeInTheDocument()
      )
      expect(api.readWorkspaceTextFile).toHaveBeenCalledTimes(2)
    } finally {
      edit.mockRestore()
    }
  }
)

function renderPanel(overrides: Partial<ComponentProps<typeof RightWorkspacePanel>> = {}) {
  const noop = vi.fn()
  return render(
    <RightWorkspacePanel
      visible
      renderTabsInAppTitlebar={false}
      activeView="browser:1"
      openTabs={['browser:1']}
      currentProject={null}
      canBrowseFiles
      currentRuntimeTask={null}
      devices={[]}
      workspaceTarget={null}
      workspaceFileApi={{} as ComponentProps<typeof RightWorkspacePanel>['workspaceFileApi']}
      workspaceTargetError="Workspace is not ready"
      review={{ loading: false, diff: '' }}
      extensionScope={{ sessionId: 'test' }}
      browserStates={{ 'browser:1': browserState }}
      onBrowserStateChange={noop}
      canOpenReview={false}
      onAddCodeComment={noop}
      onSelectReview={noop}
      onSelectTerminal={noop}
      onSelectBrowser={noop}
      onSelectFiles={noop}
      onSelectChat={noop}
      onSelectPlan={noop}
      onSelectTab={noop}
      onCloseTab={noop}
      {...overrides}
    />
  )
}

describe('MCP App workspace panels', () => {
  test.each([
    { deviceId: 'device', taskId: 'task', paneId: 'single', mounted: true },
    { deviceId: 'other', taskId: 'task', paneId: 'single', mounted: false },
    { deviceId: 'device', taskId: 'other', paneId: 'single', mounted: false },
    { deviceId: 'device', taskId: 'task', paneId: 'other', mounted: false },
  ])(
    'mounts an app only in its owning task and device: %j',
    ({ deviceId, taskId, paneId, mounted }) => {
      const frame = document.createElement('iframe')
      frame.dataset.testid = 'owned-app-frame'
      const attach = vi.fn((anchor: HTMLDivElement) => {
        anchor.append(frame)
        return () => frame.remove()
      })
      const dispose = registerMcpAppPanel({
        id: 'mcp-app:owned',
        address: { deviceId: 'device', taskId: 'task' },
        paneId,
        title: 'Counter App',
        attach,
        dismiss: vi.fn(),
      })
      const view = renderPanel({
        currentRuntimeTask: { deviceId, taskId },
        activeView: 'mcp-app:owned',
        openTabs: ['mcp-app:owned'],
      })
      try {
        expect(attach).toHaveBeenCalledTimes(mounted ? 1 : 0)
        if (mounted) {
          expect(screen.getByTestId('mcp-app-workspace-panel')).toContainElement(frame)
          expect(frame).toBeVisible()
        } else expect(screen.queryByTestId('owned-app-frame')).not.toBeInTheDocument()
      } finally {
        view.unmount()
        dispose()
      }
    }
  )
})

describe('RightWorkspacePanel workspace target errors', () => {
  test.each([
    { userAgent: 'Macintosh', review: '⌥⌘R', browser: '⌘T', chat: '⌥⌘S', files: '⌥⌘F' },
    {
      userAgent: 'Windows',
      review: 'Alt+Ctrl+R',
      browser: 'Ctrl+T',
      chat: 'Alt+Ctrl+S',
      files: 'Alt+Ctrl+F',
    },
    {
      userAgent: 'Linux',
      review: 'Alt+Ctrl+R',
      browser: 'Ctrl+T',
      chat: 'Alt+Ctrl+S',
      files: 'Alt+Ctrl+F',
    },
  ])('shows platform shortcuts for $userAgent', ({ userAgent, review, browser, chat, files }) => {
    const platform = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    try {
      renderPanel({ activeView: 'launcher', openTabs: [], allowTemporaryChat: true })
      expect(screen.getByTestId('right-workspace-review-option')).toHaveTextContent(review)
      expect(screen.getByTestId('right-workspace-browser-option')).toHaveTextContent(browser)
      expect(screen.getByTestId('right-workspace-chat-option')).toHaveTextContent(chat)
      expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent(files)
    } finally {
      platform.mockRestore()
    }
  })

  test.each(['pnpm dev', '/opt/homebrew/bin/zsh -lc "pnpm dev"'])(
    'keeps an exited background terminal open with its actual command title: %s',
    command => {
      const tabId = 'background-terminal:task-1:command-1' as const
      const onCloseTab = vi.fn()
      renderPanel({
        activeView: tabId,
        openTabs: [tabId],
        onCloseTab,
        backgroundTerminals: [
          {
            id: 'command-1',
            tabId,
            command,
            cwd: '/project',
            running: false,
            background: false,
            block: {
              id: 'command-1',
              type: 'tool',
              toolName: 'bash',
              status: 'done',
              createdAt: 1,
            },
          },
        ],
      })

      expect(screen.getByTestId(`right-workspace-${tabId}-tab`)).toHaveTextContent('pnpm dev')
      expect(screen.getByTestId(`right-workspace-${tabId}-tab`)).not.toHaveTextContent(' -lc ')
      expect(screen.getByTestId(`right-workspace-${tabId}-tab`)).toHaveAttribute('title', command)
      expect(screen.getByRole('region', { name: 'pnpm dev' })).toBeInTheDocument()
      screen.getByTestId(`right-workspace-${tabId}-tab-close-button`).click()
      expect(onCloseTab).toHaveBeenCalledWith(tabId)
      expect(screen.queryByTestId('workspace-target-error')).not.toBeInTheDocument()
    }
  )

  test('does not mount the file error beside an active browser', () => {
    renderPanel()

    expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute('data-active', 'true')
    expect(screen.queryByTestId('workspace-target-error')).not.toBeInTheDocument()
    expect(screen.queryByText('Workspace is not ready')).not.toBeInTheDocument()
  })

  test('passes the transferred URL into the first browser render', () => {
    const onBrowserStateChange = vi.fn()
    renderPanel({
      browserTransferSourceLabels: { 'browser:1': 'workspace-browser-blank-0' },
      onBrowserStateChange,
    })

    const browserPanel = screen.getByTestId('workspace-browser-panel')
    expect(browserPanel).toHaveAttribute('data-transferred-url', 'https://www.baidu.com/')
    browserPanel.click()
    expect(onBrowserStateChange).toHaveBeenCalledWith('browser:1', {
      url: 'https://example.test/next',
    })
  })

  test('shows the workspace target error on the files tab', () => {
    renderPanel({
      activeView: 'files',
      openTabs: ['files'],
      browserStates: {},
    })

    expect(screen.getByTestId('workspace-target-error')).toHaveTextContent('Workspace is not ready')
  })
})

describe('RightWorkspacePanel file tab loading', () => {
  test.each(['reject'])(
    'does not replace a newer file when an older parent listing finishes with %s',
    async outcome => {
      const target: WorkspaceTarget = {
        deviceId: 'fixture-device',
        path: '/fixture/repo',
        source: 'project',
        workspaceSource: 'local',
      }
      let finishListing!: () => void
      const staleListing = new Promise<{ path: string; entries: [] }>((resolve, reject) => {
        finishListing = () => {
          if (outcome === 'reject') reject(new Error('Old directory failed'))
          else resolve({ path: '/fixture/repo/slow', entries: [] })
        }
      })
      const api = {
        listWorkspaceEntries: vi.fn(async (_deviceId: string, path: string) =>
          path.endsWith('/slow') ? staleListing : { path, entries: [] }
        ),
        readWorkspaceTextFile: vi.fn(async (_deviceId: string, path: string) => ({
          path,
          name: path.split('/').at(-1)!,
          content: path,
          editable: true,
          revision: path,
          truncated: false,
          size: path.length,
        })),
        writeWorkspaceTextFile: vi.fn(),
      }
      const panel = (path: string, id: number) => (
        <FileWorkspacePanel target={target} workspaceFileApi={api} openFileRequest={{ path, id }} />
      )
      const { rerender } = render(panel('/fixture/repo/slow/first.ts', 1))
      await waitFor(() =>
        expect(api.listWorkspaceEntries).toHaveBeenCalledWith(
          target.deviceId,
          '/fixture/repo/slow',
          target.path
        )
      )
      const latest = '/fixture/repo/fast/second.ts'
      rerender(panel(latest, 2))
      await waitFor(() => expect(getWorkspaceCodeText()).toContain(latest))
      await act(async () => finishListing())
      expect(getWorkspaceCodeText()).toContain(latest)
      expect(api.readWorkspaceTextFile.mock.calls.map(([, path]) => path)).toEqual([latest])
    }
  )
})
