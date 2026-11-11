import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const prefix = 'wework.interactions:test:1:'

function hostQueue() {
  harness.desktop = true
  let replies = [{ id: 'disk-receipt', interactionId: '', text: 'Recover from the host queue' }]
  harness.host.mockImplementation(async (command: string) => {
    if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
    if (command === 'notification.acknowledgeReply') replies = []
  })
  return {
    get: () => replies,
    send: (interactionId: string) => {
      replies[0].interactionId = interactionId
      harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' }))
    },
  }
}

it.each(['localStorage', 'disk'])(
  'keeps failed replies in the host through a renderer reload when %s persistence fails',
  async failure => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const queue = hostQueue()
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    await act(async () => context!.dismiss(item))
    const disk = Object.fromEntries(Object.entries(localStorage))
    let available = false
    harness.flushStorage.mockImplementation(async () => {
      if (!available) throw new Error('Disk unavailable')
      Object.assign(disk, Object.fromEntries(Object.entries(localStorage)))
    })
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (failure === 'localStorage' && !available && key === prefix + 'drafts')
        throw new Error('Quota exceeded')
      return original.call(this, key, value)
    })
    await act(async () => queue.send(item.id))
    expect(queue.get()).toHaveLength(1)
    expect(localStorage.getItem(prefix + 'native-replies') ?? '').not.toContain('disk-receipt')
    expect(disk[prefix + 'drafts']).not.toContain('disk-receipt')
    first.unmount()
    available = true
    // Renderer initialization restores the durable snapshot, not the failed in-memory write.
    localStorage.clear()
    for (const [key, value] of Object.entries(disk)) localStorage.setItem(key, value)
    view()
    await waitFor(() => expect(queue.get()).toEqual([]))
    expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('Recover from the host queue')
    expect(JSON.parse(disk[prefix + 'drafts'])[item.id]).toMatchObject({
      text: 'Recover from the host queue',
      interaction: { id: item.id, question: item.question },
      nativeReplyIds: ['disk-receipt'],
    })
    expect(harness.send).not.toHaveBeenCalled()
  }
)

it.each(['disk', 'localStorage'])(
  'acknowledges an accepted native send even when %s persistence is unavailable',
  async failure => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const queue = hostQueue()
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    harness.flushStorage.mockRejectedValue(new Error('Disk unavailable'))
    if (failure === 'localStorage') {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Quota exceeded')
      })
    }
    await act(async () => queue.send(context!.pending[0].id))
    await waitFor(() => expect(queue.get()).toEqual([]))
    expect(harness.send).toHaveBeenCalledOnce()
    expect(context!.drafts).toEqual({})
    expect(context!.replyDrafts).toEqual([])
  }
)

it('retains a late native reply when an earlier draft clear failed', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const queue = hostQueue()
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  act(() => context!.setDraft(item.id, 'Old draft'))
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem(prefix + 'drafts')!)[item.id]).toBe('Old draft')
  )

  const original = Storage.prototype.setItem
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === prefix + 'drafts') throw new Error('Quota exceeded')
    return original.call(this, key, value)
  })
  act(() => context!.setDraft(item.id, ''))
  await waitFor(() =>
    expect(write.mock.calls.some(([key]) => key === prefix + 'drafts')).toBe(true)
  )
  await act(async () => context!.dismiss(item))
  expect(context!.pending).toHaveLength(0)

  queue.send(item.id)
  await waitFor(() => expect(queue.get()).toHaveLength(1))
  expect(localStorage.getItem(prefix + 'drafts') ?? '').not.toContain('Recover from the host queue')

  write.mockRestore()
  queue.send(item.id)
  await waitFor(() => expect(queue.get()).toEqual([]))
  expect(JSON.parse(localStorage.getItem(prefix + 'drafts')!)[item.id]).toMatchObject({
    text: 'Recover from the host queue',
    nativeReplyIds: ['disk-receipt'],
  })
  expect(context!.replyDrafts).toEqual([
    expect.objectContaining({ text: 'Recover from the host queue' }),
  ])
})
