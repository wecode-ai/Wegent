import { createComputerUseStatusStore } from './computerUseStatusStore'
import { getComputerUseStatus } from '@/desktop/computerUse'
import { subscribeDesktopHostEvents, type DesktopHostEvent } from '@/api/dsh/desktopHost'

vi.mock('@/desktop/computerUse', () => ({ getComputerUseStatus: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: vi.fn() }))

test('recovers a failed initial read without polling after recovery or unsubscription', async () => {
  vi.useFakeTimers()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(subscribeDesktopHostEvents).mockReturnValue(() => {})
  vi.mocked(getComputerUseStatus)
    .mockRejectedValueOnce(new Error('Host unavailable'))
    .mockResolvedValue({ currentTool: 'click' } as Awaited<ReturnType<typeof getComputerUseStatus>>)
  const store = createComputerUseStatusStore()
  let stop = store.subscribe(vi.fn())
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot()).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getSnapshot()?.currentTool).toBe('click')
    const recoveredCalls = vi.mocked(getComputerUseStatus).mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getComputerUseStatus).toHaveBeenCalledTimes(recoveredCalls)
    stop()
    vi.mocked(getComputerUseStatus).mockRejectedValue(new Error('Host unavailable'))
    stop = store.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    const failedCalls = vi.mocked(getComputerUseStatus).mock.calls.length
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getComputerUseStatus).toHaveBeenCalledTimes(failedCalls)
  } finally {
    stop()
    error.mockRestore()
    vi.mocked(getComputerUseStatus).mockReset()
    vi.useRealTimers()
  }
})

test('an action event remains visible while the initial status request stalls or finishes stale', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: Awaited<ReturnType<typeof getComputerUseStatus>>) => void
    vi.mocked(getComputerUseStatus).mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    let onEvent!: (event: DesktopHostEvent) => void
    vi.mocked(subscribeDesktopHostEvents).mockImplementation(handler => {
      onEvent = handler
      return () => {}
    })
    const store = createComputerUseStatusStore()
    const unsubscribe = store.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    onEvent({ sequence: 1, type: 'computerUse.changed', payload: { currentTool: 'click' } })
    expect(store.getSnapshot()?.currentTool).toBe('click')
    finish({ currentTool: null } as Awaited<ReturnType<typeof getComputerUseStatus>>)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot()?.currentTool).toBe('click')
    onEvent({ sequence: 2, type: 'computerUse.changed', payload: { currentTool: null } })
    expect(store.getSnapshot()?.currentTool).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getComputerUseStatus).toHaveBeenCalledOnce()
    unsubscribe()
  } finally {
    vi.useRealTimers()
  }
})

test('a completed host event fences a delayed stop response even without view listeners', async () => {
  let onEvent!: (event: DesktopHostEvent) => void
  const release = vi.fn()
  vi.mocked(subscribeDesktopHostEvents).mockImplementation(handler => {
    onEvent = handler
    return release
  })
  const store = createComputerUseStatusStore()
  let finish!: (value: Awaited<ReturnType<typeof getComputerUseStatus>>) => void
  const pending = store.updateFrom(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  onEvent({ sequence: 1, type: 'computerUse.changed', payload: { currentTool: null } })
  finish({ currentTool: 'click' } as Awaited<ReturnType<typeof getComputerUseStatus>>)
  await pending
  expect(store.getSnapshot()?.currentTool).toBeNull()
  expect(release).toHaveBeenCalledOnce()

  await store.updateFrom(
    async () => ({ currentTool: 'new-action' }) as Awaited<ReturnType<typeof getComputerUseStatus>>
  )
  expect(store.getSnapshot()?.currentTool).toBe('new-action')
})
