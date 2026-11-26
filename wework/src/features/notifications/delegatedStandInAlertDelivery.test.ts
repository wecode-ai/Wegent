// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TaskSource } from './NotificationTaskSourceContext'
import { createDelegatedStandInAlertDelivery } from './delegatedStandInAlertDelivery'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@/features/todo/dingTalkMessageCenterApi', () => ({
  createDingTalkMessageCenterApi: () => ({ read: mocks.read }),
}))

vi.mock('@/features/workbench/runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: mocks.send,
}))

vi.mock('@/lib/runtime-environment', () => ({
  getDesktopWindowLabel: () => 'main',
}))

const record = {
  id: 'record',
  title: 'Question',
  sourceId: 'source',
  sourceName: '测试2',
  sender: 'peer',
  message: 'Could you confirm the date?',
  at: '2026-11-26T00:00:00Z',
  decision: 'needs_user' as const,
  progress: 'complete' as const,
  delivery: 'none' as const,
  reason: 'This is a new commitment.',
  takenOver: false,
  deviceName: 'device',
}

function source() {
  const standInApi = {
    personalGet: vi.fn(async () => ({ executionDeviceId: 'device' })),
  }
  return {
    services: {
      standInApi,
      getLocalRuntimeSidebarIdentity: vi.fn(async () => ({ deviceId: 'device' })),
    },
  } as unknown as TaskSource
}

describe('delegated stand-in alerts', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('wework.delegated-stand-in-alerts:account-key:baseline', '1')
    mocks.read.mockReset().mockResolvedValue({
      identity: { id: 'account', account: 'Owner', organization: 'Org' },
      records: [record],
    })
    mocks.send.mockReset().mockResolvedValue(true)
  })

  test('delivers one host notification per delegated decision', async () => {
    const delivery = createDelegatedStandInAlertDelivery('account-key')
    const input = source()
    const describeRecord = vi.fn(() => ({ title: 'Needs you', body: 'Confirm the date' }))

    delivery.observe({ source: input, userId: 7, systemEnabled: true, describe: describeRecord })
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    delivery.suspend()
    delivery.observe({ source: input, userId: 7, systemEnabled: true, describe: describeRecord })
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))

    expect(mocks.send).toHaveBeenCalledOnce()
    expect(describeRecord).toHaveBeenCalledOnce()
    delivery.release()
  })

  test.each([
    { name: 'baselined', firstDeliveryCount: 0 },
    { name: 'notified', firstDeliveryCount: 301 },
  ])(
    'remembers more than 300 $name decisions across polls and restarts',
    async ({ firstDeliveryCount }) => {
      vi.useFakeTimers()
      if (firstDeliveryCount === 0) {
        localStorage.removeItem('wework.delegated-stand-in-alerts:account-key:baseline')
      }
      const identity = { id: 'account', account: 'Owner', organization: 'Org' }
      const records = Array.from({ length: 301 }, (_, index) => ({
        ...record,
        id: `record-${index}`,
      }))
      mocks.read.mockResolvedValue({ identity, records })
      const observation = {
        source: source(),
        userId: 7,
        systemEnabled: true,
        describe: () => ({ title: 'Needs you', body: 'Confirm the date' }),
      }
      let delivery = createDelegatedStandInAlertDelivery('account-key')
      try {
        delivery.observe(observation)
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.send).toHaveBeenCalledTimes(firstDeliveryCount)

        await vi.advanceTimersByTimeAsync(15_000)
        expect(mocks.read).toHaveBeenCalledTimes(2)
        expect(mocks.send).toHaveBeenCalledTimes(firstDeliveryCount)

        delivery.release()
        delivery = createDelegatedStandInAlertDelivery('account-key')
        mocks.read.mockResolvedValue({ identity, records: [...records, record] })
        delivery.observe(observation)
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.read).toHaveBeenCalledTimes(3)
        expect(mocks.send).toHaveBeenCalledTimes(firstDeliveryCount + 1)
      } finally {
        delivery.release()
        vi.useRealTimers()
      }
    }
  )

  test('only retries the undelivered decision when the host refuses a notification', async () => {
    mocks.read.mockResolvedValue({
      identity: { id: 'account', account: 'Owner', organization: 'Org' },
      records: [record, { ...record, id: 'second', title: 'Second question' }],
    })
    mocks.send.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const observation = {
      source: source(),
      userId: 7,
      systemEnabled: true,
      describe: ({ title }: { title: string }) => ({ title, body: 'Confirm the date' }),
    }
    let delivery = createDelegatedStandInAlertDelivery('account-key')
    try {
      delivery.observe(observation)
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
      delivery.release()

      delivery = createDelegatedStandInAlertDelivery('account-key')
      delivery.observe(observation)
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(3))
      expect(mocks.send.mock.calls.map(([notification]) => notification.title)).toEqual([
        'Question',
        'Second question',
        'Second question',
      ])
    } finally {
      delivery.release()
    }
  })

  test('does not send when desktop notifications are disabled or the owner took over', async () => {
    const delivery = createDelegatedStandInAlertDelivery('account-key')
    const input = source()
    delivery.observe({
      source: input,
      userId: 7,
      systemEnabled: false,
      describe: () => ({ title: 'Needs you', body: 'Confirm the date' }),
    })
    await Promise.resolve()
    expect(mocks.send).not.toHaveBeenCalled()

    mocks.read.mockResolvedValue({
      identity: { id: 'account', account: 'Owner', organization: 'Org' },
      records: [{ ...record, takenOver: true }],
    })
    delivery.observe({
      source: input,
      userId: 7,
      systemEnabled: true,
      describe: () => ({ title: 'Needs you', body: 'Confirm the date' }),
    })
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    expect(mocks.send).not.toHaveBeenCalled()
    delivery.release()
  })

  test('does not notify for a technical failure even when the decision asks for the owner', async () => {
    mocks.read.mockResolvedValue({
      identity: { id: 'account', account: 'Owner', organization: 'Org' },
      records: [{ ...record, delivery: 'failed' }],
    })
    const delivery = createDelegatedStandInAlertDelivery('account-key')

    delivery.observe({
      source: source(),
      userId: 7,
      systemEnabled: true,
      describe: () => ({ title: 'Needs you', body: 'Confirm the date' }),
    })
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    expect(mocks.send).not.toHaveBeenCalled()
    delivery.release()
  })

  test('baselines existing decisions before alerting newly observed work', async () => {
    localStorage.removeItem('wework.delegated-stand-in-alerts:account-key:baseline')
    const delivery = createDelegatedStandInAlertDelivery('account-key')
    const input = source()
    const describeRecord = () => ({ title: 'Needs you', body: 'Confirm the date' })

    delivery.observe({ source: input, userId: 7, systemEnabled: true, describe: describeRecord })
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    expect(mocks.send).not.toHaveBeenCalled()

    mocks.read.mockResolvedValue({
      identity: { id: 'account', account: 'Owner', organization: 'Org' },
      records: [{ ...record, id: 'new-record', reason: 'A new request.' }],
    })
    delivery.suspend()
    delivery.observe({ source: input, userId: 7, systemEnabled: true, describe: describeRecord })
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    delivery.release()
  })
})
