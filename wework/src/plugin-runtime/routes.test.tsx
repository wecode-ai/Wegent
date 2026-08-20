import { describe, expect, test } from 'vitest'

import { WorkbenchRouteRegistry } from './routes'

describe('WorkbenchRouteRegistry', () => {
  test('registers and removes the exact contribution', () => {
    const routes = new WorkbenchRouteRegistry()
    const contribution = {
      id: 'plugins',
      path: '/plugins',
      telemetryFeature: 'plugins',
      render: () => null,
    }

    const dispose = routes.register(contribution)

    expect(routes.resolve('/plugins')).toBe(contribution)
    expect(routes.list()).toEqual([contribution])

    dispose()
    expect(routes.resolve('/plugins')).toBeNull()
  })

  test('rejects duplicate paths', () => {
    const routes = new WorkbenchRouteRegistry()
    routes.register({
      id: 'first',
      path: '/plugins',
      telemetryFeature: 'plugins',
      render: () => null,
    })

    expect(() =>
      routes.register({
        id: 'second',
        path: '/plugins',
        telemetryFeature: 'other',
        render: () => null,
      })
    ).toThrow("Workbench route '/plugins' is already registered")
  })
})
