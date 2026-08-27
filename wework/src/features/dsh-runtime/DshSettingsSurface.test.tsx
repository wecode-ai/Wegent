import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DshSettingsSurface, type WeworkDshSettingsModuleProps } from './DshSettingsSurface'
import { clearDshUiModuleCache } from './dshUiModules'

const modulePath = 'plugins/settings-state-test.js'
const page = {
  id: 'settings-state-test',
  category: 'test',
  categoryLabel: 'Test',
  label: 'State test',
  module: modulePath,
  path: '/settings/state-test',
}

describe('DshSettingsSurface', () => {
  beforeEach(() => {
    clearDshUiModuleCache()
  })

  afterEach(() => {
    delete window.__WEWORK_DSH_UI_MODULES__
  })

  test('preserves plugin state when the host rerenders after loading the module', async () => {
    const mounts = vi.fn()

    function SettingsPlugin({ devices }: WeworkDshSettingsModuleProps) {
      const [count, setCount] = useState(0)
      useEffect(() => {
        mounts()
      }, [])
      return (
        <button data-testid="settings-plugin-state" onClick={() => setCount(value => value + 1)}>
          {devices.length}:{count}
        </button>
      )
    }

    window.__WEWORK_DSH_UI_MODULES__ = {
      [modulePath]: { default: SettingsPlugin },
    }

    const props = {
      devices: [],
      onBack: vi.fn(),
      onOpenCloudSettings: vi.fn(),
      page,
    }
    let rendered: ReturnType<typeof render>
    await act(async () => {
      rendered = render(<DshSettingsSurface {...props} />)
    })

    expect(screen.getByTestId('settings-plugin-state')).toHaveTextContent('0:0')
    fireEvent.click(screen.getByTestId('settings-plugin-state'))
    expect(screen.getByTestId('settings-plugin-state')).toHaveTextContent('0:1')

    rendered.rerender(<DshSettingsSurface {...props} devices={[{} as never]} />)

    expect(screen.getByTestId('settings-plugin-state')).toHaveTextContent('1:1')
    expect(mounts).toHaveBeenCalledOnce()
  })
})
