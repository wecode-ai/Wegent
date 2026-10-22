import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type {
  EmbeddedBrowserCloseRequest,
  EmbeddedBrowserOpenRequest,
  EmbeddedBrowserPopupRequest,
} from '@/lib/embedded-browser'
import { WeworkCollaborationEmbeddedBrowserHost } from './WeworkCollaborationEmbeddedBrowserHost'

const hostMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  listenOpen: vi.fn(),
  unlistenOpen: vi.fn(),
  listenClose: vi.fn(),
  listenPopup: vi.fn(),
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/lib/embedded-browser', () => ({
  DEFAULT_EMBEDDED_BROWSER_LABEL: 'workspace-browser',
  closeEmbeddedBrowser: hostMocks.closeEmbeddedBrowser,
  listenEmbeddedBrowserCloseRequests: hostMocks.listenClose,
  listenEmbeddedBrowserOpenRequests: hostMocks.listenOpen,
  listenEmbeddedBrowserPopupRequests: hostMocks.listenPopup,
}))

vi.mock('@/components/layout/workspace-panels/WorkspaceBrowserPanelContainer', () => ({
  WorkspaceBrowserPanel: ({
    active,
    label,
    openRequest,
    onNativeLabelChange,
  }: {
    active: boolean
    label: string
    openRequest: EmbeddedBrowserOpenRequest | null
    onNativeLabelChange?: (label: string | null) => void
  }) => {
    useEffect(() => onNativeLabelChange?.('browser-native-1'), [onNativeLabelChange])
    return (
      <div
        data-testid="workspace-browser-panel"
        data-active={String(active)}
        data-label={label}
        data-url={openRequest?.url}
      />
    )
  },
}))

let openHandler: ((request: EmbeddedBrowserOpenRequest) => void) | null = null
let closeHandler: ((request: EmbeddedBrowserCloseRequest) => void) | null = null
let popupHandler: ((request: EmbeddedBrowserPopupRequest) => void) | null = null

beforeEach(() => {
  hostMocks.closeEmbeddedBrowser.mockClear()
  hostMocks.listenOpen.mockClear()
  hostMocks.unlistenOpen.mockClear()
  hostMocks.listenClose.mockClear()
  hostMocks.listenPopup.mockClear()
  openHandler = null
  closeHandler = null
  popupHandler = null
  hostMocks.listenOpen.mockImplementation(
    (handler: (request: EmbeddedBrowserOpenRequest) => void) => {
      openHandler = handler
      return hostMocks.unlistenOpen
    }
  )
  hostMocks.listenClose.mockImplementation(
    (handler: (request: EmbeddedBrowserCloseRequest) => void) => {
      closeHandler = handler
      return Promise.resolve(() => {})
    }
  )
  hostMocks.listenPopup.mockImplementation(
    (handler: (request: EmbeddedBrowserPopupRequest) => void) => {
      popupHandler = handler
      return Promise.resolve(() => {})
    }
  )
})

test('opens collaboration links in one embedded browser panel', async () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)

  await waitFor(() => expect(openHandler).not.toBeNull())
  act(() => {
    openHandler?.({
      id: 'comment-link-1',
      url: 'https://example.com/docs',
      label: 'workspace-browser',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })

  const panel = await screen.findByTestId('workspace-browser-panel')
  expect(panel).toHaveAttribute('data-label', expect.stringMatching(/^workspace-browser/))
  expect(panel).toHaveAttribute('data-url', 'https://example.com/docs')
  expect(screen.getByTestId('collaboration-embedded-browser-panel')).toBeInTheDocument()
})

