import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileDocumentPreview } from './MobileDocumentPreview'
import type { LoadedMobileFile } from '@/types/files'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  inject: vi.fn(),
  release: vi.fn(),
  resource: vi.fn(),
}))
vi.mock('@/services/mobilePreviewRuntime', () => ({ openMobilePreview: mocks.open }))
vi.mock('react-native', () => ({ View: 'View', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  useTheme: () => ({ dark: false, colors: { background: '#fff' } }),
}))
vi.mock('react-native-webview', () => ({
  WebView: ({ ref, ...props }: { ref: React.Ref<unknown> }) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: mocks.inject }))
    return React.createElement('WebView', props)
  },
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const document: LoadedMobileFile = {
  name: 'readme.md',
  path: '/repo/readme.md',
  uri: 'file:///private/cached.md',
  mimeType: 'text/markdown',
  size: 20,
  text: '# Hello',
  kind: 'text',
}
const session = {
  url: 'http://127.0.0.1:5000/nonce/index.html#nonce',
  fileUrl: 'http://127.0.0.1:5000/nonce/document/readme.md',
  nonce: 'nonce',
  bridgeToken: 'bridge-secret',
  release: mocks.release,
  addResource: mocks.resource,
}

describe('native document WebView boundary', () => {
  let renderer: ReactTestRenderer
  let props: React.ComponentProps<typeof MobileDocumentPreview>
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.open.mockResolvedValue(session)
    mocks.release.mockResolvedValue(undefined)
    mocks.resource.mockResolvedValue('http://127.0.0.1:5000/nonce/resources/image.png')
    props = {
      document,
      mode: 'preview',
      search: '',
      wrap: false,
      initialPosition: 0,
      onPositionChange: vi.fn(),
      onModeChange: vi.fn(),
      onOpenLink: vi.fn(),
      onError: vi.fn(),
      onResolveResource: vi
        .fn()
        .mockResolvedValue({ uri: 'file:///cache/image.png', name: 'image.png' }),
    }
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.useRealTimers()
  })
  const view = () => renderer.root.findByType('WebView' as never)
  async function render() {
    await act(() => {
      renderer = create(<MobileDocumentPreview {...props} />)
    })
  }
  async function message(value: unknown) {
    await act(() => view().props.onMessage({ nativeEvent: { data: JSON.stringify(value) } }))
  }

  it('does not restart the server for search, reading position, or explicit line navigation', async () => {
    await render()
    await message({ type: 'ready', token: 'bridge-secret' })
    expect(mocks.inject.mock.calls[0]?.[0]).not.toContain('/private/cached.md')
    props = {
      ...props,
      document: { ...document, lineStart: 45 },
      search: 'hello',
      initialPosition: 300,
    }
    await act(() => renderer.update(<MobileDocumentPreview {...props} />))
    expect(mocks.open).toHaveBeenCalledOnce()
    expect(mocks.release).not.toHaveBeenCalled()
    expect(mocks.inject.mock.lastCall?.[0]).toContain('"lineStart":45')
  })
  it('releases the old server when changing the actual cached file', async () => {
    await render()
    props = { ...props, document: { ...document, uri: 'file:///private/new.md' } }
    await act(() => renderer.update(<MobileDocumentPreview {...props} />))
    expect(mocks.open).toHaveBeenCalledTimes(2)
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it('accepts only trusted display-mode controls supported by the current document', async () => {
    await render()
    await message({ type: 'mode', token: 'wrong', mode: 'source' })
    await message({ type: 'mode', token: 'bridge-secret', mode: 'edit' })
    expect(props.onModeChange).not.toHaveBeenCalled()
    await message({ type: 'mode', token: 'bridge-secret', mode: 'source' })
    expect(props.onModeChange).toHaveBeenCalledExactlyOnceWith('source')
    expect(mocks.open).toHaveBeenCalledOnce()
    props = { ...props, document: { ...document, name: 'report.pdf', kind: 'binary' } }
    await act(() => renderer.update(<MobileDocumentPreview {...props} />))
    await message({ type: 'mode', token: 'bridge-secret', mode: 'source' })
    expect(props.onModeChange).toHaveBeenCalledOnce()
  })
  it('gates every top-level navigation and disables native file access', async () => {
    await render()
    const webview = view()
    expect(webview.props.originWhitelist).toEqual(['*'])
    expect(webview.props.allowFileAccess).toBe(false)
    expect(webview.props.allowUniversalAccessFromFileURLs).toBe(false)
    const navigate = webview.props.onShouldStartLoadWithRequest
    expect(navigate({ url: session.url, isTopFrame: true })).toBe(true)
    expect(navigate({ url: 'https://example.test/doc', isTopFrame: true })).toBe(false)
    expect(props.onOpenLink).toHaveBeenCalledWith('https://example.test/doc')
    expect(navigate({ url: 'file:///private/auth', isTopFrame: true })).toBe(false)
    expect(props.onOpenLink).toHaveBeenCalledWith('file:///private/auth')
    expect(navigate({ url: 'javascript:alert(1)', isTopFrame: true })).toBe(false)
    expect(props.onOpenLink).toHaveBeenCalledTimes(2)
    expect(navigate({ url: 'about:srcdoc', isTopFrame: false })).toBe(true)
  })
  it('resolves Markdown resources without giving native paths to the browser', async () => {
    await render()
    await message({ type: 'resource', token: 'wrong', id: '0', href: 'image.png' })
    expect(props.onResolveResource).not.toHaveBeenCalled()
    await message({ type: 'resource', token: 'nonce', id: 'forged', href: '/private/auth' })
    expect(props.onResolveResource).not.toHaveBeenCalled()
    await message({ type: 'resource', token: 'bridge-secret', id: '1', href: '../image.png' })
    expect(props.onResolveResource).toHaveBeenCalledWith('../image.png')
    expect(mocks.resource).toHaveBeenCalledWith({
      uri: 'file:///cache/image.png',
      name: 'image.png',
    })
    expect(mocks.inject.mock.lastCall?.[0]).toContain('/nonce/resources/image.png')
    expect(mocks.inject.mock.lastCall?.[0]).not.toContain('file:///cache')
    props = { ...props, document: { ...document, name: 'untrusted.html' } }
    await act(() => renderer.update(<MobileDocumentPreview {...props} />))
    await message({ type: 'resource', token: 'bridge-secret', id: '2', href: '../secret' })
    expect(props.onResolveResource).toHaveBeenCalledOnce()
  })
  it.each(['copy failed', '文件预览已关闭'])(
    'releases the resource lease after %s',
    async reason => {
      const release = vi.fn()
      const resource = { uri: 'file:///cache/image.png', name: 'image.png', release }
      props.onResolveResource = vi.fn().mockResolvedValue(resource)
      mocks.resource.mockRejectedValueOnce(new Error(reason))
      await render()
      await message({ type: 'resource', token: 'bridge-secret', id: '1', href: 'image.png' })
      expect(release).toHaveBeenCalledOnce()
      expect(mocks.inject.mock.lastCall?.[0]).toContain(reason)
    }
  )
  it('reports real process termination and bridge errors to the native error state', async () => {
    await render()
    view().props.onContentProcessDidTerminate()
    expect(props.onError).toHaveBeenCalledWith('文件预览已被系统关闭，请重新打开')
    await message({ type: 'error', token: 'bridge-secret', message: 'Parser failed' })
    expect(props.onError).toHaveBeenCalledWith('Parser failed')
  })
  it('reports a failed top page and a bounded startup timeout without declaring success', async () => {
    vi.useFakeTimers()
    await render()
    view().props.onHttpError({ nativeEvent: { url: session.url, statusCode: 404 } })
    expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('HTTP 404'))
    await act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('加载超时'))
    expect(mocks.inject).not.toHaveBeenCalled()
  })
  it('clears the startup timeout when the trusted renderer becomes ready', async () => {
    vi.useFakeTimers()
    await render()
    await message({ type: 'ready', token: 'bridge-secret' })
    await act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(props.onError).not.toHaveBeenCalled()
  })
})
