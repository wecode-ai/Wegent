import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildVncPageUrl, isInternalVncPageUrl, prepareVncSession } from './session'

const invokeMock = vi.hoisted(() => vi.fn())
const vncHtml = readFileSync(resolve(process.cwd(), 'wecode/features/vnc/assets/vnc.html'), 'utf8')
const vncInlineScript = Array.from(vncHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
  .map(match => match[1])
  .find(script => script.includes('authenticatedWebSocketUrl'))

class RfbMock {
  static instances: RfbMock[] = []

  readonly disconnect = vi.fn()
  readonly url: string
  private readonly listeners = new Map<string, Array<(event: { detail?: unknown }) => void>>()

  constructor(_container: HTMLElement, url: string) {
    this.url = url
    RfbMock.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { detail?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, detail?: unknown) {
    this.listeners.get(type)?.forEach(listener => listener({ detail }))
  }
}

function runVncPage(invoke?: ReturnType<typeof vi.fn>) {
  expect(vncInlineScript).toBeDefined()
  document.body.innerHTML = `
    <div id="vnc-container"></div>
    <div id="status-overlay">
      <div class="status-text"><div class="spinner"></div><p>正在连接云桌面...</p></div>
    </div>
  `
  window.history.replaceState(
    {},
    '',
    '/vnc.html?sessionId=123e4567-e89b-42d3-a456-426614174000&sandboxId=sandbox-1'
  )
  Object.defineProperty(window, 'noVNC', {
    configurable: true,
    value: RfbMock,
  })
  if (invoke) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    })
  }
  window.eval(vncInlineScript!)
}

function stubSessionFetch(
  config = {
    wsUrl: 'wss://cloud.example.com/vnc-proxy/device-1',
    token: 'cloud-token',
  }
) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve(config),
    ok: true,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: invokeMock }))

