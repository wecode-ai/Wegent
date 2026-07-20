import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import {
  VNC_ASSETS,
  createVncAssetsMiddleware,
  createVncAssetsPlugin,
  matchVncAsset,
} from './viteAssets'

const assetsDirectory = resolve(import.meta.dirname, 'assets')

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
  const generateBundle = plugin.generateBundle as unknown as (this: {
    emitFile: typeof emitFile
  }) => void
  generateBundle.call({ emitFile })
  return emitFile
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
    const emitFile = emitBuildAssets(createVncAssetsPlugin(assetsDirectory))
    const emittedAssets = emitFile.mock.calls.map(
      ([asset]) => asset as { fileName: string; source: Uint8Array; type: string }
    )

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
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  test('calls next when a matching source file cannot be read', () => {
    const middleware = createVncAssetsMiddleware('/', resolve(assetsDirectory, 'missing-directory'))
    const next = vi.fn()
    const res = response()

    middleware(request('/vnc.html'), res.value, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })
})
