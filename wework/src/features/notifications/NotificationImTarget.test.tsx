import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IMPrivateSession } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { NotificationImTarget } from './NotificationImTarget'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
afterEach(() => vi.restoreAllMocks())

const session = (key: string): IMPrivateSession => ({
  session_key: key,
  channel_type: 'wecom',
  channel_label: 'WeCom',
  channel_id: 1,
  conversation_id: key,
  sender_id: key,
  display_name: key,
  mode: 'task',
  state: 'idle',
  active_task_id: null,
  last_seen_at: '2026-10-30T00:00:00Z',
})

function view(list = vi.fn().mockResolvedValue({ items: [session('one'), session('two')] })) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(
    <NotificationImTarget
      services={{ imSessionApi: { listPrivateSessions: list } } as unknown as WorkbenchServices}
      selected="two"
      onSave={onSave}
      onClose={onClose}
    />
  )
  return { list, onSave, onClose }
}

it('preserves the global destination and changes it only after explicit save', async () => {
  const h = view()
  expect(await screen.findByTestId('continue-im-session-two')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(h.onSave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('continue-im-session-one'))
  expect(h.onSave).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('continue-im-submit-button'))
  await waitFor(() => expect(h.onSave).toHaveBeenCalledExactlyOnceWith('one'))
  expect(h.onClose).toHaveBeenCalledOnce()
})

it('keeps the selection and dialog open after a rejected update, allowing retry', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = view()
  h.onSave.mockRejectedValueOnce(new Error('Update rejected'))
  await screen.findByTestId('continue-im-session-two')
  fireEvent.click(screen.getByTestId('continue-im-submit-button'))
  await screen.findByRole('alert')
  expect(h.onClose).not.toHaveBeenCalled()
  expect(screen.getByTestId('continue-im-session-two')).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByTestId('continue-im-submit-button'))
  await waitFor(() => expect(h.onClose).toHaveBeenCalledOnce())
  expect(h.onSave.mock.calls).toEqual([['two'], ['two']])
})

it('shows destination loading failure without enabling an empty save', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const h = view(vi.fn().mockRejectedValue(new Error('Offline')))
  await screen.findByRole('alert')
  expect(screen.getByTestId('continue-im-submit-button')).toBeDisabled()
  expect(h.onSave).not.toHaveBeenCalled()
})
