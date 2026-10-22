import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HooksSettingsPage } from './HooksSettingsPage'
import type { HookRunSummary, ResolvedHookPlugin } from './hooksTypes'

const { request, subscribe } = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: request,
  subscribeLocalExecutorEvents: subscribe,
}))

const reporter: ResolvedHookPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'reporter',
    name: 'Reporter',
    description: '',
    version: '1',
  },
  enabled: true,
  source: 'bundled',
  installPath: '/fixtures/hooks/reporter',
  policy: { canDisable: true, canEdit: false, canDelete: false },
  health: { status: 'ready' },
  handlers: [],
  recentRuns: [],
}

describe('HooksSettingsPage', () => {
  beforeEach(() => {
    request.mockReset()
    subscribe.mockReset().mockResolvedValue(vi.fn())
  })

  test('updates completed runs without reloading or remounting the hook controls', async () => {
    request.mockResolvedValue({ plugins: [reporter] })
    const { unmount } = render(<HooksSettingsPage />)
    const toggle = await screen.findByTestId('hook-enabled-reporter')
    toggle.focus()
    const listener = subscribe.mock.calls[0][0]
    const run: HookRunSummary = {
      runId: 'run-1',
      pluginId: 'reporter',
      handlerId: 'handler-1',
      status: 'succeeded',
      startedAtMs: 100,
      durationMs: 89,
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }
    for (let index = 0; index < 3; index++) {
      act(() => {
        listener({
          event: 'runtime.hooks.run_completed',
          payload: { run: { ...run, runId: `run-${index}`, durationMs: 89 + index } },
        })
      })
      expect(screen.getByTestId('hook-enabled-reporter')).toBe(toggle)
      expect(toggle).toHaveFocus()
      expect(screen.getByTestId('hook-row-reporter')).toHaveTextContent(`${89 + index} ms`)
    }
    expect(request).toHaveBeenCalledTimes(1)
    unmount()
    expect(await subscribe.mock.results[0].value).toHaveBeenCalledOnce()
  })

  test('keeps the loaded list mounted while refreshing changed configuration', async () => {
    request.mockResolvedValueOnce({ plugins: [reporter] })
    render(<HooksSettingsPage />)
    const toggle = await screen.findByTestId('hook-enabled-reporter')
    let resolveRefresh!: (value: { plugins: ResolvedHookPlugin[] }) => void
    request.mockReturnValueOnce(
      new Promise(resolve => {
        resolveRefresh = resolve
      })
    )
    act(() => subscribe.mock.calls[0][0]({ event: 'runtime.hooks.changed', payload: {} }))
    expect(request).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('hook-enabled-reporter')).toBe(toggle)
    await act(async () => {
      resolveRefresh({ plugins: [{ ...reporter, enabled: false }] })
    })
    expect(screen.getByTestId('hook-enabled-reporter')).toBe(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

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
