import i18n from '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { BrowserSettingsPage } from './BrowserSettingsPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: mocks.get,
  updateAppPreferences: mocks.update,
}))
vi.mock('@/lib/embedded-browser', () => ({ canUseEmbeddedBrowser: () => true }))
vi.mock('./BrowserHistoryPage', () => ({
  BrowserHistoryPage: () => <div data-testid="browser-history" />,
}))

beforeEach(() => {
  window.history.replaceState(null, '', '/settings/browser')
  mocks.get.mockReset()
  mocks.update.mockReset()
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

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

function navigate(path: string) {
  act(() => {
    window.history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

test('loads preferences only while their page is active and isolates a detached read', async () => {
  window.history.replaceState(null, '', '/settings/browser/history')
  let finishOld!: (value: typeof defaultAppPreferences) => void
  mocks.get.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishOld = resolve
      })
  )
  render(<BrowserSettingsPage />)
  expect(screen.getByTestId('browser-history')).toBeInTheDocument()
  expect(mocks.get).not.toHaveBeenCalled()

  navigate('/settings/browser')
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('browser-full-control-toggle')).toBeDisabled()
  navigate('/settings/browser/history')
  mocks.get.mockResolvedValue({ ...defaultAppPreferences, browserFullControl: true })
  navigate('/settings/browser')
  await waitFor(() => expect(screen.getByTestId('browser-full-control-toggle')).toBeEnabled())
  await act(async () => finishOld(defaultAppPreferences))
  expect(screen.getByTestId('browser-full-control-toggle')).toHaveAttribute('aria-checked', 'true')
  expect(mocks.get).toHaveBeenCalledTimes(2)
})

test('does not reread on ordinary renders or preference saves', async () => {
  const { rerender } = render(<BrowserSettingsPage />)
  await waitFor(() => expect(screen.getByTestId('browser-full-control-toggle')).toBeEnabled())
  rerender(<BrowserSettingsPage />)
  await userEvent.click(screen.getByTestId('browser-full-control-toggle'))
  await waitFor(() =>
    expect(screen.getByTestId('browser-full-control-toggle')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  )
  expect(mocks.get).toHaveBeenCalledTimes(1)
})

test('shows a failed read and recovers when the preferences page is reopened', async () => {
  mocks.get.mockRejectedValueOnce(new Error('unreadable'))
  render(<BrowserSettingsPage />)
  await waitFor(() =>
    expect(screen.getByTestId('browser-settings-status')).toHaveTextContent('无法加载浏览器设置')
  )
  navigate('/settings/browser/history')
  navigate('/settings/browser')
  await waitFor(() => expect(screen.getByTestId('browser-full-control-toggle')).toBeEnabled())
  expect(screen.queryByTestId('browser-settings-status')).not.toBeInTheDocument()
  expect(mocks.get).toHaveBeenCalledTimes(2)
})

test('keeps an accepted save on its original page after navigation', async () => {
  let finishSave!: (value: typeof defaultAppPreferences) => void
  mocks.update.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishSave = resolve
      })
  )
  render(<BrowserSettingsPage />)
  await waitFor(() => expect(screen.getByTestId('browser-full-control-toggle')).toBeEnabled())
  await userEvent.click(screen.getByTestId('browser-full-control-toggle'))
  expect(mocks.update).toHaveBeenCalledTimes(1)
  navigate('/settings/browser/history')
  navigate('/settings/browser')
  await waitFor(() => expect(screen.getByTestId('browser-full-control-toggle')).toBeEnabled())
  await act(async () => finishSave({ ...defaultAppPreferences, browserFullControl: true }))
  expect(screen.getByTestId('browser-full-control-toggle')).toHaveAttribute('aria-checked', 'false')
  expect(mocks.get).toHaveBeenCalledTimes(2)
})

test('keeps page drafts without rereading when the language changes', async () => {
  render(<BrowserSettingsPage />)
  await waitFor(() => expect(screen.getByTestId('browser-full-control-toggle')).toBeEnabled())
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(mocks.get).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})
