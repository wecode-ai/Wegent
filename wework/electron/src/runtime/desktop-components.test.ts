import { describe, expect, test, vi } from 'vitest'
import type {
  ComponentPaths,
  ComponentUpdateManager,
  ComponentUpdateManagerOptions,
} from './component-update-manager.js'
import {
  prepareDesktopComponents,
  shouldStageDesktopComponentUpdates,
} from './desktop-components.js'

const options: ComponentUpdateManagerOptions = {
  resourcesRoot: '/resources',
  dataDirectory: '/data',
  updateBaseUrl: 'https://updates.example.com',
  currentAppVersion: '1.0.0',
}

describe('prepareDesktopComponents', () => {
  test('does not create or read packaged components during development', async () => {
    const createManager = vi.fn()

    await expect(
      prepareDesktopComponents({
        isPackaged: false,
        managerOptions: options,
        createManager,
      })
    ).resolves.toEqual({ manager: null, paths: null })
    expect(createManager).not.toHaveBeenCalled()
  })

  test('prepares managed components for a packaged application', async () => {
    const paths: ComponentPaths = {
      coreDsh: '/components/core-dsh',
      weworkCorePlugins: '/components/wework-core-plugins',
      executor: '/components/executor',
      codex: '/components/codex',
    }
    const manager = {
      prepareStartup: vi.fn().mockResolvedValue(paths),
      confirmStartup: vi.fn(),
      rollbackStartup: vi.fn(),
      stageAvailableUpdate: vi.fn(),
    } as unknown as ComponentUpdateManager
    const createManager = vi.fn(() => manager)

    await expect(
      prepareDesktopComponents({
        isPackaged: true,
        managerOptions: options,
        createManager,
      })
    ).resolves.toEqual({ manager, paths })
    expect(createManager).toHaveBeenCalledWith(options)
    expect(manager.prepareStartup).toHaveBeenCalledOnce()
  })
})

describe('shouldStageDesktopComponentUpdates', () => {
  test('stages updates by default', () => {
    expect(shouldStageDesktopComponentUpdates({})).toBe(true)
  })

  test('skips updates when desktop E2E disables them', () => {
    expect(
      shouldStageDesktopComponentUpdates({
        WEWORK_E2E_DISABLE_COMPONENT_UPDATES: '1',
      })
    ).toBe(false)
  })
})
