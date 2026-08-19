import { act, renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { setActiveWorkbenchAppRegistry, useActiveWorkbenchApps, WorkbenchAppRegistry } from './apps'

function app(key: string) {
  return {
    key,
    mode: 'native' as const,
    path: `/${key}`,
    labelKey: `${key}.label`,
    label: key,
    descriptionKey: `${key}.description`,
    description: key,
  }
}

describe('active Workbench app registry', () => {
  test('keeps mounted consumers subscribed across registry replacement and restoration', () => {
    const first = new WorkbenchAppRegistry()
    const restoreFirst = setActiveWorkbenchAppRegistry(first)
    const hook = renderHook(() => useActiveWorkbenchApps())

    act(() => {
      first.register(app('first'))
    })
    expect(hook.result.current.map(item => item.key)).toEqual(['first'])

    const second = new WorkbenchAppRegistry()
    let restoreSecond = () => undefined
    act(() => {
      restoreSecond = setActiveWorkbenchAppRegistry(second)
      second.register(app('second'))
    })
    expect(hook.result.current.map(item => item.key)).toEqual(['second'])

    act(() => restoreSecond())
    expect(hook.result.current.map(item => item.key)).toEqual(['first'])

    hook.unmount()
    restoreFirst()
  })
})
