import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import {
  VNC_ASSETS,
  createVncAssetsMiddleware,
  createVncAssetsPlugin,
  matchVncAsset,
} from './viteAssets.mjs'

const assetsDirectory = resolve(import.meta.dirname, 'assets')
const pluginModulePath = resolve(import.meta.dirname, 'viteAssets.mjs')

type VncAssetsMiddleware = ReturnType<typeof createVncAssetsMiddleware>

function request(url: string): Parameters<VncAssetsMiddleware>[0] {
  return { url } as Parameters<VncAssetsMiddleware>[0]
}

function response() {
  const setHeader = vi.fn()
  const end = vi.fn()

  return {
    end,
    setHeader,
    value: { end, setHeader } as unknown as Parameters<VncAssetsMiddleware>[1],
  }
}

function emitBuildAssets(plugin: ReturnType<typeof createVncAssetsPlugin>) {
  if (typeof plugin.generateBundle !== 'function') {
    throw new Error('Expected the VNC assets plugin to define generateBundle')
  }

  const emitFile = vi.fn<(asset: unknown) => string>().mockReturnValue('asset-reference')
  const addWatchFile = vi.fn<(path: string) => void>()
  const generateBundle = plugin.generateBundle as unknown as (this: {
    addWatchFile: typeof addWatchFile
    emitFile: typeof emitFile
  }) => void
  generateBundle.call({ addWatchFile, emitFile })
  return { addWatchFile, emitFile }
}

function configureDevServer(plugin: ReturnType<typeof createVncAssetsPlugin>, server: unknown) {
  if (typeof plugin.configureServer !== 'function') {
    throw new Error('Expected the VNC assets plugin to define configureServer')
  }

  const configureServer = plugin.configureServer as unknown as (server: unknown) => void
  configureServer(server)
}

function closePlugin(plugin: ReturnType<typeof createVncAssetsPlugin>) {
  if (typeof plugin.closeBundle !== 'function') {
    throw new Error('Expected the VNC assets plugin to define closeBundle')
  }

  const closeBundle = plugin.closeBundle as unknown as () => void
  closeBundle()
}

function devServer(restart: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) {
  type ChangeListener = (path: string) => void | Promise<void>

  const changeListeners = new Set<ChangeListener>()
  const watcher = {
    add: vi.fn(),
    off: vi.fn((event: string, listener: ChangeListener) => {
      if (event === 'change') changeListeners.delete(listener)
    }),
    on: vi.fn((event: string, listener: ChangeListener) => {
      if (event === 'change') changeListeners.add(listener)
    }),
  }
  const server = {
    config: { logger: { error: vi.fn() } },
    middlewares: { use: vi.fn() },
    restart,
    watcher,
  }

  return {
    emitChange: (path: string) =>
      Promise.all(Array.from(changeListeners, listener => listener(path))),
    logger: server.config.logger,
    restart,
    server,
    watcher,
  }
}

describe('matchVncAsset', () => {
  test.each([
    ['/vnc.html', '/', 'vnc.html'],
    ['/wework/vnc.html', '/wework', 'vnc.html'],
    ['/wework/novnc/rfb.min.js', '/wework/', 'novnc/rfb.min.js'],
  ])('matches %s under the %s base', (url, base, fileName) => {
    expect(matchVncAsset(url, base)?.fileName).toBe(fileName)
  })

  test('matches by URL pathname when a request has a query string', () => {
    expect(matchVncAsset('/wework/vnc.html?sessionId=session-1', 'wework')?.fileName).toBe(
      'vnc.html'
    )
  })

  test('returns null for an unknown path', () => {
    expect(matchVncAsset('/wework/unknown.js', '/wework')).toBeNull()
    expect(matchVncAsset('/outside/vnc.html', '/wework')).toBeNull()
  })
})

