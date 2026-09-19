// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createComposerPluginAssetReader } from './pluginAssetReader'

describe('composer plugin assets', () => {
  it('reads local images from the catalog device and coalesces repeated logos', async () => {
    const read = vi.fn().mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }))
    const resolve = createComposerPluginAssetReader(read, 'device-b')
    const [light, dark] = await Promise.all([
      resolve('/plugins/pdf/icon.svg'),
      resolve('/plugins/pdf/icon.svg'),
    ])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(
      { device_id: 'device-b', workspace_path: '/plugins/pdf', path: 'icon.svg' },
      'image/svg+xml'
    )
    expect(light).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(dark).toBe(light)
    expect(await resolve('https://example.com/logo.png')).toBe('https://example.com/logo.png')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('retries failed device reads and decodes Windows file URLs', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    const resolve = createComposerPluginAssetReader(read, 'windows')
    await expect(resolve('file:///C:/plugins/my%20plugin/icon.png')).rejects.toThrow('offline')
    await expect(resolve('file:///C:/plugins/my%20plugin/icon.png')).resolves.toBe(
      'data:image/png;base64,eA=='
    )
    expect(read).toHaveBeenLastCalledWith(
      { device_id: 'windows', workspace_path: 'C:/plugins/my plugin', path: 'icon.png' },
      'image/png'
    )
  })
})