describe('buildVncPageUrl', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(command => {
      if (command === 'vnc.externalBridgeUrl') {
        return Promise.resolve('http://127.0.0.1:43123')
      }
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    localStorage.clear()
    window.__WEWORK_RUNTIME_CONFIG__ = undefined
    RfbMock.instances = []
    document.body.replaceChildren()
    document.documentElement.removeAttribute('data-vnc-connected')
    document.title = ''
    window.history.replaceState({}, '', '/')
    Reflect.deleteProperty(window, 'noVNC')
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    vi.unstubAllGlobals()
  })

  test('keeps the VNC page local without putting credentials in its URL', async () => {
    const sessionId = await prepareVncSession({
      deviceId: 'device/1',
      socketBaseUrl: 'https://cloud.example.com/wework/',
      token: 'cloud token',
    })
    const url = await buildVncPageUrl({
      sandboxId: 'sandbox-1',
      sessionId,
    })
    const parsedUrl = new URL(url)

    expect(invokeMock).toHaveBeenCalledWith('vnc.prepareSession', {
      sessionId,
      token: 'cloud token',
      wsUrl: 'wss://cloud.example.com/wework/vnc-proxy/device%2F1',
    })
    expect(parsedUrl.origin).toBe('http://127.0.0.1:43123')
    expect(parsedUrl.pathname).toBe('/vnc.html')
    expect(parsedUrl.searchParams.get('sandboxId')).toBe('sandbox-1')
    expect(parsedUrl.searchParams.get('sessionId')).toBe(sessionId)
    expect(parsedUrl.toString()).not.toContain('cloud%20token')
    expect(parsedUrl.searchParams.has('wsUrl')).toBe(false)
    expect(isInternalVncPageUrl(parsedUrl.toString())).toBe(true)
    expect(isInternalVncPageUrl('https://cloud.example.com/wework/vnc.html')).toBe(false)
  })

  test('builds one credential-free loopback URL for either browser target', async () => {
    const url = await buildVncPageUrl({
      sandboxId: 'sandbox/1',
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
    })
    const parsedUrl = new URL(url)

    expect(invokeMock).toHaveBeenCalledWith('vnc.externalBridgeUrl')
    expect(parsedUrl.origin).toBe('http://127.0.0.1:43123')
    expect(parsedUrl.pathname).toBe('/vnc.html')
    expect(parsedUrl.searchParams.get('sessionId')).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(parsedUrl.searchParams.get('sandboxId')).toBe('sandbox/1')
    expect(parsedUrl.searchParams.has('token')).toBe(false)
    expect(parsedUrl.searchParams.has('wsUrl')).toBe(false)
  })

  test.each([
    'http://localhost:43123/vnc.html?sessionId=session-1&sandboxId=sandbox-1',
    'http://127.0.0.1/vnc.html?sessionId=session-1&sandboxId=sandbox-1',
    'http://127.0.0.1:43123/other.html?sessionId=session-1&sandboxId=sandbox-1',
    'http://127.0.0.1:43123/vnc.html?sandboxId=sandbox-1',
    'http://127.0.0.1:43123/vnc.html?sessionId=session-1',
    'http://127.0.0.1:43123/vnc.html?sessionId=session-1&sandboxId=sandbox-1#fragment',
  ])('does not classify a non-viewer loopback page as the internal desktop: %s', value => {
    expect(isInternalVncPageUrl(value)).toBe(false)
  })

  test.each([
    ['http://127.0.0.1:8000', 'ws://127.0.0.1:8000/vnc-proxy/device-1'],
    ['https://cloud.example.com', 'wss://cloud.example.com/vnc-proxy/device-1'],
    ['ws://127.0.0.1:8000', 'ws://127.0.0.1:8000/vnc-proxy/device-1'],
    ['wss://cloud.example.com', 'wss://cloud.example.com/vnc-proxy/device-1'],
  ])('maps the %s cloud connection to a secure WebSocket URL', async (socketBaseUrl, wsUrl) => {
    const sessionId = await prepareVncSession({
      deviceId: 'device-1',
      socketBaseUrl,
      token: 'token',
    })

    expect(invokeMock).toHaveBeenLastCalledWith('vnc.prepareSession', {
      sessionId,
      token: 'token',
      wsUrl,
    })
  })

  test('rejects unsupported cloud connection protocols', async () => {
    await expect(
      prepareVncSession({
        deviceId: 'device-1',
        socketBaseUrl: 'ftp://cloud.example.com',
        token: 'token',
      })
    ).rejects.toThrow('Unsupported VNC socket protocol')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('loads noVNC relative to the VNC page base path', () => {
    expect(vncHtml).toContain('<script src="./novnc/rfb.min.js"></script>')
    expect(vncHtml).not.toContain('<script src="/novnc/rfb.min.js"></script>')
    expect(vncHtml).toContain("fetch('/session/' + encodeURIComponent(sessionId)")
    expect(vncHtml).not.toContain('get_vnc_session_config')
    expect(vncHtml).not.toContain("params.get('wsUrl')")
    expect(vncHtml).toContain("retryButton.addEventListener('click', connect)")
    expect(vncHtml).toContain('scheduleReconnect()')
    expect(vncHtml).toContain("document.documentElement.dataset.vncConnected = 'true'")
    expect(vncHtml).toContain('云桌面会话已过期，请关闭后重新打开桌面')
    expect(vncHtml).not.toContain('window.location.reload()')
  })

  test('reconnects with the in-memory WebSocket URL without rereading the HTTP handoff', async () => {
    const fetchMock = stubSessionFetch()
    runVncPage()

    await vi.waitFor(() => expect(RfbMock.instances).toHaveLength(1))
    const firstRfb = RfbMock.instances[0]
    expect(firstRfb.url).toBe('wss://cloud.example.com/vnc-proxy/device-1?token=cloud-token')
    firstRfb.emit('connect')
    expect(document.documentElement.dataset.vncConnected).toBe('true')
    expect(document.title).toBe('云桌面 - sandbox-1')

    firstRfb.emit('disconnect', { clean: false })
    expect(document.documentElement.dataset.vncConnected).toBeUndefined()
    const retryButton = document.querySelector<HTMLButtonElement>('.retry-btn')
    expect(retryButton).not.toBeNull()
    retryButton!.click()

    await vi.waitFor(() => expect(RfbMock.instances).toHaveLength(2))
    expect(firstRfb.disconnect).toHaveBeenCalledTimes(1)
    expect(RfbMock.instances[1].url).toBe(firstRfb.url)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('automatically reconnects after a transient upstream disconnect', async () => {
    vi.useFakeTimers()
    const fetchMock = stubSessionFetch()

    try {
      runVncPage()
      await vi.waitFor(() => expect(RfbMock.instances).toHaveLength(1))

      RfbMock.instances[0].emit('disconnect', { clean: false })
      expect(document.querySelector('.error')?.textContent).toBe('连接已断开，正在重试...')

      await vi.advanceTimersByTimeAsync(1000)
      expect(RfbMock.instances).toHaveLength(2)
      expect(RfbMock.instances[1].url).toBe(RfbMock.instances[0].url)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('loads the session from the loopback bridge when Tauri internals are present', async () => {
    const fetchMock = stubSessionFetch()
    const pageInvoke = vi.fn().mockRejectedValue('Remote IPC is not allowed')

    runVncPage(pageInvoke)

    await vi.waitFor(() => expect(RfbMock.instances).toHaveLength(1))
    expect(pageInvoke).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith('/session/123e4567-e89b-42d3-a456-426614174000', {
      cache: 'no-store',
      credentials: 'omit',
    })
    expect(RfbMock.instances[0].url).toBe(
      'wss://cloud.example.com/vnc-proxy/device-1?token=cloud-token'
    )
  })

  test('explains that an expired reload must be reopened without offering a broken retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ error: 'VNC session is missing or expired' }),
      ok: false,
    })
    vi.stubGlobal('fetch', fetchMock)
    runVncPage()

    await vi.waitFor(() => {
      expect(document.querySelector('.status-text')).toHaveTextContent(
        '云桌面会话已过期，请关闭后重新打开桌面'
      )
    })
    expect(RfbMock.instances).toHaveLength(0)
    expect(document.querySelector('.retry-btn')).toBeNull()
  })
})
