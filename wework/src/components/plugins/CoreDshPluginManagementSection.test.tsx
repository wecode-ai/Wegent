import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'
import {
  installCoreDshPlugin,
  readCoreDshPlugins,
  setCoreDshPluginEnabled,
  updateCoreDshPlugin,
  type CoreDshPlugin,
} from '@/features/dsh-plugins/coreDshPlugins'

let capturedCreateHandler: (() => Promise<void>) | undefined

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))
vi.mock('@/features/dsh-runtime/DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: ({ props }: { props?: { onCreate?: () => Promise<void> } }) => {
    capturedCreateHandler = props?.onCreate
    if (!props?.onCreate) return null
    return (
      <button
        type="button"
        data-testid="mock-create-plugin-button"
        onClick={() => void props.onCreate?.()}
      >
        创建新插件
      </button>
    )
  },
}))
vi.mock('@/features/dsh-plugins/coreDshPlugins', () => ({
  readCoreDshPlugins: vi.fn(),
  setCoreDshPluginEnabled: vi.fn(),
  installCoreDshPlugin: vi.fn(),
  restartCoreDsh: vi.fn(),
  uninstallCoreDshPlugin: vi.fn(),
  updateCoreDshPlugin: vi.fn(),
}))
const plugin: CoreDshPlugin = {
  name: 'test-plugin',
  displayName: 'Example plugin',
  description: '',
  version: '1',
  requestedSpec: 'example',
  enabled: true,
  immutable: false,
  homepage: '',
  repository: '',
  canUpdate: true,
  canToggle: true,
  canUninstall: true,
}
const customPlugin: CoreDshPlugin = {
  name: '@custom/my-helper',
  displayName: 'My Helper',
  description: 'Local helper plugin',
  version: '0.2.0',
  requestedSpec: 'file:/Users/me/plugins/my-helper',
  enabled: true,
  immutable: false,
  homepage: '',
  repository: '',
  canUpdate: true,
  canToggle: true,
  canUninstall: true,
}
const builtInPlugin: CoreDshPlugin = {
  name: '@wegent/dsh-app-wework',
  displayName: 'Wework Core App',
  description: 'Core host app',
  version: '1.0.0',
  requestedSpec: 'file:/app/wework-app',
  enabled: true,
  immutable: true,
  homepage: '',
  repository: '',
  canUpdate: false,
  canToggle: false,
  canUninstall: false,
}
beforeEach(() => {
  capturedCreateHandler = undefined
  vi.mocked(readCoreDshPlugins).mockReset().mockResolvedValue([plugin])
  vi.mocked(setCoreDshPluginEnabled)
    .mockReset()
    .mockResolvedValue([{ ...plugin, enabled: false }])
  vi.mocked(updateCoreDshPlugin).mockReset().mockResolvedValue([plugin, customPlugin])
  vi.mocked(installCoreDshPlugin).mockReset().mockResolvedValue([plugin, customPlugin])
})

test('uses the persisted plugin list returned by a toggle without another inventory read', async () => {
  render(<CoreDshPluginManagementSection />)
  const toggle = await screen.findByTestId('core-dsh-plugin-toggle-test-plugin')
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toHaveTextContent('启用'))
  expect(setCoreDshPluginEnabled).toHaveBeenCalledExactlyOnceWith('test-plugin', false)
  expect(readCoreDshPlugins).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('core-dsh-plugin-restart-button')).toBeInTheDocument()
})

test('surfaces a failed inventory read without blocking the rest of the page and allows dismissing it', async () => {
  vi.mocked(readCoreDshPlugins).mockRejectedValueOnce(new Error('Runtime unavailable'))
  render(<CoreDshPluginManagementSection />)
  expect(await screen.findByTestId('core-dsh-plugin-management-error')).toHaveTextContent(
    'Runtime unavailable'
  )
  fireEvent.click(screen.getByTestId('core-dsh-plugin-management-error-dismiss'))
  expect(screen.queryByTestId('core-dsh-plugin-management-error')).toBeNull()

  const openInstall = screen.getByTestId('core-dsh-plugin-open-install-button')
  expect(openInstall).toBeEnabled()
  fireEvent.click(openInstall)
  expect(await screen.findByTestId('core-dsh-plugin-install-form')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('core-dsh-plugin-spec-input')).toHaveFocus())
})

