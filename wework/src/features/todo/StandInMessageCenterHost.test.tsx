import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { MessageCenterSnapshot, StandInMessageCenterApi } from '@/api/standInMessageCenter'
import '@/i18n'
import { StandInMessageCenterHost } from './StandInMessageCenterHost'

const scope = { userId: 0, deviceId: 'local-executor' }

function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

function snapshot(
  account: string,
  overrides: Partial<MessageCenterSnapshot> = {}
): MessageCenterSnapshot {
  const at = new Date().toISOString()
  return {
    identity: { id: account, account, organization: 'Test organization' },
    deviceName: 'Local executor',
    updatedAt: at,
    status: 'active',
    records: [
      {
        id: 'shared-record-id',
        title: `${account} record`,
        sourceId: 'source',
        sourceName: 'Team group',
        sender: 'Colleague',
        message: 'Where are the meeting notes?',
        at,
        decision: 'reply',
        progress: 'complete',
        delivery: 'confirmed',
        receipt: { id: 'reply-1', kind: 'channel_receipt', verifiedAt: at },
        reply: 'They are in the pinned group message.',
        takenOver: false,
        policyVersion: 3,
        deviceName: 'Local executor',
      },
    ],
    sources: [{ id: 'source', name: 'Team group', kind: 'group', paused: false, included: true }],
    policyVersion: 3,
    capabilities: ['verifyDelivery'],
    ...overrides,
  }
}

function hostApi() {
  let invalidate!: Parameters<StandInMessageCenterApi['subscribeInvalidation']>[1]
  const api = {
    read: vi.fn<StandInMessageCenterApi['read']>(),
    apply: vi.fn<StandInMessageCenterApi['apply']>(),
    subscribeInvalidation: vi.fn<StandInMessageCenterApi['subscribeInvalidation']>(
      (_scope, listener) => {
        invalidate = listener
        return () => {}
      }
    ),
  }
  return {
    api,
    invalidate: (...args: Parameters<typeof invalidate>) => invalidate(...args),
  }
}

it('clears old identity records immediately and rejects an older in-flight read', async () => {
  const { api, invalidate } = hostApi()
  const oldRefresh = deferred<MessageCenterSnapshot>()
  const newIdentity = deferred<MessageCenterSnapshot>()
  api.read
    .mockResolvedValueOnce(snapshot('previous account'))
    .mockReturnValueOnce(oldRefresh.promise)
    .mockReturnValueOnce(newIdentity.promise)
  render(<StandInMessageCenterHost api={api} scope={scope} onOpenSettings={vi.fn()} />)
  await screen.findByText('previous account record')

  act(() => invalidate('facts'))
  act(() => invalidate('identity'))

  expect(screen.queryByText('previous account record')).not.toBeInTheDocument()
  await act(async () => oldRefresh.resolve(snapshot('late previous account')))
  expect(screen.queryByText('late previous account record')).not.toBeInTheDocument()
  await act(async () => newIdentity.resolve(snapshot('current account')))
  expect(screen.getByText('current account record')).toBeInTheDocument()
  expect(api.read.mock.calls).toEqual([[scope], [scope], [scope]])
})

it('keeps the open record when settings change for the same account', async () => {
  const { api, invalidate } = hostApi()
  const refresh = deferred<MessageCenterSnapshot>()
  const current = snapshot('active account')
  api.read.mockResolvedValueOnce(current).mockReturnValueOnce(refresh.promise)
  render(<StandInMessageCenterHost api={api} scope={scope} onOpenSettings={vi.fn()} />)
  await userEvent.setup().click(await screen.findByTestId('message-center-record-shared-record-id'))

  act(() => invalidate('identity', current.identity!.id))

  expect(screen.getByTestId('message-center-detail')).toBeInTheDocument()
  await act(async () => refresh.resolve({ ...current, status: 'paused', policyVersion: 4 }))
  expect(screen.getByTestId('message-center-detail')).toBeInTheDocument()
})