test('closes the collaboration browser from its close control', async () => {
  const user = userEvent.setup()
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)

  await waitFor(() => expect(openHandler).not.toBeNull())
  act(() => {
    openHandler?.({
      id: 'comment-link-1',
      url: 'https://example.com/docs',
      label: 'workspace-browser',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const panel = await screen.findByTestId('workspace-browser-panel')
  const label = panel.getAttribute('data-label')

  await user.click(screen.getByTestId('collaboration-embedded-browser-close'))

  expect(hostMocks.closeEmbeddedBrowser).toHaveBeenCalledWith(label, 'browser-native-1')
  expect(screen.queryByTestId('collaboration-embedded-browser-panel')).not.toBeInTheDocument()
})

test('removes the panel when the native browser requests a close', async () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)

  await waitFor(() => expect(openHandler).not.toBeNull())
  act(() => {
    openHandler?.({
      id: 'comment-link-1',
      url: 'https://example.com/docs',
      label: 'workspace-browser',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const panel = await screen.findByTestId('workspace-browser-panel')

  await waitFor(() => expect(closeHandler).not.toBeNull())
  act(() => {
    closeHandler?.({
      label: panel.getAttribute('data-label')!,
      nativeLabel: 'browser-native-1',
    })
  })

  expect(screen.queryByTestId('collaboration-embedded-browser-panel')).not.toBeInTheDocument()
})

test('does not subscribe to default link requests while the workspace is inactive', () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive={false} />)

  expect(hostMocks.listenOpen).not.toHaveBeenCalled()
  expect(screen.queryByTestId('collaboration-embedded-browser-panel')).not.toBeInTheDocument()
})

test.each([
  { baseLabel: 'workspace-browser-task-123', source: 'user' as const },
  { baseLabel: 'workspace-browser', source: 'agent' as const },
])('does not take an unrelated $source browser request for $baseLabel', request => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)

  act(() => {
    openHandler?.({
      id: 'unrelated-open',
      url: 'https://example.com/agent',
      label: request.baseLabel,
      ...request,
      disposition: 'current-tab',
    })
  })

  expect(screen.queryByTestId('collaboration-embedded-browser-panel')).not.toBeInTheDocument()
})

test('keeps the browser inactive when its workspace is hidden', () => {
  const { rerender } = render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'comment-link',
      url: 'https://example.com/docs',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })

  rerender(<WeworkCollaborationEmbeddedBrowserHost workspaceActive={false} />)
  expect(hostMocks.unlistenOpen).toHaveBeenCalledOnce()
  act(() => {
    openHandler?.({
      id: 'background-link',
      url: 'https://example.com/background',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })

  expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute('data-active', 'false')
  expect(screen.getByTestId('workspace-browser-panel')).toHaveAttribute(
    'data-url',
    'https://example.com/docs'
  )
})

test('ignores a stale native close event after the browser has been replaced', () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'comment-link',
      url: 'https://example.com/docs',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const panel = screen.getByTestId('workspace-browser-panel')

  act(() => {
    closeHandler?.({
      label: panel.getAttribute('data-label')!,
      nativeLabel: 'browser-native-replaced',
    })
  })

  expect(screen.getByTestId('collaboration-embedded-browser-panel')).toBeInTheDocument()
})

test('assigns independent browser labels to separate collaboration workspaces', () => {
  const first = render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'first-link',
      url: 'https://example.com/first',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const firstLabel = first.getByTestId('workspace-browser-panel').getAttribute('data-label')
  first.rerender(<WeworkCollaborationEmbeddedBrowserHost workspaceActive={false} />)
  const second = render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'second-link',
      url: 'https://example.com/second',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const secondPanel = second.container.querySelector('[data-testid="workspace-browser-panel"]')!

  expect(secondPanel.getAttribute('data-label')).not.toBe(firstLabel)
  expect(first.container.querySelector('[data-testid="workspace-browser-panel"]')).toHaveAttribute(
    'data-url',
    'https://example.com/first'
  )
})

test('continues requests that explicitly target its own browser', () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'comment-link',
      url: 'https://example.com/docs',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const panel = screen.getByTestId('workspace-browser-panel')

  act(() => {
    openHandler?.({
      id: 'owned-current-tab',
      url: 'https://example.com/current',
      baseLabel: 'workspace-browser',
      targetLabel: panel.getAttribute('data-label')!,
      source: 'agent',
      disposition: 'current-tab',
    })
  })

  expect(panel).toHaveAttribute('data-url', 'https://example.com/current')
  expect(screen.getAllByTestId('workspace-browser-panel')).toHaveLength(1)
})

test('opens a popup only when it belongs to this native browser', () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'comment-link',
      url: 'https://example.com/docs',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const panel = screen.getByTestId('workspace-browser-panel')
  const popup: EmbeddedBrowserPopupRequest = {
    popupId: 'popup-1',
    parentLabel: panel.getAttribute('data-label')!,
    parentNativeLabel: 'stale-native-browser',
    url: 'https://example.com/popup',
    origin: 'https://example.com',
    kind: 'window-open',
    strategy: 'new-tab',
    status: 'requested',
    createdAtUnixMs: 1,
    warning: null,
  }
  act(() => popupHandler?.(popup))
  expect(panel).toHaveAttribute('data-url', 'https://example.com/docs')

  act(() => popupHandler?.({ ...popup, parentNativeLabel: 'browser-native-1' }))

  expect(panel).toHaveAttribute('data-url', 'https://example.com/popup')
})

test('closes only its own native browser when the collaboration workspace unmounts', async () => {
  const { unmount } = render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive />)
  act(() => {
    openHandler?.({
      id: 'comment-link',
      url: 'https://example.com/docs',
      baseLabel: 'workspace-browser',
      source: 'user',
      disposition: 'new-tab',
    })
  })
  const label = screen.getByTestId('workspace-browser-panel').getAttribute('data-label')

  unmount()

  expect(hostMocks.unlistenOpen).toHaveBeenCalledOnce()
  await waitFor(() => {
    expect(hostMocks.closeEmbeddedBrowser).toHaveBeenCalledExactlyOnceWith(
      label,
      'browser-native-1'
    )
  })
})
