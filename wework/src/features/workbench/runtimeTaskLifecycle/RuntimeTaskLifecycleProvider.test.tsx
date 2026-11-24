import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { getRuntimeTaskLifecycleKey } from './RuntimeTaskMachine'
import { useRuntimeTaskLifecycle, useRuntimeTaskLifecycleStore } from './context'
import { RuntimeTaskLifecycleProvider } from './RuntimeTaskLifecycleProvider'
import {
  createRuntimeTaskLifecycleOwnershipView,
  RuntimeTaskLifecycleStore,
} from './RuntimeTaskLifecycleStore'

const address: RuntimeTaskAddress = {
  deviceId: 'remote-device',
  taskId: 'claude-task',
}

function LifecycleProbe() {
  const lifecycle = useRuntimeTaskLifecycle(address)
  const writer = useRuntimeTaskLifecycleStore()
  return (
    <>
      <span data-testid="lifecycle-phase">{lifecycle?.execution.phase ?? 'missing'}</span>
      <button type="button" onClick={() => writer.turnStarted(address, 'hidden-turn')}>
        write
      </button>
    </>
  )
}

describe('RuntimeTaskLifecycleProvider', () => {
  test('reads the root store while routing mutations through the owned writer', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.executorSettled(address)
    const hiddenWriter = createRuntimeTaskLifecycleOwnershipView(store, () => false)

    render(
      <RuntimeTaskLifecycleProvider store={store} writerStore={hiddenWriter}>
        <LifecycleProbe />
      </RuntimeTaskLifecycleProvider>
    )

    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('idle')

    await userEvent.click(screen.getByRole('button', { name: 'write' }))
    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('idle')

    act(() => store.turnStarted(address, 'owned-turn'))
    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('running')
  })

  test('renders from the subscribed snapshot instead of the mutable machine', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.executorSettled(address)
    const runningStore = new RuntimeTaskLifecycleStore('running')
    runningStore.turnStarted(address, 'stale-turn')
    const staleMachineSnapshot = runningStore.getTask(address)
    store.getTask = () => staleMachineSnapshot

    render(
      <RuntimeTaskLifecycleProvider store={store}>
        <LifecycleProbe />
      </RuntimeTaskLifecycleProvider>
    )

    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('idle')
  })

  test('renders for its own task changes and removal while ignoring unrelated task updates', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.executorSettled(address)
    const initial = store.getSnapshot()
    const initialTask = store.selectTask(initial, address)
    const otherAddress = { ...address, taskId: 'other-task' }
    const renderPhase = vi.fn()
    function ScopedProbe() {
      const phase = useRuntimeTaskLifecycle(address)?.execution.phase ?? 'missing'
      renderPhase(phase)
      return <span>{phase}</span>
    }

    render(
      <RuntimeTaskLifecycleProvider store={store}>
        <ScopedProbe />
      </RuntimeTaskLifecycleProvider>
    )
    renderPhase.mockClear()

    act(() => store.turnStarted(otherAddress, 'other-turn'))
    expect(renderPhase).not.toHaveBeenCalled()
    expect(store.selectTask(store.getSnapshot(), address)).toBe(initialTask)
    const running = store.getSnapshot().runningTaskKeys
    const sidebarStatus = store.getSidebarStatus()
    act(() => store.turnStarted(otherAddress, 'next-turn'))
    expect(store.getSnapshot().runningTaskKeys).toBe(running)
    expect(store.getSidebarStatus()).toBe(sidebarStatus)

    act(() => store.turnStarted(address, 'owned-turn'))
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(store.selectTask(initial, address)?.execution.phase).toBe('idle')

    const key = getRuntimeTaskLifecycleKey(address)
    const beforeWaiting = store.getSidebarStatus()
    act(() => store.userInputRequested(address))
    expect(store.getSidebarStatus().waitingTaskKeys.has(key)).toBe(true)
    expect(beforeWaiting.waitingTaskKeys.has(key)).toBe(false)

    act(() => store.remove(address))
    expect(screen.getByText('missing')).toBeInTheDocument()
    expect(store.getSidebarStatus().waitingTaskKeys.has(key)).toBe(false)
    expect(store.getSidebarStatus().busyTaskKeys.has(key)).toBe(false)
  })

  test('rebinds an existing subscription when only the device alias changes', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const canonical = { ...address, deviceId: 'canonical-device' }
    store.turnStarted(canonical, 'owned-turn')
    const initialTasks = store.getSnapshot().tasks
    render(
      <RuntimeTaskLifecycleProvider store={store}>
        <LifecycleProbe />
      </RuntimeTaskLifecycleProvider>
    )
    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('missing')

    act(() =>
      store.syncRuntimeWork({
        projects: [],
        chats: [
          {
            deviceId: canonical.deviceId,
            remoteHostId: address.deviceId,
            available: true,
            workspacePath: '/repo',
            tasks: [],
          },
        ],
      })
    )

    expect(store.getSnapshot().tasks).toBe(initialTasks)
    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('running')
    act(() => store.remove(canonical))
    expect(screen.getByTestId('lifecycle-phase')).toHaveTextContent('missing')
  })
})
