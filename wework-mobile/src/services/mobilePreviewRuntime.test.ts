import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadedMobileFile } from '@/types/files'

const native = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  paths: new Set<string>(),
  copies: [] as [string, string][],
  removed: [] as string[],
  events: [] as string[],
  configs: [] as Record<string, unknown>[],
  uuid: 0,
  start: vi.fn(),
  stop: vi.fn(),
  copyAssets: vi.fn(),
  version: 'a'.repeat(64),
  directories: [] as { name: string; path: string; isDirectory: () => boolean }[],
  stat: vi.fn(),
  written: new Map<string, string>(),
}))
vi.mock('react-native', () => ({ Platform: native.platform }))
vi.mock('expo-crypto', () => ({ randomUUID: () => `nonce-${++native.uuid}` }))
vi.mock('@dr.pogodin/react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  MainBundlePath: '/bundle',
  exists: async (path: string) =>
    native.paths.has(path) || [...native.paths].some(value => value.startsWith(`${path}/`)),
  mkdir: async (path: string) => {
    native.paths.add(path)
  },
  writeFile: async (path: string, value: string) => {
    native.paths.add(path)
    native.written.set(path, value)
  },
  unlink: async (path: string) => {
    native.removed.push(path)
    for (const value of native.paths)
      if (value === path || value.startsWith(`${path}/`)) native.paths.delete(value)
  },
  copyFile: async (from: string, to: string) => {
    native.copies.push([from, to])
    native.paths.add(to)
  },
  readFile: async (path: string) =>
    path.endsWith('index.html')
      ? '<html><head></head><body></body></html>'
      : JSON.stringify({ version: native.version, files: [{ path: 'index.html', size: 5 }] }),
  readFileAssets: async () =>
    JSON.stringify({ version: native.version, files: [{ path: 'index.html', size: 5 }] }),
  copyFileAssets: async (...args: unknown[]) => {
    await native.copyAssets(...args)
    native.paths.add(`${args[1]}/index.html`)
  },
  readDir: async () => native.directories,
  stat: (...args: unknown[]) => native.stat(...args),
}))
vi.mock('@dr.pogodin/react-native-static-server', () => ({
  default: class {
    id: number
    constructor(config: Record<string, unknown>) {
      this.id = native.configs.push(config)
      native.events.push(`create:${this.id}`)
    }
    async start() {
      native.events.push(`start:${this.id}`)
      return await native.start()
    }
    async stop() {
      native.events.push(`stop:${this.id}`)
      await native.stop()
    }
  },
}))
const document: LoadedMobileFile = {
  name: 'a b.pdf',
  path: '/remote/a b.pdf',
  mimeType: 'application/pdf',
  size: 5,
  uri: 'file:///cache/download/a%20b.pdf',
  kind: 'binary',
}

beforeEach(() => {
  vi.resetModules()
  native.platform.OS = 'ios'
  native.paths.clear()
  native.paths.add('/bundle/wework-preview/index.html')
  native.copies.length = 0
  native.removed.length = 0
  native.events.length = 0
  native.configs.length = 0
  native.directories.length = 0
  native.uuid = 0
  native.written.clear()
  native.version = 'a'.repeat(64)
  native.start.mockReset().mockResolvedValue('http://127.0.0.1:5500')
  native.stop.mockReset().mockResolvedValue(undefined)
  native.copyAssets.mockReset().mockResolvedValue(undefined)
  native.stat.mockReset().mockResolvedValue({ size: 5, isFile: () => true })
})

