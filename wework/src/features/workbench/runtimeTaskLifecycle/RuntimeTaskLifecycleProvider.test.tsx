import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStore,
  useRuntimeTaskLifecycleStoreSnapshot,
} from './context'
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

  test('updates a task row only when its lifecycle changes', () => {
    const store = new RuntimeTaskLifecycleStore('task-row')
    store.executorSettled(address)
    let renders = 0
    function TaskRow() {
      const task = useRuntimeTaskLifecycle(address)
      renders++
      return <output>{task?.execution.phase}</output>
    }
    render(
      <RuntimeTaskLifecycleProvider store={store}>
        <TaskRow />
      </RuntimeTaskLifecycleProvider>
    )
    const initialRenders = renders

    act(() => store.turnStarted({ ...address, taskId: 'other-task' }, 'other-turn'))
    expect(renders).toBe(initialRenders)
    expect(screen.getByRole('status')).toHaveTextContent('idle')

    act(() => store.turnStarted(address, 'current-turn'))
    expect(screen.getByRole('status')).toHaveTextContent('running')
  })

  test('an inactive task surface renders the current snapshot when opened', () => {
    const store = new RuntimeTaskLifecycleStore('test')
    store.executorSettled(address)
    function TaskSurface({ visible }: { visible: boolean }) {
      const { runningTaskKeys } = useRuntimeTaskLifecycleStoreSnapshot(undefined, visible)
      return <output>{runningTaskKeys.size}</output>
    }
    const surface = (visible: boolean) => (
      <RuntimeTaskLifecycleProvider store={store}>
        <TaskSurface visible={visible} />
      </RuntimeTaskLifecycleProvider>
    )
    const { rerender } = render(surface(false))
    act(() => store.turnStarted(address, 'background-turn'))
    expect(screen.getByRole('status')).toHaveTextContent('0')

    rerender(surface(true))
    expect(screen.getByRole('status')).toHaveTextContent('1')
    act(() => store.executorSettled(address))
    expect(screen.getByRole('status')).toHaveTextContent('0')
  })
})
