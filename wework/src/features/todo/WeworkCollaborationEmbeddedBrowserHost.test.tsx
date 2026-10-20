import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
}))

vi.mock('@/components/layout/workspace-panels/WorkspaceBrowserPanelContainer', () => ({
  WorkspaceBrowserPanel: ({
    label,
    openRequest,
    onNativeLabelChange,
  }: {
    label: string
    openRequest: EmbeddedBrowserOpenRequest | null
    onNativeLabelChange?: (label: string | null) => void
  }) => {
    onNativeLabelChange?.('browser-native-1')
    return (
      <div data-testid="workspace-browser-panel" data-label={label} data-url={openRequest?.url} />
    )
  },
}))

let openHandler: ((request: EmbeddedBrowserOpenRequest) => void) | null = null
let closeHandler: ((request: EmbeddedBrowserCloseRequest) => void) | null = null

beforeEach(() => {
  hostMocks.closeEmbeddedBrowser.mockClear()
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
})

test('opens collaboration links in one embedded browser panel', async () => {
  render(<WeworkCollaborationEmbeddedBrowserHost />)

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
  expect(panel).toHaveAttribute('data-label', 'workspace-browser')
  expect(panel).toHaveAttribute('data-url', 'https://example.com/docs')
  expect(screen.getByTestId('collaboration-embedded-browser-panel')).toBeInTheDocument()
})

test('closes the collaboration browser from its close control', async () => {
  const user = userEvent.setup()
  render(<WeworkCollaborationEmbeddedBrowserHost />)

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
  await screen.findByTestId('workspace-browser-panel')

  await user.click(screen.getByTestId('collaboration-embedded-browser-close'))

  expect(hostMocks.closeEmbeddedBrowser).toHaveBeenCalledWith(
    'workspace-browser',
    'browser-native-1'
  )
  expect(screen.queryByTestId('collaboration-embedded-browser-panel')).not.toBeInTheDocument()
})

test('removes the panel when the native browser requests a close', async () => {
  render(<WeworkCollaborationEmbeddedBrowserHost />)

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
  await screen.findByTestId('workspace-browser-panel')

  await waitFor(() => expect(closeHandler).not.toBeNull())
  act(() => {
    closeHandler?.({
      label: 'workspace-browser',
      nativeLabel: 'browser-native-1',
    })
  })

  expect(screen.queryByTestId('collaboration-embedded-browser-panel')).not.toBeInTheDocument()
})
