import { SlidersHorizontal } from 'lucide-react'
import { describe, expect, test, vi } from 'vitest'

import { WorkbenchSettingsRegistry } from './settings'

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
})
