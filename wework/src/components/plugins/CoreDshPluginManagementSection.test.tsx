import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { installCoreDshPlugin, readCoreDshPlugins } from '@/features/dsh-plugins/coreDshPlugins'
import { CoreDshPluginManagementSection } from './CoreDshPluginManagementSection'

vi.mock('@/features/dsh-plugins/coreDshPlugins', () => ({
  readCoreDshPlugins: vi.fn(),
  installCoreDshPlugin: vi.fn(),
  updateCoreDshPlugin: vi.fn(),
  setCoreDshPluginEnabled: vi.fn(),
  uninstallCoreDshPlugin: vi.fn(),
  restartCoreDsh: vi.fn(),
}))
vi.mock('@/features/dsh-runtime/DshSlotSurface', () => ({ DshSlotSurface: () => null }))

beforeEach(() => {
  vi.mocked(readCoreDshPlugins).mockResolvedValue([])
})

test('keeps the source while native consent is pending or cancelled and permits a fresh request', async () => {
  let cancel!: (reason: Error) => void
  vi.mocked(installCoreDshPlugin).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        cancel = reject
      })
  )
  render(<CoreDshPluginManagementSection />)
  const user = userEvent.setup()
  const source = screen.getByTestId('core-dsh-plugin-spec-input')
  const install = screen.getByTestId('core-dsh-plugin-install-button')
  await user.type(source, 'github:owner/plugin')
  await user.click(install)
  expect(installCoreDshPlugin).toHaveBeenCalledExactlyOnceWith('github:owner/plugin')
  expect(install).toBeDisabled()
  expect(source).toHaveValue('github:owner/plugin')
  expect(screen.queryByTestId('core-dsh-plugin-install-confirm')).not.toBeInTheDocument()
  cancel(new Error('Core plugin installation was cancelled'))
  await screen.findByText('Core plugin installation was cancelled')
  expect(source).toHaveValue('github:owner/plugin')
  expect(screen.queryByTestId('core-dsh-plugin-restart-required')).not.toBeInTheDocument()
  vi.mocked(installCoreDshPlugin).mockResolvedValueOnce([])
  await user.click(install)
  await waitFor(() => expect(source).toHaveValue(''))
  expect(installCoreDshPlugin).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('core-dsh-plugin-restart-required')).toBeInTheDocument()
})