it.each([
  { state: 'missing identity', identity: null },
  {
    state: 'blank identity ID',
    identity: { id: ' ', account: 'previous account', organization: 'Test organization' },
  },
])('conceals account data when the host reports $state', async ({ identity }) => {
  const { api, invalidate } = hostApi()
  api.read.mockResolvedValueOnce(snapshot('previous account')).mockResolvedValueOnce(
    snapshot('previous account', {
      identity,
      status: 'disconnected',
      syncGap: 'Details from the previous account',
    })
  )
  render(<StandInMessageCenterHost api={api} scope={scope} onOpenSettings={vi.fn()} />)
  await screen.findByText('previous account record')

  await act(async () => invalidate('facts'))

  expect(screen.queryByText(/previous account/)).not.toBeInTheDocument()
  expect(screen.queryByTestId('message-center-verify-delivery')).not.toBeInTheDocument()
})

function unknownDelivery(account: string) {
  const current = snapshot(account)
  return {
    ...current,
    records: [
      {
        ...current.records[0],
        delivery: 'unknown' as const,
        receipt: undefined,
        canVerify: true,
      },
    ],
  }
}

it('passes an identity-scoped verification request and waits for the host receipt', async () => {
  const { api } = hostApi()
  const current = unknownDelivery('active account')
  const verification = deferred<MessageCenterSnapshot>()
  api.read.mockResolvedValue(current)
  api.apply.mockReturnValueOnce(verification.promise)
  render(<StandInMessageCenterHost api={api} scope={scope} onOpenSettings={vi.fn()} />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('message-center-record-shared-record-id'))
  const verifyButton = screen.getByTestId('message-center-verify-delivery')

  await user.click(verifyButton)

  expect(api.apply).toHaveBeenCalledExactlyOnceWith(
    scope,
    { identityId: 'active account', policyVersion: 3 },
    { type: 'verifyDelivery', recordId: 'shared-record-id' }
  )
  expect(verifyButton).toBeDisabled()
  expect(screen.getByTestId('message-center-detail')).toHaveTextContent('结果未知')

  await act(async () => verification.resolve(snapshot('active account')))
  expect(screen.getByTestId('message-center-detail')).toHaveTextContent('reply-1')
  expect(screen.queryByTestId('message-center-verify-delivery')).not.toBeInTheDocument()
})

it('discards a command result for a different identity and refreshes the current account', async () => {
  const { api } = hostApi()
  const verifiedAccount = deferred<MessageCenterSnapshot>()
  api.read
    .mockResolvedValueOnce(unknownDelivery('known account'))
    .mockReturnValueOnce(verifiedAccount.promise)
  api.apply.mockResolvedValueOnce(snapshot('mismatched account'))
  render(<StandInMessageCenterHost api={api} scope={scope} onOpenSettings={vi.fn()} />)

  const user = userEvent.setup()
  await user.click(await screen.findByTestId('message-center-record-shared-record-id'))
  await user.click(screen.getByTestId('message-center-verify-delivery'))

  expect(screen.queryByText('mismatched account record')).not.toBeInTheDocument()
  expect(api.read).toHaveBeenCalledTimes(2)
  await act(async () => verifiedAccount.resolve(snapshot('verified account')))
  expect(screen.getByText('verified account record')).toBeInTheDocument()
})

it('binds takeover to the current account and applies the host result', async () => {
  const { api } = hostApi()
  const current = snapshot('active account', { capabilities: ['takeOver'] })
  const pending = {
    ...current.records[0],
    delivery: 'unknown' as const,
    receipt: undefined,
    canTakeOver: true,
  }
  api.read.mockResolvedValue({ ...current, records: [pending] })
  api.apply.mockResolvedValue({ ...current, records: [{ ...pending, takenOver: true }] })
  render(<StandInMessageCenterHost api={api} scope={scope} onOpenSettings={vi.fn()} />)
  const user = userEvent.setup()
  const row = await screen.findByTestId('message-center-record-shared-record-id')

  expect(screen.getByTestId('message-center-filter')).toHaveValue('exceptions')
  await user.click(row)
  await user.click(screen.getByTestId('message-center-take-over'))

  expect(api.apply).toHaveBeenCalledExactlyOnceWith(
    scope,
    { identityId: 'active account', policyVersion: 3 },
    { type: 'takeOver', recordId: 'shared-record-id' }
  )
  expect(screen.getByTestId('message-center-detail')).toHaveTextContent('本人已接管')
  expect(screen.queryByTestId('message-center-take-over')).not.toBeInTheDocument()
})
