import { describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { resolve } from 'node:path'
import type { EmbeddedBrowserManager } from './embedded-browser-manager.js'
import type {
  HostCapability,
  HostCapabilityHandler,
  HostCapabilityRouter,
} from './capability-router.js'
import {
  captureWebContentsDataUrl,
  cpuLoadRatioBetween,
  e2eOpenDialogOverride,
  registerAppUpdateCapabilities,
  registerBrowserHistoryCapabilities,
  registerCoreDshPluginCapabilities,
  registerDesktopServiceCapabilities,
  registerPluginDevelopmentCapabilities,
  registerRendererStorageCapabilities,
  showElectronNotification,
} from './electron-capabilities.js'
import { HOST_CAPABILITIES } from './capability-router.js'
import type { AppUpdateService } from './app-update-service.js'
import type { FeedbackBundleManager } from './feedback-bundle-manager.js'
import type { RendererStorageStore } from './renderer-storage-store.js'

describe('cpuLoadRatioBetween', () => {
  test('calculates system utilization from cumulative CPU times', () => {
    expect(cpuLoadRatioBetween({ idle: 100, total: 200 }, { idle: 130, total: 300 })).toBeCloseTo(
      0.7
    )
    expect(cpuLoadRatioBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBe(0)
  })
})

describe('e2eOpenDialogOverride', () => {
  test('returns the selected directory only for a controlled desktop E2E process', () => {
    expect(
      e2eOpenDialogOverride({
        WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
        WEWORK_E2E_OPEN_DIALOG_PATH: '/workspace/plugin',
      })
    ).toEqual({
      canceled: false,
      filePaths: [resolve('/workspace/plugin')],
    })
  })

  test('does not bypass the native dialog without both E2E signals', () => {
    expect(e2eOpenDialogOverride({ WEWORK_E2E_OPEN_DIALOG_PATH: '/workspace/plugin' })).toBeNull()
    expect(e2eOpenDialogOverride({ WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234' })).toBeNull()
  })
})

describe('showElectronNotification', () => {
  test('opens the targeted runtime task when the notification is clicked', () => {
    const openRuntimeTask = vi.fn()
    const listeners = new Map<string, () => void>()
    const notification = {
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
      }),
      show: vi.fn(),
    }

    showElectronNotification(
      {
        title: 'Task completed',
        body: 'The reply is ready.',
        taskAddressId: 'device-1:task-1',
      },
      openRuntimeTask,
      () => notification
    )
    listeners.get('click')?.()

    expect(notification.show).toHaveBeenCalledOnce()
    expect(openRuntimeTask).toHaveBeenCalledWith('device-1:task-1')
  })

  test('does not add click navigation without a task target', () => {
    const notification = {
      once: vi.fn(),
      show: vi.fn(),
    }

    showElectronNotification(
      {
        title: 'Assigned',
        body: 'A project task was assigned.',
      },
      vi.fn(),
      () => notification
    )

    expect(notification.once).not.toHaveBeenCalled()
    expect(notification.show).toHaveBeenCalledOnce()
  })
})

function createWebContents(input: {
  captureDataUrl?: string
  captureEmpty?: boolean
  captureError?: Error
  capturePending?: boolean
  debuggerData?: string
  debuggerError?: Error
  debuggerPending?: boolean
}) {
  let debuggerAttached = false
  const debuggerSession = {
    attach: vi.fn(() => {
      debuggerAttached = true
    }),
    detach: vi.fn(() => {
      debuggerAttached = false
    }),
    isAttached: vi.fn(() => debuggerAttached),
    sendCommand: vi.fn(async () => {
      if (input.debuggerPending) return new Promise<never>(() => undefined)
      if (input.debuggerError) throw input.debuggerError
      return { data: input.debuggerData }
    }),
  }
  const capturePage = vi.fn(async () => {
    if (input.capturePending) return new Promise<never>(() => undefined)
    if (input.captureError) throw input.captureError
    return {
      isEmpty: () => input.captureEmpty ?? false,
      toDataURL: () => input.captureDataUrl ?? '',
    }
  })
  const contents = {
    capturePage,
    debugger: debuggerSession,
  } as unknown as WebContents
  return { capturePage, contents, debuggerSession }
}

describe('captureWebContentsDataUrl', () => {
  test('uses Electron native capturePage for the visible composed surface', async () => {
    const { capturePage, contents, debuggerSession } = createWebContents({
      captureDataUrl: 'data:image/png;base64,native-capture',
    })
    const rect = { x: 10, y: 20, width: 30, height: 40 }

    await expect(captureWebContentsDataUrl(contents, { rect })).resolves.toBe(
      'data:image/png;base64,native-capture'
    )
    expect(capturePage).toHaveBeenCalledWith(rect)
    expect(debuggerSession.attach).not.toHaveBeenCalled()
    expect(debuggerSession.sendCommand).not.toHaveBeenCalled()
  })

  test('can prefer debugger view capture without blocking on Electron capturePage', async () => {
    const { capturePage, contents, debuggerSession } = createWebContents({
      captureDataUrl: 'data:image/png;base64,native-capture',
      debuggerData: 'debugger-capture',
    })

    await expect(captureWebContentsDataUrl(contents, { preferDebugger: true })).resolves.toBe(
      'data:image/png;base64,debugger-capture'
    )
    expect(debuggerSession.attach).toHaveBeenCalledOnce()
    expect(debuggerSession.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      captureBeyondViewport: false,
      format: 'png',
      fromSurface: false,
    })
    expect(debuggerSession.detach).toHaveBeenCalledOnce()
    expect(capturePage).not.toHaveBeenCalled()
  })

  test('falls back to native capture when preferred debugger capture times out', async () => {
    vi.useFakeTimers()
    try {
      const { capturePage, contents, debuggerSession } = createWebContents({
        captureDataUrl: 'data:image/png;base64,native-after-debugger-timeout',
        debuggerPending: true,
      })

      const capture = captureWebContentsDataUrl(contents, { preferDebugger: true })
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(capture).resolves.toBe('data:image/png;base64,native-after-debugger-timeout')
      expect(debuggerSession.detach).toHaveBeenCalledOnce()
      expect(capturePage).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test('reports both capture failures', async () => {
    const { contents, debuggerSession } = createWebContents({
      captureError: new Error('UnknownVizError'),
      debuggerError: new Error('DebuggerCaptureError'),
    })
    const rect = { x: 10, y: 20, width: 30, height: 40 }

    await expect(captureWebContentsDataUrl(contents, { rect })).rejects.toThrow(
      'Electron capturePage failed: UnknownVizError; CDP Page.captureScreenshot failed: DebuggerCaptureError'
    )
    expect(debuggerSession.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      captureBeyondViewport: false,
      format: 'png',
      fromSurface: true,
      clip: { ...rect, scale: 1 },
    })
  })

  test('falls back to the debugger when Electron native capture hangs', async () => {
    vi.useFakeTimers()
    try {
      const { contents, debuggerSession } = createWebContents({
        capturePending: true,
        debuggerData: 'debugger-after-native-timeout',
      })

      const capture = captureWebContentsDataUrl(contents)
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(capture).resolves.toBe('data:image/png;base64,debugger-after-native-timeout')
      expect(debuggerSession.sendCommand).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  test('fails within a bounded time when both screenshot backends hang', async () => {
    vi.useFakeTimers()
    try {
      const { contents, debuggerSession } = createWebContents({
        capturePending: true,
        debuggerPending: true,
      })

      const capture = captureWebContentsDataUrl(contents)
      const rejection = expect(capture).rejects.toThrow(
        'Electron capturePage failed: Electron capturePage timed out after 10000ms; ' +
          'CDP Page.captureScreenshot failed: CDP Page.captureScreenshot timed out after 10000ms'
      )
      await vi.advanceTimersByTimeAsync(20_000)

      await rejection
      expect(debuggerSession.detach).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('registerBrowserHistoryCapabilities', () => {
  test('registers search and remove with the Electron history manager', async () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter
    const browser = {
      removeHistory: vi.fn(async () => 2),
      searchHistory: vi.fn(async () => []),
    } as unknown as EmbeddedBrowserManager

    registerBrowserHistoryCapabilities(router, browser)

    await handlers.get('browser.historySearch')?.(
      { text: 'docs', endTimeMs: 2_001, offset: 3, maxResults: 25 },
      { principal: 'test' }
    )
    await handlers.get('browser.historyRemove')?.({ ids: ['one', 'two'] }, { principal: 'test' })
    expect(browser.searchHistory).toHaveBeenCalledWith({
      text: 'docs',
      endTimeMs: 2_001,
      offset: 3,
      maxResults: 25,
    })
    expect(browser.removeHistory).toHaveBeenCalledWith(['one', 'two'])
  })
})

describe('registerAppUpdateCapabilities', () => {
  test('validates channels and forwards the updater lifecycle', async () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter
    const appUpdates = {
      check: vi.fn(async () => ({ currentVersion: '0.2.6', version: '0.2.7' })),
      download: vi.fn(async () => undefined),
      downloadProgress: vi.fn(() => ({ downloadedBytes: 25, totalBytes: 100 })),
      createInstallAction: vi.fn(() => vi.fn(async () => undefined)),
    } as unknown as AppUpdateService
    const installCompletions: Array<() => void | Promise<void>> = []
    const context = {
      principal: 'test',
      deferUntilResponseSent: (completion: () => void | Promise<void>) =>
        installCompletions.push(completion),
    }

    registerAppUpdateCapabilities(router, appUpdates)

    await expect(
      handlers.get('appUpdate.check')?.({ channel: 'stable' }, context)
    ).resolves.toEqual({
      currentVersion: '0.2.6',
      version: '0.2.7',
    })
    await handlers.get('appUpdate.download')?.({}, context)
    expect(await handlers.get('appUpdate.downloadProgress')?.({}, context)).toEqual({
      downloadedBytes: 25,
      totalBytes: 100,
    })
    await handlers.get('appUpdate.install')?.({}, context)

    expect(appUpdates.check).toHaveBeenCalledWith('stable')
    expect(appUpdates.download).toHaveBeenCalledOnce()
    expect(appUpdates.downloadProgress).toHaveBeenCalledOnce()
    expect(appUpdates.createInstallAction).toHaveBeenCalledOnce()
    expect(installCompletions).toHaveLength(1)
    await installCompletions[0]()
    expect(() => handlers.get('appUpdate.check')?.({ channel: 'nightly' }, context)).toThrow(
      'channel is invalid'
    )
  })

  test('reports update capabilities as unavailable without an updater service', () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter

    registerAppUpdateCapabilities(router, undefined)

    expect(() =>
      handlers.get('appUpdate.download')?.(
        {},
        { principal: 'test', deferUntilResponseSent: vi.fn() }
      )
    ).toThrow('App updates are unavailable')
  })
})

describe('registerRendererStorageCapabilities', () => {
  test('validates and forwards renderer storage initialization and updates', async () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter
    const rendererStorage = {
      initialize: vi.fn(async entries => entries),
      update: vi.fn(async () => undefined),
    } as unknown as RendererStorageStore

    registerRendererStorageCapabilities(router, rendererStorage)

    await expect(
      handlers.get('rendererStorage.initialize')?.(
        { entries: { appearance: 'dark' } },
        { principal: 'test' }
      )
    ).resolves.toEqual({ appearance: 'dark' })
    await expect(
      handlers.get('rendererStorage.update')?.(
        {
          clear: false,
          changes: { appearance: 'light', removed: null },
        },
        { principal: 'test' }
      )
    ).resolves.toEqual({ persisted: true })
    expect(rendererStorage.update).toHaveBeenCalledWith({
      clear: false,
      changes: { appearance: 'light', removed: null },
    })
    await expect(
      handlers.get('rendererStorage.update')?.(
        { clear: 'false', changes: {} },
        { principal: 'test' }
      )
    ).rejects.toThrow('clear is invalid')
  })
})

describe('registerDesktopServiceCapabilities', () => {
  test('allowlists and forwards all migrated desktop capability contracts', async () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter
    const feedback = {
      confirm: vi.fn(async () => ({ reportId: 'WF-1', path: '/downloads/report.zip' })),
      discard: vi.fn(async () => undefined),
      preview: vi.fn(async () => ({ stagingId: 'stage-1' })),
    } as unknown as FeedbackBundleManager
    const coreDshPlugins = {
      listCoreDshPlugins: vi.fn(async () => []),
      installCoreDshPlugin: vi.fn(async () => []),
      updateCoreDshPlugin: vi.fn(async () => []),
      setCoreDshPluginEnabled: vi.fn(async () => []),
      uninstallCoreDshPlugin: vi.fn(async () => []),
    }
    const developer = {
      openDevTools: vi.fn(),
      openLogDirectory: vi.fn(async () => undefined),
    }
    const cleanupStaleTemporaryImages = vi.fn(async () => undefined)
    const expectedCapabilities = [
      'feedback.previewBundle',
      'feedback.confirmBundle',
      'feedback.discardBundle',
      'developer.openLogDirectory',
      'developer.openDevTools',
      'maintenance.cleanupTemporaryImages',
      'maintenance.getSystemPressure',
    ] as const

    registerDesktopServiceCapabilities(
      router,
      { cleanupStaleTemporaryImages, coreDshPlugins: () => coreDshPlugins, feedback },
      developer
    )

    expect(HOST_CAPABILITIES).toEqual(expect.arrayContaining(expectedCapabilities))
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(expectedCapabilities))
    await handlers.get('feedback.previewBundle')?.(
      {
        request: {
          includeRuntimeLogs: true,
          includeTaskInfo: false,
          includeScreenshot: false,
          includeSystemInfo: true,
          note: 'note',
          taskContext: null,
          screenshotDataUrl: null,
          composerDiagnostics: null,
          attachments: [],
        },
      },
      { principal: 'test' }
    )
    await handlers.get('feedback.confirmBundle')?.(
      { decision: { stagingId: 'stage-1' } },
      { principal: 'test' }
    )
    await handlers.get('feedback.discardBundle')?.(
      { decision: { stagingId: 'stage-1' } },
      { principal: 'test' }
    )
    await handlers.get('maintenance.cleanupTemporaryImages')?.({}, { principal: 'test' })
    await handlers.get('developer.openLogDirectory')?.({}, { principal: 'test' })
    await handlers.get('developer.openDevTools')?.({}, { principal: 'test' })

    expect(feedback.preview).toHaveBeenCalledWith(
      expect.objectContaining({ includeRuntimeLogs: true, includeSystemInfo: true })
    )
    expect(feedback.confirm).toHaveBeenCalledWith('stage-1')
    expect(feedback.discard).toHaveBeenCalledWith('stage-1')
    expect(cleanupStaleTemporaryImages).toHaveBeenCalledOnce()
    expect(developer.openLogDirectory).toHaveBeenCalledOnce()
    expect(developer.openDevTools).toHaveBeenCalledOnce()
  })
})

describe('registerCoreDshPluginCapabilities', () => {
  test('forwards the explicit Core DSH plugin operations', async () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter
    const coreDshPlugins = {
      listCoreDshPlugins: vi.fn(async () => []),
      installCoreDshPlugin: vi.fn(async () => []),
      updateCoreDshPlugin: vi.fn(async () => []),
      setCoreDshPluginEnabled: vi.fn(async () => []),
      uninstallCoreDshPlugin: vi.fn(async () => []),
    }
    const services = {
      cleanupStaleTemporaryImages: vi.fn(async () => undefined),
      coreDshPlugins: () => coreDshPlugins,
      feedback: {} as FeedbackBundleManager,
    }

    registerCoreDshPluginCapabilities(router, services)
    await handlers.get('runtime.listCoreDshPlugins')?.({}, { principal: 'test' })
    await handlers.get('runtime.installCoreDshPlugin')?.(
      { spec: 'github:owner/plugin' },
      { principal: 'test' }
    )
    await handlers.get('runtime.updateCoreDshPlugin')?.(
      { name: 'dsh-example' },
      { principal: 'test' }
    )
    await handlers.get('runtime.setCoreDshPluginEnabled')?.(
      { name: 'dsh-example', enabled: false },
      { principal: 'test' }
    )
    await handlers.get('runtime.uninstallCoreDshPlugin')?.(
      { name: 'dsh-example' },
      { principal: 'test' }
    )

    expect(coreDshPlugins.listCoreDshPlugins).toHaveBeenCalledOnce()
    expect(coreDshPlugins.installCoreDshPlugin).toHaveBeenCalledWith('github:owner/plugin')
    expect(coreDshPlugins.updateCoreDshPlugin).toHaveBeenCalledWith('dsh-example')
    expect(coreDshPlugins.setCoreDshPluginEnabled).toHaveBeenCalledWith('dsh-example', false)
    expect(coreDshPlugins.uninstallCoreDshPlugin).toHaveBeenCalledWith('dsh-example')
  })
})

describe('registerPluginDevelopmentCapabilities', () => {
  test('forwards isolated Wework lifecycle operations', async () => {
    const handlers = new Map<HostCapability, HostCapabilityHandler>()
    const router = {
      register: vi.fn((capability: HostCapability, handler: HostCapabilityHandler) => {
        handlers.set(capability, handler)
      }),
    } as unknown as HostCapabilityRouter
    const pluginDevelopment = {
      deleteData: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      openDevTools: vi.fn(async () => undefined),
      openLogDirectory: vi.fn(async () => undefined),
      restartCoreDsh: vi.fn(async () => undefined),
      start: vi.fn(async () => ({})),
      stop: vi.fn(async () => undefined),
      validate: vi.fn(async () => ({})),
    }
    const services = {
      pluginDevelopment: () => pluginDevelopment,
    }

    registerPluginDevelopmentCapabilities(router, services)
    await handlers.get('pluginDevelopment.list')?.({}, { principal: 'test' })
    await handlers.get('pluginDevelopment.validate')?.(
      { sourceRoot: '/workspace/plugin' },
      { principal: 'test' }
    )
    await handlers.get('pluginDevelopment.start')?.(
      { sourceRoot: '/workspace/plugin' },
      { principal: 'test' }
    )
    await handlers.get('pluginDevelopment.focus')?.({}, { principal: 'test' })
    await handlers.get('pluginDevelopment.restartCoreDsh')?.({}, { principal: 'test' })
    await handlers.get('pluginDevelopment.openDevTools')?.({}, { principal: 'test' })
    await handlers.get('pluginDevelopment.openLogDirectory')?.({}, { principal: 'test' })
    await handlers.get('pluginDevelopment.stop')?.({}, { principal: 'test' })
    await handlers.get('pluginDevelopment.deleteData')?.({}, { principal: 'test' })

    expect(pluginDevelopment.validate).toHaveBeenCalledWith('/workspace/plugin')
    expect(pluginDevelopment.start).toHaveBeenCalledWith('/workspace/plugin')
    expect(pluginDevelopment.focus).toHaveBeenCalledOnce()
    expect(pluginDevelopment.restartCoreDsh).toHaveBeenCalledOnce()
    expect(pluginDevelopment.openDevTools).toHaveBeenCalledOnce()
    expect(pluginDevelopment.openLogDirectory).toHaveBeenCalledOnce()
    expect(pluginDevelopment.stop).toHaveBeenCalledOnce()
    expect(pluginDevelopment.deleteData).toHaveBeenCalledOnce()
  })
})
