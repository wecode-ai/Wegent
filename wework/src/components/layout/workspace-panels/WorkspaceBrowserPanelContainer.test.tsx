import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanelContainer'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn(),
  closeEmbeddedBrowsers: vi.fn(),
  isEmbeddedBrowserLabelTransferred: vi.fn(() => false),
  relabelEmbeddedBrowser: vi.fn(),
  setEmbeddedBrowserActiveTab: vi.fn(),
}))

const browserPanelMocks = vi.hoisted(() => ({
  panels: new Map<
    string,
    {
      onDownloadActivityChange?: (hasActiveDownload: boolean) => void
    }
  >(),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

vi.mock('./WorkspaceBrowserPanel', () => ({
  WorkspaceBrowserTabPanel: (props: {
    label: string
    openRequest: { url: string } | null
    onDownloadActivityChange?: (hasActiveDownload: boolean) => void
  }) => {
    browserPanelMocks.panels.set(props.label, props)
    return (
      <div data-testid={'browser-host-' + props.label}>{props.openRequest?.url ?? props.label}</div>
    )
  },
}))

describe('WorkspaceBrowserPanelContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    browserPanelMocks.panels.clear()
    embeddedBrowserMocks.isEmbeddedBrowserLabelTransferred.mockReturnValue(false)
    embeddedBrowserMocks.closeEmbeddedBrowser.mockResolvedValue(undefined)
    embeddedBrowserMocks.closeEmbeddedBrowsers.mockResolvedValue(undefined)
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

  test('blocks closing a tab with active downloads', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<WorkspaceBrowserPanel active label="workspace-browser-task-1" />)
    fireEvent.click(screen.getByTestId('browser-tab-add'))

    await waitFor(() => expect(browserPanelMocks.panels.size).toBe(2))

    const tabLabel = Array.from(browserPanelMocks.panels.keys()).find(
      label => label !== 'workspace-browser-task-1'
    )
    expect(tabLabel).toBeTruthy()
    act(() => {
      browserPanelMocks.panels.get(tabLabel!)?.onDownloadActivityChange?.(true)
    })

    const closeButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid^="browser-tab-close-"]')
    )
    fireEvent.click(closeButtons[1])

    expect(confirmSpy).toHaveBeenCalled()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(embeddedBrowserMocks.closeEmbeddedBrowser).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
