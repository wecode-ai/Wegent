import { act, renderHook } from '@testing-library/react'
import { SlidersHorizontal } from 'lucide-react'
import { describe, expect, test, vi } from 'vitest'

import {
  setActiveWorkbenchSettingsRegistry,
  useActiveWorkbenchSettings,
  WorkbenchSettingsRegistry,
} from './settings'

function contribution(key = 'example', path = '/settings/example') {
  return {
    key,
    path,
    icon: SlidersHorizontal,
    labelKey: 'settings_nav_example',
    label: 'Example',
    category: 'plugins',
    categoryLabelKey: 'settings_category_plugins',
    categoryLabel: 'Plugins',
    render: () => null,
  }
}

describe('WorkbenchSettingsRegistry', () => {
  test('resolves aliases and notifies subscribers across registration lifecycle', () => {
    const registry = new WorkbenchSettingsRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const item = {
      ...contribution(),
      aliases: ['/settings/example-alias'],
    }

    const dispose = registry.register(item)

    expect(registry.resolve('example')).toBe(item)
    expect(registry.resolvePath('/settings/example-alias')).toBe(item)
    expect(listener).toHaveBeenCalledOnce()

    dispose()

    expect(registry.resolve('example')).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('rejects duplicate keys and paths', () => {
    const registry = new WorkbenchSettingsRegistry()
    registry.register(contribution())

    expect(() => registry.register(contribution())).toThrow('already registered')
    expect(() => registry.register(contribution('other'))).toThrow('path')
  })

  test('keeps mounted consumers subscribed across registry replacement and restoration', () => {
    const first = new WorkbenchSettingsRegistry()
    const restoreFirst = setActiveWorkbenchSettingsRegistry(first)
    const hook = renderHook(() => useActiveWorkbenchSettings())

    act(() => {
      first.register(contribution('first', '/settings/first'))
    })
    expect(hook.result.current.map(item => item.key)).toEqual(['first'])

    const second = new WorkbenchSettingsRegistry()
    let restoreSecond = () => undefined
    act(() => {
      restoreSecond = setActiveWorkbenchSettingsRegistry(second)
      second.register(contribution('second', '/settings/second'))
    })
    expect(hook.result.current.map(item => item.key)).toEqual(['second'])

    act(() => restoreSecond())
    expect(hook.result.current.map(item => item.key)).toEqual(['first'])

    hook.unmount()
    restoreFirst()
  })
})