test('searches plugins by name, package, or source, updates match, and clears via button or Escape', async () => {
  const inventory = [plugin, customPlugin, builtInPlugin]
  vi.mocked(readCoreDshPlugins).mockResolvedValueOnce(inventory)
  vi.mocked(updateCoreDshPlugin).mockResolvedValueOnce(inventory)

  render(<CoreDshPluginManagementSection />)
  const search = await screen.findByTestId('core-dsh-plugin-search-input')

  // Match by requestedSpec (case-insensitive)
  fireEvent.change(search, { target: { value: 'PLUGINS/MY-HELPER' } })
  expect(screen.getByTestId('core-dsh-plugin-row-@custom/my-helper')).toBeInTheDocument()
  expect(screen.queryByTestId('core-dsh-plugin-row-test-plugin')).toBeNull()
  expect(screen.queryByTestId('core-dsh-plugin-management-section-toggle')).toBeNull()

  fireEvent.click(screen.getByTestId('core-dsh-plugin-update-@custom/my-helper'))
  await waitFor(() =>
    expect(updateCoreDshPlugin).toHaveBeenCalledExactlyOnceWith('@custom/my-helper')
  )
  expect(screen.getByTestId('core-dsh-plugin-restart-button')).toBeInTheDocument()

  // Clear via clear button
  fireEvent.click(screen.getByTestId('core-dsh-plugin-search-clear'))
  expect(search).toHaveValue('')
  expect(screen.getByTestId('core-dsh-plugin-row-test-plugin')).toBeInTheDocument()
  expect(screen.getByTestId('core-dsh-plugin-management-section-toggle')).toBeInTheDocument()

  // Match by displayName and clear via Escape
  fireEvent.change(search, { target: { value: 'example plugin' } })
  expect(screen.getByTestId('core-dsh-plugin-row-test-plugin')).toBeInTheDocument()
  expect(screen.queryByTestId('core-dsh-plugin-row-@custom/my-helper')).toBeNull()

  fireEvent.keyDown(search, { key: 'Escape' })
  expect(search).toHaveValue('')
  expect(screen.getByTestId('core-dsh-plugin-row-@custom/my-helper')).toBeInTheDocument()

  // Match by package name
  fireEvent.change(search, { target: { value: '@custom/my-helper' } })
  expect(screen.getByTestId('core-dsh-plugin-row-@custom/my-helper')).toBeInTheDocument()
  expect(screen.queryByTestId('core-dsh-plugin-row-test-plugin')).toBeNull()
})

test('shows search empty state when nothing matches', async () => {
  vi.mocked(readCoreDshPlugins).mockResolvedValueOnce([plugin, builtInPlugin])

  render(<CoreDshPluginManagementSection />)
  const search = await screen.findByTestId('core-dsh-plugin-search-input')

  fireEvent.change(search, { target: { value: 'nonexistent-plugin' } })

  expect(screen.getByTestId('core-dsh-plugin-search-empty')).toBeInTheDocument()
  expect(screen.queryByTestId('core-dsh-plugin-row-test-plugin')).toBeNull()
  expect(screen.queryByTestId('core-dsh-plugin-management-section-toggle')).toBeNull()
})

test('installs a plugin from the install dialog, preserves input on failure, and closes on success', async () => {
  vi.mocked(readCoreDshPlugins).mockResolvedValueOnce([plugin])
  vi.mocked(installCoreDshPlugin)
    .mockRejectedValueOnce(new Error('Invalid plugin source'))
    .mockResolvedValueOnce([plugin, customPlugin])

  render(<CoreDshPluginManagementSection />)
  await screen.findByTestId('core-dsh-plugin-row-test-plugin')

  expect(screen.queryByTestId('core-dsh-plugin-install-form')).toBeNull()
  fireEvent.click(screen.getByTestId('core-dsh-plugin-open-install-button'))

  const input = screen.getByTestId('core-dsh-plugin-spec-input')
  fireEvent.change(input, { target: { value: 'file:/Users/me/plugins/my-helper' } })
  fireEvent.click(screen.getByTestId('core-dsh-plugin-install-button'))

  expect(await screen.findByTestId('core-dsh-plugin-install-error')).toHaveTextContent(
    'Invalid plugin source'
  )
  expect(screen.getByTestId('core-dsh-plugin-install-form')).toBeInTheDocument()
  expect(screen.getByTestId('core-dsh-plugin-spec-input')).toHaveValue(
    'file:/Users/me/plugins/my-helper'
  )

  fireEvent.click(screen.getByTestId('core-dsh-plugin-install-button'))

  await waitFor(() =>
    expect(screen.queryByTestId('core-dsh-plugin-install-form')).not.toBeInTheDocument()
  )
  expect(installCoreDshPlugin).toHaveBeenCalledTimes(2)
  expect(installCoreDshPlugin).toHaveBeenLastCalledWith('file:/Users/me/plugins/my-helper')
  expect(screen.getByTestId('core-dsh-plugin-row-@custom/my-helper')).toBeInTheDocument()
  expect(screen.getByTestId('core-dsh-plugin-restart-button')).toBeInTheDocument()
})

test('routes create-plugin failures to the page error banner, supports manual close, and auto-dismisses after 8s', async () => {
  const onCreatePlugin = vi
    .fn<() => Promise<void>>()
    .mockRejectedValue(new Error('The selected plugin directory must be empty'))
  render(<CoreDshPluginManagementSection onCreatePlugin={onCreatePlugin} />)

  await screen.findByTestId('core-dsh-plugin-row-test-plugin')
  expect(capturedCreateHandler).toBeTypeOf('function')

  vi.useFakeTimers()
  try {
    await act(async () => {
      await expect(capturedCreateHandler?.()).resolves.toBeUndefined()
    })
    expect(onCreatePlugin).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('core-dsh-plugin-management-error')).toHaveTextContent(
      'The selected plugin directory must be empty'
    )

    fireEvent.click(screen.getByTestId('core-dsh-plugin-management-error-dismiss'))
    expect(screen.queryByTestId('core-dsh-plugin-management-error')).toBeNull()

    await act(async () => {
      await expect(capturedCreateHandler?.()).resolves.toBeUndefined()
    })
    expect(screen.getByTestId('core-dsh-plugin-management-error')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(7_999)
    })
    expect(screen.getByTestId('core-dsh-plugin-management-error')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByTestId('core-dsh-plugin-management-error')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
