import { act, renderHook } from '@testing-library/react'
import { LayoutDashboard } from 'lucide-react'
import { describe, expect, test, vi } from 'vitest'

import {
  setActiveWorkbenchRightPanelRegistry,
  useActiveWorkbenchRightPanels,
  WorkbenchRightPanelRegistry,
} from './right-panels'

function contribution(key = 'example') {
  return {
    key,
    label: 'Example',
    icon: LayoutDashboard,
    render: () => null,
  }
}

describe('WorkbenchRightPanelRegistry', () => {
  test('registers, resolves, notifies, and disposes contributions', () => {
    const registry = new WorkbenchRightPanelRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const item = contribution()

    const dispose = registry.register(item)

    expect(registry.resolve('example')).toBe(item)
    expect(registry.list()).toEqual([item])
    expect(listener).toHaveBeenCalledOnce()

    dispose()

    expect(registry.resolve('example')).toBeNull()
    expect(registry.list()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('rejects duplicate keys', () => {
    const registry = new WorkbenchRightPanelRegistry()
    registry.register(contribution())

    expect(() => registry.register(contribution())).toThrow('already registered')
  })

  test('keeps mounted consumers subscribed across registry replacement and restoration', () => {
    const first = new WorkbenchRightPanelRegistry()
    const restoreFirst = setActiveWorkbenchRightPanelRegistry(first)
    const hook = renderHook(() => useActiveWorkbenchRightPanels())

    act(() => {
      first.register(contribution('first'))
    })
    expect(hook.result.current.map(item => item.key)).toEqual(['first'])

    const second = new WorkbenchRightPanelRegistry()
    let restoreSecond = () => undefined
    act(() => {
      restoreSecond = setActiveWorkbenchRightPanelRegistry(second)
      second.register(contribution('second'))
    })
    expect(hook.result.current.map(item => item.key)).toEqual(['second'])

    act(() => restoreSecond())
    expect(hook.result.current.map(item => item.key)).toEqual(['first'])

    hook.unmount()
    restoreFirst()
  })
})