describe('VNC asset definitions', () => {
  test('keeps stable build output names and explicit MIME types', () => {
    expect(VNC_ASSETS).toEqual([
      {
        fileName: 'vnc.html',
        mime: 'text/html; charset=utf-8',
      },
      {
        fileName: 'novnc/rfb.min.js',
        mime: 'text/javascript; charset=utf-8',
      },
    ])
    expect(createVncAssetsPlugin().name).toBe('wework-vnc-assets')
  })

  test('emits both sources at their exact stable build paths', () => {
    const { addWatchFile, emitFile } = emitBuildAssets(createVncAssetsPlugin(assetsDirectory))
    const emittedAssets = emitFile.mock.calls.map(
      ([asset]) => asset as { fileName: string; source: Uint8Array; type: string }
    )

    expect(addWatchFile.mock.calls.map(([path]) => path)).toEqual([
      resolve(assetsDirectory, 'vnc.html'),
      resolve(assetsDirectory, 'novnc/rfb.min.js'),
    ])
    expect(emittedAssets.map(({ fileName, type }) => ({ fileName, type }))).toEqual([
      { fileName: 'vnc.html', type: 'asset' },
      { fileName: 'novnc/rfb.min.js', type: 'asset' },
    ])
    expect(emittedAssets[0].source).toEqual(readFileSync(resolve(assetsDirectory, 'vnc.html')))
    expect(emittedAssets[1].source).toEqual(
      readFileSync(resolve(assetsDirectory, 'novnc/rfb.min.js'))
    )
  })

  test('fails build emission when a source file is missing', () => {
    expect(() =>
      emitBuildAssets(createVncAssetsPlugin(resolve(assetsDirectory, 'missing-directory')))
    ).toThrow(/ENOENT/)
  })

  test('keeps the HTML import relative and the full noVNC bundle feature-local', () => {
    const html = readFileSync(resolve(assetsDirectory, 'vnc.html'), 'utf8')
    const noVncBundle = readFileSync(resolve(assetsDirectory, 'novnc/rfb.min.js'))

    expect(html).toContain('<script src="./novnc/rfb.min.js"></script>')
    expect(noVncBundle.byteLength).toBeGreaterThan(300_000)
  })
})

describe('createVncAssetsMiddleware', () => {
  test('serves a matching asset with its explicit MIME type', () => {
    const middleware = createVncAssetsMiddleware('/wework', assetsDirectory)
    const next = vi.fn()
    const res = response()

    middleware(request('/wework/vnc.html'), res.value, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8')
    expect(res.end).toHaveBeenCalledWith(readFileSync(resolve(assetsDirectory, 'vnc.html')))
  })

  test('calls next for an unknown path', () => {
    const middleware = createVncAssetsMiddleware('/wework', assetsDirectory)
    const next = vi.fn()
    const res = response()

    middleware(request('/wework/unknown.js'), res.value, next)

    expect(next).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith()
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  test('passes a matching source read error to next', () => {
    const middleware = createVncAssetsMiddleware('/', resolve(assetsDirectory, 'missing-directory'))
    const next = vi.fn()
    const res = response()

    middleware(request('/vnc.html'), res.value, next)

    expect(next).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })
})

describe('VNC plugin module watching', () => {
  test('restarts once when the native plugin module changes', async () => {
    let finishRestart: (() => void) | undefined
    const restart = vi.fn(
      () =>
        new Promise<void>(resolveRestart => {
          finishRestart = resolveRestart
        })
    )
    const dev = devServer(restart)
    const plugin = createVncAssetsPlugin(assetsDirectory, pluginModulePath)
    configureDevServer(plugin, dev.server)

    expect(dev.watcher.add).toHaveBeenCalledWith(pluginModulePath)
    await dev.emitChange(resolve(import.meta.dirname, 'unrelated.mjs'))
    expect(restart).not.toHaveBeenCalled()

    const firstRestart = dev.emitChange(pluginModulePath)
    const duplicateChange = dev.emitChange(pluginModulePath)
    expect(restart).toHaveBeenCalledOnce()
    finishRestart?.()
    await Promise.all([firstRestart, duplicateChange])
  })

  test('removes its change listener through the closeBundle lifecycle', async () => {
    const dev = devServer()
    const plugin = createVncAssetsPlugin(assetsDirectory, pluginModulePath)
    configureDevServer(plugin, dev.server)

    closePlugin(plugin)
    await dev.emitChange(pluginModulePath)

    expect(dev.watcher.off).toHaveBeenCalledWith('change', expect.any(Function))
    expect(dev.restart).not.toHaveBeenCalled()
  })

  test('rearms the watcher after a restart rejects', async () => {
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined)
    const dev = devServer(restart)
    const plugin = createVncAssetsPlugin(assetsDirectory, pluginModulePath)
    configureDevServer(plugin, dev.server)

    await dev.emitChange(pluginModulePath)
    await dev.emitChange(pluginModulePath)

    expect(restart).toHaveBeenCalledTimes(2)
    expect(dev.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('restart failed'),
      expect.objectContaining({ error: expect.any(Error) })
    )
  })
})
