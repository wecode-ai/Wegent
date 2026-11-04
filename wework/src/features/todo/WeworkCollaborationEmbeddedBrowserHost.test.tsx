import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type {
  EmbeddedBrowserCloseRequest,
  EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { WeworkCollaborationEmbeddedBrowserHost } from './WeworkCollaborationEmbeddedBrowserHost'

const hostMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  listenOpen: vi.fn(),
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

beforeEach(() => {
  hostMocks.closeEmbeddedBrowser.mockClear()
  hostMocks.listenOpen.mockClear()
  hostMocks.listenClose.mockClear()
  hostMocks.listenPopup.mockClear()
  openHandler = null
  closeHandler = null
  hostMocks.listenOpen.mockImplementation(
    (handler: (request: EmbeddedBrowserOpenRequest) => void) => {
      openHandler = handler
      return Promise.resolve(() => {})
    }
  )
  hostMocks.listenClose.mockImplementation(
    (handler: (request: EmbeddedBrowserCloseRequest) => void) => {
      closeHandler = handler
      return Promise.resolve(() => {})
    }
  )
  hostMocks.listenPopup.mockImplementation(() => {
    return Promise.resolve(() => {})
  })
})

test('does not subscribe to default link requests while the workspace is inactive', () => {
  render(<WeworkCollaborationEmbeddedBrowserHost workspaceActive={false} />)

  expect(hostMocks.listenOpen).not.toHaveBeenCalled()
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

  await waitFor(() => {
    expect(hostMocks.closeEmbeddedBrowser).toHaveBeenCalledExactlyOnceWith(
      label,
      'browser-native-1'
    )
  })
})
