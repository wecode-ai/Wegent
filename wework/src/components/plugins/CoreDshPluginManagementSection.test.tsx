import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'
import {
  readCoreDshPlugins,
  setCoreDshPluginEnabled,
  type CoreDshPlugin,
} from '@/features/dsh-plugins/coreDshPlugins'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}))
vi.mock('@/features/dsh-runtime/DshContributionSlotSurface', () => ({
  DshContributionSlotSurface: () => null,
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
beforeEach(() => {
  vi.mocked(readCoreDshPlugins).mockReset().mockResolvedValue([plugin])
  vi.mocked(setCoreDshPluginEnabled)
    .mockReset()
    .mockResolvedValue([{ ...plugin, enabled: false }])
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

test('surfaces a failed inventory read without blocking the rest of the page', async () => {
  vi.mocked(readCoreDshPlugins).mockRejectedValueOnce(new Error('Runtime unavailable'))
  render(<CoreDshPluginManagementSection />)
  expect(await screen.findByTestId('core-dsh-plugin-management-error')).toHaveTextContent(
    'Runtime unavailable'
  )
  expect(screen.getByTestId('core-dsh-plugin-install-form')).toBeInTheDocument()
})
