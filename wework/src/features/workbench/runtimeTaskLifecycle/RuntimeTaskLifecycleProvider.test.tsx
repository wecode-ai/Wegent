import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
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
})