describe('mobile preview server lifecycle', () => {
  it('does not create a second server when the previous owner fails to stop', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    const first = await openMobilePreview(document)
    native.stop.mockRejectedValueOnce(new Error('Native stop failed'))
    await expect(openMobilePreview(document)).rejects.toThrow('资源清理失败')
    expect(native.configs).toHaveLength(1)
    await expect(first.addResource({ uri: '/cache/a.png', name: 'a.png' })).rejects.toThrow(
      '已关闭'
    )
    const second = await openMobilePreview(document)
    expect(native.configs).toHaveLength(2)
    await second.release()
  })
  it('fails before starting WebView when bundled assets are missing or truncated', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    native.paths.delete('/bundle/wework-preview/index.html')
    await expect(openMobilePreview(document)).rejects.toThrow('资源缺失')
    native.paths.add('/bundle/wework-preview/index.html')
    native.stat.mockResolvedValueOnce({ size: 1, isFile: () => true })
    await expect(openMobilePreview(document)).rejects.toThrow('资源损坏')
    expect(native.configs).toEqual([])
    const session = await openMobilePreview(document)
    await session.release()
  })
  it('serves an isolated selected-file directory with local worker and WASM aliases', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    const session = await openMobilePreview(document)
    expect(session.fileUrl).toBe('http://127.0.0.1:5500/nonce-1/document/a%20b.pdf')
    expect(session.bridgeToken).toBe('nonce-2')
    expect(session.url).not.toContain(session.bridgeToken)
    expect(
      native.written.get('/cache/wework-preview/sessions/nonce-1/nonce-1/index.html')
    ).toContain('if(window===window.top){window.__WEWORK_PREVIEW_TOKEN__="nonce-2"}')
    expect(native.copies).toContainEqual([
      '/cache/download/a b.pdf',
      '/cache/wework-preview/sessions/nonce-1/nonce-1/document/a b.pdf',
    ])
    expect(native.configs[0]).toMatchObject({
      fileDir: '/cache/wework-preview/sessions/nonce-1',
      hostname: '127.0.0.1',
      port: 0,
    })
    expect(native.configs[0]?.extraConfig).toContain('application/wasm')
    expect(native.configs[0]?.extraConfig).toContain(
      '"/nonce-1/vendor/" => "/bundle/wework-preview/vendor/"'
    )
    expect(native.configs[0]?.extraConfig).not.toContain('/remote')
    const config = String(native.configs[0]?.extraConfig)
    const untrustedFiles = config.indexOf('$HTTP["url"] =~ "^/nonce-1/(document|resources)/"')
    expect(untrustedFiles).toBeGreaterThan(0)
    expect(config.slice(0, untrustedFiles)).not.toContain('Content-Security-Policy')
    expect(config.slice(untrustedFiles)).toContain('"Content-Security-Policy" => "sandbox"')
    await session.release()
    await session.release()
    expect(native.events.filter(event => event.startsWith('stop'))).toEqual(['stop:1'])
    expect(native.removed).toContain('/cache/wework-preview/sessions/nonce-1')
  })
  it('serializes concurrent opens and stops the previous server before starting another', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    const first = openMobilePreview(document)
    const second = openMobilePreview({ ...document, uri: 'file:///cache/second.pdf' })
    const [a, b] = await Promise.all([first, second])
    expect(native.events).toEqual(['create:1', 'start:1', 'stop:1', 'create:2', 'start:2'])
    await a.release()
    expect(native.events).not.toContain('stop:2')
    await b.release()
  })
  it('cleans a cancelled or failed start and permits a subsequent open', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    const controller = new AbortController()
    native.start.mockImplementationOnce(async () => {
      controller.abort()
      return 'http://127.0.0.1:5500'
    })
    await expect(openMobilePreview(document, controller.signal)).rejects.toThrow('cancelled')
    expect(native.events).toContain('stop:1')
    expect(native.removed).toContain('/cache/wework-preview/sessions/nonce-1')
    native.start.mockRejectedValueOnce(new Error('Port unavailable'))
    await expect(openMobilePreview(document)).rejects.toThrow('Port unavailable')
    const session = await openMobilePreview(document)
    await session.release()
  })
  it('copies resolved resources within the current session and rejects additions after release', async () => {
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    const session = await openMobilePreview(document)
    expect(
      await session.addResource({ uri: 'file:///cache/image.png', name: '../image.png' })
    ).toBe('http://127.0.0.1:5500/nonce-1/resources/nonce-3/.._image.png')
    expect(native.copies.at(-1)).toEqual([
      '/cache/image.png',
      '/cache/wework-preview/sessions/nonce-1/nonce-1/resources/nonce-3/.._image.png',
    ])
    await session.release()
    await expect(
      session.addResource({ uri: 'file:///cache/image.png', name: 'image.png' })
    ).rejects.toThrow('已关闭')
  })
  it('stages Android assets once per version and removes obsolete caches', async () => {
    native.platform.OS = 'android'
    const old = `/cache/wework-preview/assets-${'b'.repeat(64)}`
    native.directories.push({
      name: `assets-${'b'.repeat(64)}`,
      path: old,
      isDirectory: () => true,
    })
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    const a = await openMobilePreview(document)
    const b = await openMobilePreview(document)
    expect(native.copyAssets).toHaveBeenCalledOnce()
    expect(native.copyAssets).toHaveBeenCalledWith(
      'wework-preview',
      `/cache/wework-preview/assets-${native.version}`
    )
    expect(native.removed).toContain(old)
    await a.release()
    await b.release()
  })
  it('does not mark partially copied Android assets ready and retries actual failures', async () => {
    native.platform.OS = 'android'
    native.copyAssets.mockRejectedValueOnce(new Error('Copy failed'))
    const { openMobilePreview } = await import('./mobilePreviewRuntime')
    await expect(openMobilePreview(document)).rejects.toThrow('Copy failed')
    expect(native.paths.has(`/cache/wework-preview/assets-${native.version}/.ready`)).toBe(false)
    const session = await openMobilePreview(document)
    expect(native.copyAssets).toHaveBeenCalledTimes(2)
    await session.release()
  })
})
