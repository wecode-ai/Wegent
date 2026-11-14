import { describe, expect, it, vi } from 'vitest'
import {
  canPreviewSource,
  canSearchPreview,
  isPreviewLinkAllowed,
  parsePreviewEvent,
} from './protocol'
import { createPreviewResourceBridge } from './resourceBridge'

describe('preview bridge boundaries', () => {
  it('offers source and search only for renderer capabilities that support them', () => {
    const binary = (name: string, mimeType = '') => ({ kind: 'binary' as const, name, mimeType })
    expect(canPreviewSource(binary('diagram.puml'))).toBe(true)
    expect(canSearchPreview(binary('diagram.puml'), 'source')).toBe(true)
    expect(canSearchPreview(binary('diagram.puml'))).toBe(false)
    expect(canPreviewSource(binary('report.pdf'))).toBe(false)
    for (const name of ['report.pdf', 'report.docx', 'table.xlsx', 'tree.xmind'])
      expect(canSearchPreview(binary(name))).toBe(true)
    for (const name of ['image.png', 'video.mp4', 'archive.zip'])
      expect(canSearchPreview(binary(name))).toBe(false)
    expect(canSearchPreview(binary('download', 'application/pdf'))).toBe(true)
  })
  it('requires the current private native token and validates message payloads', () => {
    expect(parsePreviewEvent('{', 'secret')).toBeNull()
    expect(parsePreviewEvent(JSON.stringify({ type: 'ready', token: 'old' }), 'secret')).toBeNull()
    expect(
      parsePreviewEvent(
        JSON.stringify({ type: 'position', token: 'secret', value: '12' }),
        'secret'
      )
    ).toBeNull()
    expect(
      parsePreviewEvent(JSON.stringify({ type: 'position', token: 'secret', value: -2 }), 'secret')
    ).toEqual({ type: 'position', value: 0 })
    expect(
      parsePreviewEvent(
        JSON.stringify({ type: 'resource', token: 'secret', id: '1', href: 'javascript:alert(1)' }),
        'secret'
      )
    ).toBeNull()
  })
  it.each([
    'javascript:alert(1)',
    'data:text/html,test',
    '\nhttps://example.test',
    'https:\n//example.test',
    'intent://test',
  ])('rejects active or malformed navigation %s', href => {
    expect(isPreviewLinkAllowed(href)).toBe(false)
  })
  it.each([
    'https://example.test',
    'mailto:hello@example.test',
    '../src/main.ts#L4',
    '/repo/a.md',
    'file:///repo/a.md',
    'C:\\repo\\a.md',
  ])('routes allowed navigation %s through native', href => {
    expect(isPreviewLinkAllowed(href)).toBe(true)
  })
  it('rejects a sandboxed iframe forging a resource request with the public URL nonce', () => {
    expect(
      parsePreviewEvent(
        JSON.stringify({
          type: 'resource',
          token: 'public-url-nonce',
          href: '/private/auth',
          id: '1',
        }),
        'private-bridge-token'
      )
    ).toBeNull()
  })
  it('resolves workspace images only through the token-bound native channel', async () => {
    const target = new EventTarget()
    const post = vi.fn()
    const bridge = createPreviewResourceBridge('secret', post, target)
    const pending = bridge.resolve('../image.png')
    expect(post).toHaveBeenCalledWith({ type: 'resource', id: '1', href: '../image.png' })
    const send = (detail: unknown) =>
      target.dispatchEvent(new CustomEvent('wework-preview-resource', { detail }))
    send({ token: 'old', id: '1', url: 'http://127.0.0.1:5000/old' })
    send({ token: 'secret', id: '1', url: 'http://127.0.0.1:5000/secret/resources/image.png' })
    await expect(pending).resolves.toBe('http://127.0.0.1:5000/secret/resources/image.png')
    await expect(bridge.resolve('https://example.test/image.png')).resolves.toBe(
      'https://example.test/image.png'
    )
    expect(post).toHaveBeenCalledTimes(1)
    bridge.dispose()
  })
  it('rejects unsafe native resource responses and releases outstanding requests', async () => {
    const target = new EventTarget()
    const bridge = createPreviewResourceBridge('secret', vi.fn(), target)
    const first = bridge.resolve('/repo/a.png')
    const firstAssertion = expect(first).rejects.toThrow('地址无效')
    target.dispatchEvent(
      new CustomEvent('wework-preview-resource', {
        detail: { token: 'secret', id: '1', url: 'file:///private/token' },
      })
    )
    await firstAssertion
    const pending = bridge.resolve('b.png')
    const assertion = expect(pending).rejects.toThrow('已关闭')
    bridge.dispose()
    await assertion
    await expect(bridge.resolve('c.png')).rejects.toThrow('已关闭')
  })
  it.each(['/api/attachments/12/download', 'https://backend.example/api/attachments/12/download'])(
    'routes authenticated image %s through the native owner',
    async href => {
      const target = new EventTarget()
      const post = vi.fn()
      const bridge = createPreviewResourceBridge('secret', post, target)
      const pending = bridge.resolve(href)
      expect(post).toHaveBeenCalledWith({ type: 'resource', id: '1', href })
      target.dispatchEvent(
        new CustomEvent('wework-preview-resource', {
          detail: { token: 'secret', id: '1', url: 'http://127.0.0.1:5000/secret/attachment.png' },
        })
      )
      await expect(pending).resolves.toBe('http://127.0.0.1:5000/secret/attachment.png')
      bridge.dispose()
    }
  )
})
