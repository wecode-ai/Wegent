import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { BrowserSettingsPage } from './BrowserSettingsPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: mocks.get,
  updateAppPreferences: mocks.update,
}))
vi.mock('@/lib/embedded-browser', () => ({ canUseEmbeddedBrowser: () => true }))

beforeEach(() => {
  mocks.get.mockResolvedValue(defaultAppPreferences)
  mocks.update.mockImplementation(async patch => ({ ...defaultAppPreferences, ...patch }))
})

test('saves full control and restores confirmation when switched off', async () => {
  const user = userEvent.setup()
  render(<BrowserSettingsPage />)
  const toggle = await screen.findByTestId('browser-full-control-toggle')
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  await user.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  expect(mocks.update).toHaveBeenLastCalledWith({ browserFullControl: true })
  await user.click(toggle)
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  expect(mocks.update).toHaveBeenLastCalledWith({ browserFullControl: false })
})

test('keeps confirmation enabled when saving full control fails', async () => {
  mocks.update.mockRejectedValueOnce(new Error('write failed'))
  render(<BrowserSettingsPage />)
  const toggle = await screen.findByTestId('browser-full-control-toggle')
  await waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  await waitFor(() =>
    expect(screen.getByTestId('browser-settings-status')).toHaveTextContent('无法保存浏览器设置')
  )
  expect(toggle).toHaveAttribute('aria-checked', 'false')
})
