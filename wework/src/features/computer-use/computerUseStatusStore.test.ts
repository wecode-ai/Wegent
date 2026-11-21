import { createComputerUseStatusStore } from './computerUseStatusStore'
import { getComputerUseStatus } from '@/desktop/computerUse'
import { subscribeDesktopHostEvents, type DesktopHostEvent } from '@/api/dsh/desktopHost'

vi.mock('@/desktop/computerUse', () => ({ getComputerUseStatus: vi.fn() }))
vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: vi.fn() }))

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
