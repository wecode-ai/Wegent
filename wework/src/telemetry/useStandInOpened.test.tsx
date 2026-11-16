import { renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { subscribeBusinessEvents } from './businessEvents'
import { useStandInOpened } from './useStandInOpened'

test('counts work navigation once per visit without exposing the local task key', () => {
  const events: unknown[] = []
  const unsubscribe = subscribeBusinessEvents(event => events.push(event))
  try {
    const view = renderHook(({ active, key }) => useStandInOpened('work', 'role', active, key), {
      initialProps: { active: true, key: 'private-device:private-task' },
    })
    view.rerender({ active: true, key: 'private-device:private-task' })
    expect(events).toHaveLength(1)
    view.rerender({ active: true, key: 'private-device:other-task' })
    expect(events).toHaveLength(2)
    view.rerender({ active: false, key: 'private-device:other-task' })
    view.rerender({ active: true, key: 'private-device:other-task' })
    expect(events).toHaveLength(3)
    expect(JSON.stringify(events)).not.toContain('private-device')
    expect(JSON.stringify(events)).not.toContain('private-task')
    view.unmount()
  } finally {
    unsubscribe()
  }
})
