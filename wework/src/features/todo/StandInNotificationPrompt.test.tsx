import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { StandInNotificationPrompt } from './StandInNotificationPrompt'
import { OPEN_NOTIFICATION_SETTINGS_EVENT } from '@/features/notifications/notificationPreferences'

const host = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: host.invoke }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))
afterEach(() => {
  localStorage.clear()
  host.invoke.mockReset()
})

it('opens native and unified notification settings without claiming permission was granted', async () => {
  host.invoke.mockResolvedValue({ supported: true })
  const opened = vi.fn()
  window.addEventListener(OPEN_NOTIFICATION_SETTINGS_EVENT, opened)
  const view = render(<StandInNotificationPrompt scopeKey="enable" />)
  fireEvent.click(screen.getByTestId('stand-in-notifications-enable'))
  await waitFor(() => expect(opened).toHaveBeenCalledOnce())
  expect(host.invoke).toHaveBeenCalledWith('notification.openSettings')
  expect(screen.getByTestId('stand-in-notification-prompt')).toBeVisible()
  window.removeEventListener(OPEN_NOTIFICATION_SETTINGS_EVENT, opened)
  view.unmount()
})
it('retains a retryable prompt when opening system settings fails', async () => {
  host.invoke.mockRejectedValue(new Error('settings unavailable'))
  render(<StandInNotificationPrompt scopeKey="failure" />)
  fireEvent.click(screen.getByTestId('stand-in-notifications-enable'))
  expect(await screen.findByRole('alert')).toHaveTextContent('无法打开或保存通知设置')
  expect(screen.getByTestId('stand-in-notifications-enable')).toBeEnabled()
})
it('scopes permanent dismissal to the current account', () => {
  const view = render(<StandInNotificationPrompt scopeKey="first" />)
  fireEvent.click(screen.getByTestId('stand-in-notifications-never'))
  expect(screen.queryByTestId('stand-in-notification-prompt')).not.toBeInTheDocument()
  view.rerender(<StandInNotificationPrompt scopeKey="second" />)
  expect(screen.getByTestId('stand-in-notification-prompt')).toBeVisible()
})
it('keeps temporary dismissal across conversation remounts without persisting it', () => {
  const view = render(<StandInNotificationPrompt scopeKey="temporary" />)
  fireEvent.click(screen.getByTestId('stand-in-notifications-dismiss'))
  view.unmount()
  render(<StandInNotificationPrompt scopeKey="temporary" />)
  expect(screen.queryByTestId('stand-in-notification-prompt')).not.toBeInTheDocument()
  expect(localStorage.getItem('temporary.notificationPromptHidden')).toBeNull()
})
