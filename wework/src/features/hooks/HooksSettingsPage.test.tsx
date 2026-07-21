import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HooksSettingsPage } from './HooksSettingsPage'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/tauri/localExecutor', () => ({
  requestLocalExecutor: request,
  subscribeLocalExecutorEvents: vi.fn().mockResolvedValue(vi.fn()),
}))

describe('HooksSettingsPage', () => {
  beforeEach(() => request.mockReset())

  test('renders empty state and opens the editor', async () => {
    request.mockResolvedValueOnce({ plugins: [] })
    render(<HooksSettingsPage />)
    expect(await screen.findByText('尚未安装 Hook。')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('hooks-add-button'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('hook-editor-save')).toBeDisabled()
  })

  test('renders source, health, and managed policy', async () => {
    request.mockResolvedValueOnce({
      plugins: [
        {
          manifest: {
            schemaVersion: 1,
            id: 'managed',
            name: 'Managed reporter',
            description: 'Reports changes',
            version: '1',
          },
          enabled: true,
          source: 'managed',
          installPath: '/managed',
          policy: { canDisable: false, canEdit: false, canDelete: false },
          health: { status: 'ready' },
          handlers: [],
          recentRuns: [],
        },
      ],
    })
    render(<HooksSettingsPage />)
    expect(await screen.findByTestId('hook-row-managed')).toHaveTextContent('组织')
    expect(screen.getByTestId('hook-row-managed')).toHaveTextContent('可用')
    expect(screen.getByTestId('hook-enabled-managed')).toBeDisabled()
    expect(screen.queryByTestId('hook-menu-managed')).not.toBeInTheDocument()
    await waitFor(() => expect(request).toHaveBeenCalledWith('runtime.hooks.list'))
  })
})
