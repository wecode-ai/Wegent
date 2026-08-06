import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanelContainer'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn(),
  relabelEmbeddedBrowser: vi.fn(),
  setEmbeddedBrowserActiveTab: vi.fn(),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

vi.mock('./WorkspaceBrowserPanel', () => ({
  WorkspaceBrowserTabPanel: ({
    label,
    openRequest,
  }: {
    label: string
    openRequest: { url: string } | null
  }) => <div data-testid={'browser-host-' + label}>{openRequest?.url ?? label}</div>,
}))

describe('WorkspaceBrowserPanelContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    embeddedBrowserMocks.closeEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.relabelEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.setEmbeddedBrowserActiveTab.mockResolvedValue(undefined)
  })

  test('adds and selects a blank browser tab', async () => {
    render(<WorkspaceBrowserPanel active label="workspace-browser-task-1" />)

    fireEvent.click(screen.getByTestId('browser-tab-add'))

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2)
      expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true')
    })
  })

  test('opens user requests in a newly created tab', async () => {
    render(
      <WorkspaceBrowserPanel
        active
        label="workspace-browser-task-1"
        openRequest={{
          id: 'user-link-1',
          url: 'https://example.test/',
          baseLabel: 'workspace-browser-task-1',
          source: 'user',
          disposition: 'new-tab',
        }}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2)
      expect(screen.getAllByText('https://example.test/')).toHaveLength(2)
    })
  })

  test('opens agent requests in the current tab', async () => {
    render(
      <WorkspaceBrowserPanel
        active
        label="workspace-browser-task-1"
        openRequest={{
          id: 'agent-open-1',
          url: 'https://example.test/',
          baseLabel: 'workspace-browser-task-1',
          source: 'agent',
          disposition: 'current-tab',
        }}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(1)
      expect(screen.getAllByText('https://example.test/')).toHaveLength(2)
    })
  })
})
