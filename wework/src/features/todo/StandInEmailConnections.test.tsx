import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { newStandInRole } from '@/api/personalStandIn'
import { EMAIL_PROVIDER, StandInEmailConnections } from './StandInEmailConnections'
import type { AutomationNavigationHandle } from '@/features/automations/AutomationsPage'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/features/dsh-runtime/dshExtensions', () => ({
  getDshExtensionHost: () => ({ backend: { scope: () => ({ request }) } }),
}))

test('verifies account before connecting, keeps credentials out of role settings and clears the password', async () => {
  request.mockImplementation(async (method: string) =>
    method === 'emailAccounts' ? [] : { id: 'mail-account' }
  )
  const onChange = vi.fn()
  const role = newStandInRole('mac')
  render(<StandInEmailConnections role={role} local disabled={false} onChange={onChange} />)
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-email-add'))
  fireEvent.change(screen.getByTestId('stand-in-email-email'), {
    target: { value: 'owner@example.com' },
  })
  fireEvent.change(screen.getByTestId('stand-in-email-password'), {
    target: { value: 'test-only-password' },
  })
  fireEvent.change(screen.getByTestId('stand-in-email-imap-host'), {
    target: { value: 'imap.example.com' },
  })
  fireEvent.change(screen.getByTestId('stand-in-email-smtp-host'), {
    target: { value: 'smtp.example.com' },
  })
  await user.click(screen.getByTestId('stand-in-email-save'))
  await screen.findByTestId('stand-in-email-verified')
  expect(request).toHaveBeenCalledWith(
    'saveEmailAccount',
    expect.objectContaining({
      username: 'owner@example.com',
      password: 'test-only-password',
      imap: { host: 'imap.example.com', port: 993, secure: true },
    })
  )
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      connections: [
        expect.objectContaining({
          providerId: EMAIL_PROVIDER,
          profile: 'mail-account',
          id: 'INBOX',
          policy: { automatic: true, askBeforeAct: true, immediate: true },
        }),
      ],
    })
  )
  expect(JSON.stringify(onChange.mock.calls)).not.toContain('test-only-password')
  await user.click(screen.getByTestId('stand-in-email-add'))
  expect(screen.getByTestId('stand-in-email-password')).toHaveValue('')
})

test('defaults primary mailbox connections to background processing', async () => {
  request.mockResolvedValue([{ id: 'mail-account', email: 'owner@example.com' }])
  const onChange = vi.fn()
  render(
    <StandInEmailConnections
      role={newStandInRole('mac', '@primary')}
      local
      disabled={false}
      onChange={onChange}
    />
  )
  await userEvent.click(await screen.findByTestId('stand-in-email-connect-mail-account'))
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      connections: [
        expect.objectContaining({
          policy: { automatic: true, askBeforeAct: true, immediate: false },
        }),
      ],
    })
  )
})

test('preserves entered settings after failed verification and never creates a connection', async () => {
  request.mockImplementation(async (method: string) => {
    if (method === 'emailAccounts') return []
    throw new Error('email_smtp_failed')
  })
  const onChange = vi.fn()
  render(
    <StandInEmailConnections
      role={newStandInRole('mac')}
      local
      disabled={false}
      onChange={onChange}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-email-add'))
  for (const [key, value] of Object.entries({
    email: 'owner@example.com',
    password: 'test-only',
    'imap-host': 'imap.example.com',
    'smtp-host': 'smtp.example.com',
  }))
    fireEvent.change(screen.getByTestId(`stand-in-email-${key}`), { target: { value } })
  await user.click(screen.getByTestId('stand-in-email-save'))
  expect(await screen.findByRole('alert')).toHaveTextContent('SMTP')
  expect(screen.getByTestId('stand-in-email-email')).toHaveValue('owner@example.com')
  expect(onChange).not.toHaveBeenCalled()
})

test('does not access this device’s credentials when configuring a remote stand-in', async () => {
  request.mockClear()
  render(
    <StandInEmailConnections
      role={newStandInRole('remote')}
      local={false}
      disabled={false}
      onChange={vi.fn()}
    />
  )
  await waitFor(() => expect(screen.getByRole('status')).toBeVisible())
  expect(request).not.toHaveBeenCalled()
  expect(screen.queryByTestId('stand-in-email-add')).not.toBeInTheDocument()
})

test('requires an explicit discard before leaving a partially filled mailbox form', async () => {
  request.mockResolvedValue([])
  const ref = createRef<AutomationNavigationHandle>()
  const leave = vi.fn()
  render(
    <StandInEmailConnections
      ref={ref}
      role={newStandInRole('mac')}
      local
      disabled={false}
      onChange={vi.fn()}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-email-add'))
  fireEvent.change(screen.getByTestId('stand-in-email-email'), {
    target: { value: 'draft@example.com' },
  })
  act(() => ref.current?.requestLeave(leave))
  expect(leave).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-email-discard-cancel-button'))
  expect(screen.getByTestId('stand-in-email-email')).toHaveValue('draft@example.com')
  act(() => ref.current?.requestLeave(leave))
  await user.click(screen.getByTestId('stand-in-email-discard'))
  expect(leave).toHaveBeenCalledOnce()
  expect(screen.getByTestId('stand-in-email-email')).toHaveValue('')
})
