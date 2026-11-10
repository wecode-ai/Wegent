import { describe, expect, it, vi } from 'vitest'
import { deliverNativeConversationMessage } from './nativeConversationDelivery'

describe('native conversation turn boundary', () => {
  const isBusyError = (error: string | null) => error === 'busy'
  it('steers an active parent without cancelling or waiting for its subagents', async () => {
    const send = vi.fn()
    const guide = vi.fn(async () => ({ sent: true, turnId: 'parent' }))
    expect(
      await deliverNativeConversationMessage({ busy: true, send, guide, isBusyError })
    ).toEqual({ sent: true, turnId: 'parent', delivery: 'guidance' })
    expect(send).not.toHaveBeenCalled()
  })
  it('starts a new turn only after an explicit no-active-turn rejection', async () => {
    const send = vi.fn(async () => ({ sent: true }))
    const guide = vi.fn(async () => ({ sent: false, code: 'no_active_turn' }))
    expect(
      (await deliverNativeConversationMessage({ busy: true, send, guide, isBusyError })).delivery
    ).toBe('message')
    expect(send).toHaveBeenCalledOnce()
  })
  it('steers if another native turn starts before the idle send is accepted', async () => {
    const send = vi.fn(async () => ({ sent: false, error: 'busy' }))
    const guide = vi.fn(async () => ({ sent: true }))
    expect(
      (await deliverNativeConversationMessage({ busy: false, send, guide, isBusyError })).delivery
    ).toBe('guidance')
    expect(guide).toHaveBeenCalledOnce()
  })
  it.each(['permission_denied', 'network_error'])('never resends after %s', async code => {
    const send = vi.fn()
    const guide = vi.fn(async () => ({ sent: false, code }))
    expect(
      (await deliverNativeConversationMessage({ busy: true, send, guide, isBusyError })).sent
    ).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
