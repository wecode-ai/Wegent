import { describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { EmbeddedBrowserManager } from './embedded-browser-manager.js'
import type {
  HostCapability,
  HostCapabilityHandler,
  HostCapabilityRouter,
} from './capability-router.js'
import {
  captureWebContentsDataUrl,
  registerBrowserHistoryCapabilities,
  registerDesktopServiceCapabilities,
} from './electron-capabilities.js'
import { HOST_CAPABILITIES } from './capability-router.js'
import type { FeedbackBundleManager } from './feedback-bundle-manager.js'
import type { WorkbenchPluginManager } from './workbench-plugin-manager.js'

function createWebContents(input: {
  captureDataUrl?: string
  captureEmpty?: boolean
  captureError?: Error
  debuggerData?: string
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
    sendCommand: vi.fn(async () => ({ data: input.debuggerData })),
  }
  const contents = {
    capturePage: vi.fn(async () => {
      if (input.captureError) throw input.captureError
      return {
        isEmpty: () => input.captureEmpty ?? false,
        toDataURL: () => input.captureDataUrl ?? '',
      }
    }),
    debugger: debuggerSession,
  } as unknown as WebContents
  return { contents, debuggerSession }
}

describe('captureWebContentsDataUrl', () => {
  test('uses Electron native capturePage for the visible composed surface', async () => {
    const { contents, debuggerSession } = createWebContents({
      captureDataUrl: 'data:image/png;base64,native-capture',
    })

    await expect(captureWebContentsDataUrl(contents)).resolves.toBe(
      'data:image/png;base64,native-capture'
    )
    expect(debuggerSession.attach).not.toHaveBeenCalled()
    expect(debuggerSession.sendCommand).not.toHaveBeenCalled()
  })

  test('falls back to the debugger when capturePage returns an empty image', async () => {
    const { contents, debuggerSession } = createWebContents({
      captureEmpty: true,
      debuggerData: 'debugger-capture',
    })

    await expect(captureWebContentsDataUrl(contents)).resolves.toBe(
      'data:image/png;base64,debugger-capture'
    )
    expect(debuggerSession.attach).toHaveBeenCalledOnce()
    expect(debuggerSession.detach).toHaveBeenCalledOnce()
  })

  test('falls back to the debugger when Electron native capture throws', async () => {
    const { contents, debuggerSession } = createWebContents({
      captureError: new Error('UnknownVizError'),
      debuggerData: 'debugger-after-native-error',
    })

    await expect(captureWebContentsDataUrl(contents)).resolves.toBe(
      'data:image/png;base64,debugger-after-native-error'
    )
    expect(debuggerSession.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      captureBeyondViewport: false,
      format: 'png',
      fromSurface: true,
    })
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
    const plugins = {
      authorizeCapability: vi.fn(async () => true),
      list: vi.fn(async () => []),
      request: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    } as unknown as WorkbenchPluginManager
    const developer = {
      openDevTools: vi.fn(),
      openLogDirectory: vi.fn(async () => undefined),
    }
    const expectedCapabilities = [
      'feedback.previewBundle',
      'feedback.confirmBundle',
      'feedback.discardBundle',
      'developer.openLogDirectory',
      'developer.openDevTools',
      'plugins.list',
      'plugins.start',
      'plugins.stop',
      'plugins.request',
      'plugins.authorizeCapability',
    ] as const

    registerDesktopServiceCapabilities(router, { feedback, plugins }, developer)

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
    await handlers.get('plugins.authorizeCapability')?.(
      { pluginRoot: '/plugins/example', capability: 'files.read' },
      { principal: 'test' }
    )
    await handlers.get('plugins.start')?.(
      { pluginId: 'example', pluginRoot: '/plugins/example' },
      { principal: 'test' }
    )
    await handlers.get('plugins.request')?.(
      {
        pluginId: 'example',
        capability: 'files.read',
        method: 'files/read',
        params: { path: '/tmp/a' },
      },
      { principal: 'test' }
    )
    await handlers.get('plugins.stop')?.({ pluginId: 'example' }, { principal: 'test' })
    await handlers.get('plugins.list')?.({}, { principal: 'test' })
    await handlers.get('developer.openLogDirectory')?.({}, { principal: 'test' })
    await handlers.get('developer.openDevTools')?.({}, { principal: 'test' })

    expect(feedback.preview).toHaveBeenCalledWith(
      expect.objectContaining({ includeRuntimeLogs: true, includeSystemInfo: true })
    )
    expect(feedback.confirm).toHaveBeenCalledWith('stage-1')
    expect(feedback.discard).toHaveBeenCalledWith('stage-1')
    expect(plugins.authorizeCapability).toHaveBeenCalledWith('/plugins/example', 'files.read')
    expect(plugins.start).toHaveBeenCalledWith('example', '/plugins/example')
    expect(plugins.request).toHaveBeenCalledWith('example', 'files.read', 'files/read', {
      path: '/tmp/a',
    })
    expect(plugins.stop).toHaveBeenCalledWith('example')
    expect(plugins.list).toHaveBeenCalledOnce()
    expect(developer.openLogDirectory).toHaveBeenCalledOnce()
    expect(developer.openDevTools).toHaveBeenCalledOnce()
  })
})
