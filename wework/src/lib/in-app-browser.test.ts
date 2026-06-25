import { invoke } from '@tauri-apps/api/core'
import { Webview } from '@tauri-apps/api/webview'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createNativeInAppBrowser, normalizeBrowserUrl } from './in-app-browser'

const webviewMock = vi.hoisted(() => ({
  close: vi.fn(),
  hide: vi.fn(),
  setFocus: vi.fn(),
  setPosition: vi.fn(),
  setSize: vi.fn(),
  show: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  Webview: {
    getByLabel: vi.fn(),
  },
}))

const invokeMock = vi.mocked(invoke)
const getByLabelMock = vi.mocked(Webview.getByLabel)

describe('in-app browser helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue(undefined)
    getByLabelMock.mockResolvedValue(webviewMock as never)
  })

  test('normalizes supported browser URLs', () => {
    expect(normalizeBrowserUrl('weibo.com')).toBe('https://weibo.com/')
    expect(normalizeBrowserUrl('https://weibo.com/mygroups?gid=1')).toBe(
      'https://weibo.com/mygroups?gid=1'
    )
    expect(normalizeBrowserUrl('ftp://example.com')).toBeNull()
  })

  test('resizes native webviews through the single native frame command', async () => {
    const initialRect = { x: 10, y: 20, width: 300, height: 400 }
    const nextRect = { x: 12, y: 22, width: 320, height: 420 }

    const browser = await createNativeInAppBrowser(
      'wegent-workspace-browser',
      'https://weibo.com/',
      initialRect
    )
    await browser.setFrame(nextRect)

    expect(invokeMock).toHaveBeenCalledWith('in_app_browser_create', {
      label: 'wegent-workspace-browser',
      url: 'https://weibo.com/',
      rect: initialRect,
    })
    expect(invokeMock).toHaveBeenCalledWith('in_app_browser_set_frame', {
      label: 'wegent-workspace-browser',
      rect: nextRect,
    })
    expect(webviewMock.setPosition).not.toHaveBeenCalled()
    expect(webviewMock.setSize).not.toHaveBeenCalled()
  })
})
