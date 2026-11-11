import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import { WorkbenchApplicationSettings } from './WorkbenchApplicationSettings'
const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  setShortcut: vi.fn(),
  createShortcut: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: mocks }))
const t = (_key: string, fallback: string) => fallback
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const installed = {
  id: 'tool',
  manifest: { displayName: '工具' },
  presentation: 'window',
  resident: false,
  state: 'installed',
  shortcut: null,
  shortcutError: null,
} as HarnessAppInstallation

describe('WorkbenchApplicationSettings', () => {
  const onRefresh = vi.fn(),
    onOpen = vi.fn(),
    onClose = vi.fn()
  const element = (installation = installed) => (
    <WorkbenchApplicationSettings
      installation={installation}
      onRefresh={onRefresh}
      onOpen={onOpen}
      onClose={onClose}
    />
  )
  beforeEach(() => {
    vi.clearAllMocks()
    onRefresh.mockResolvedValue(undefined)
    mocks.configure.mockResolvedValue(installed)
    mocks.setShortcut.mockResolvedValue(undefined)
  })
  test('persists the opening preference without starting a stopped workbench', async () => {
    render(element())
    fireEvent.change(screen.getByTestId('workbench-presentation'), { target: { value: 'tab' } })
    await waitFor(() =>
      expect(mocks.configure).toHaveBeenCalledWith('tool', { presentation: 'tab' })
    )
    expect(onOpen).not.toHaveBeenCalled()
  })
  test('switches a running workbench through its existing instance', async () => {
    const running = { ...installed, state: 'running' as const }
    render(element(running))
    fireEvent.change(screen.getByTestId('workbench-presentation'), { target: { value: 'tab' } })
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(running, 'tab'))
    expect(mocks.configure).not.toHaveBeenCalled()
  })
  test('configures background closing separately from automatic startup', async () => {
    render(element())
    expect(screen.getByTestId('workbench-background')).toBeChecked()
    expect(screen.getByTestId('workbench-resident')).not.toBeChecked()
    fireEvent.click(screen.getByTestId('workbench-background'))
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledWith('tool', { background: false }))
    expect(onOpen).not.toHaveBeenCalled()
  })
  test('refreshes clean shortcut values but retains an edited draft after failure', async () => {
    const view = render(element())
    view.rerender(element({ ...installed, shortcut: 'Control+Shift+Y' }))
    expect(screen.getByTestId('workbench-shortcut')).toHaveValue('Control+Shift+Y')
    fireEvent.change(screen.getByTestId('workbench-shortcut'), {
      target: { value: 'Control+Shift+K' },
    })
    mocks.setShortcut.mockRejectedValueOnce(new Error('already in use'))
    fireEvent.click(screen.getByTestId('workbench-shortcut-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('修改工作台设置失败。')
    view.rerender(element({ ...installed, shortcut: 'Control+Shift+J' }))
    expect(screen.getByTestId('workbench-shortcut')).toHaveValue('Control+Shift+K')
  })
  test('clears the shortcut through the Host and shows restore conflicts', async () => {
    render(
      element({ ...installed, shortcut: 'Control+Shift+Y', shortcutError: 'Shortcut occupied' })
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Shortcut occupied')
    fireEvent.change(screen.getByTestId('workbench-shortcut'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('workbench-shortcut-save'))
    await waitFor(() => expect(mocks.setShortcut).toHaveBeenCalledWith('tool', null))
  })
  test('returns to live Host shortcut values after saving or clearing a draft', async () => {
    const view = render(element({ ...installed, shortcut: 'Control+Shift+Y' }))
    let refreshed = { ...installed, shortcut: 'Control+Shift+K' as string | null }
    onRefresh.mockImplementation(async () => view.rerender(element(refreshed)))

    fireEvent.change(screen.getByTestId('workbench-shortcut'), {
      target: { value: '  Control+Shift+K  ' },
    })
    fireEvent.click(screen.getByTestId('workbench-shortcut-save'))
    await waitFor(() => expect(screen.getByTestId('workbench-shortcut-save')).toBeDisabled())
    await waitFor(() =>
      expect(screen.getByTestId('workbench-shortcut')).toHaveValue('Control+Shift+K')
    )
    expect(mocks.setShortcut).toHaveBeenLastCalledWith('tool', 'Control+Shift+K')

    view.rerender(element({ ...installed, shortcut: 'Control+Shift+J' }))
    expect(screen.getByTestId('workbench-shortcut')).toHaveValue('Control+Shift+J')
    refreshed = { ...installed, shortcut: null }
    fireEvent.change(screen.getByTestId('workbench-shortcut'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('workbench-shortcut-save'))
    await waitFor(() => expect(mocks.setShortcut).toHaveBeenLastCalledWith('tool', null))
    await waitFor(() => expect(screen.getByTestId('workbench-shortcut')).not.toBeDisabled())
    expect(screen.getByTestId('workbench-shortcut')).toHaveValue('')

    view.rerender(element({ ...installed, shortcut: 'Control+Shift+L' }))
    expect(screen.getByTestId('workbench-shortcut')).toHaveValue('Control+Shift+L')
  })
})
