import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { UserProxyConfig } from '@/api/users'
import { getLocalProxyConfig } from '@/features/model-settings/localProxySettings'
import { ProxySettingsPage } from './ProxySettingsPage'

const context = vi.hoisted(() => ({
  isConnected: true,
  apiBaseUrl: 'https://api.example.test',
  token: 'first',
  user: { id: 7 },
}))
const host = vi.hoisted(() => ({
  factory: vi.fn(),
  effective: vi.fn(),
  proxyUrl: vi.fn(),
  restart: vi.fn(),
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => context,
}))
vi.mock('@/api/http', () => ({ createHttpClient: (options: unknown) => options }))
vi.mock('@/api/users', () => ({ createUserApi: host.factory }))
vi.mock('@/desktop/systemProxy', () => ({
  resolveEffectiveLocalCodexProxy: host.effective,
  resolveLocalCodexProxyUrl: host.proxyUrl,
}))
vi.mock('@/desktop/localExecutor', () => ({ requestLocalExecutor: host.restart }))
function config(mask = 'http://cloud.example.test:8080'): UserProxyConfig {
  return { configured: true, proxy_url_masked: mask, proxy_updated_at: '2026-01-15T12:00:00Z' }
}
function source() {
  return {
    getProxyConfig: vi.fn().mockResolvedValue(config()),
    updateProxyConfig: vi.fn().mockResolvedValue(config('http://saved.example.test:8080')),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
let first: ReturnType<typeof source>, next: ReturnType<typeof source>
beforeEach(() => {
  localStorage.clear()
  context.isConnected = true
  context.token = 'first'
  context.user = { id: 7 }
  first = source()
  next = source()
  host.factory
    .mockReset()
    .mockImplementation((client: { getToken: () => string }) =>
      client.getToken() === 'first' ? first : next
    )
  host.effective.mockReset().mockImplementation(async () => {
    const saved = getLocalProxyConfig()
    return {
      proxyUrl: saved.mode === 'custom' ? saved.proxyUrl : null,
      source: saved.mode === 'custom' ? 'wework' : 'direct',
    }
  })
  host.proxyUrl.mockReset().mockImplementation(async () => {
    const saved = getLocalProxyConfig()
    return saved.mode === 'custom' ? saved.proxyUrl : null
  })
  host.restart.mockReset().mockResolvedValue(undefined)
})
function typeLocal(url: string) {
  fireEvent.click(screen.getByTestId('local-proxy-mode-custom'))
  fireEvent.change(screen.getByTestId('local-proxy-config-url-input'), { target: { value: url } })
}
async function saveLocal(url = 'http://127.0.0.1:7890') {
  typeLocal(url)
  fireEvent.click(screen.getByTestId('local-proxy-config-save-button'))
  await screen.findByTestId('local-proxy-config-restart-codex-button')
}

test('keeps local settings usable while cloud configuration is pending', async () => {
  const pending = deferred<UserProxyConfig>()
  first.getProxyConfig.mockReturnValue(pending.promise)
  render(<ProxySettingsPage />)
  expect(screen.getByTestId('local-proxy-mode-direct')).toBeEnabled()
  fireEvent.click(screen.getByTestId('local-proxy-mode-direct'))
  fireEvent.click(screen.getByTestId('local-proxy-config-save-button'))
  expect(getLocalProxyConfig().mode).toBe('direct')
  expect(host.restart).not.toHaveBeenCalled()
  await act(async () => pending.resolve(config()))
})

test('keeps cloud settings usable while system proxy resolution is pending', async () => {
  const pending = deferred<{ proxyUrl: string | null; source: string }>()
  host.effective.mockReturnValue(pending.promise)
  render(<ProxySettingsPage />)
  await screen.findByText('http://cloud.example.test:8080')
  expect(screen.getByTestId('proxy-config-url-input')).toBeEnabled()
  fireEvent.change(screen.getByTestId('proxy-config-url-input'), {
    target: { value: 'http://remote:8080' },
  })
  fireEvent.click(screen.getByTestId('proxy-config-save-button'))
  await waitFor(() => expect(first.updateProxyConfig).toHaveBeenCalledWith('http://remote:8080'))
  await act(async () => pending.resolve({ proxyUrl: null, source: 'direct' }))
})

test('retains both drafts across ordinary renders and language changes without rereading', async () => {
  const { rerender } = render(<ProxySettingsPage />)
  await screen.findByText('http://cloud.example.test:8080')
  typeLocal('http://local:8080')
  fireEvent.change(screen.getByTestId('proxy-config-url-input'), {
    target: { value: 'http://remote:8080' },
  })
  rerender(<ProxySettingsPage />)
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByTestId('local-proxy-config-url-input')).toHaveValue('http://local:8080')
    expect(screen.getByTestId('proxy-config-url-input')).toHaveValue('http://remote:8080')
    expect(first.getProxyConfig).toHaveBeenCalledTimes(1)
    expect(host.effective).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('isolates old cloud reads after account changes while retaining the local draft', async () => {
  const pending = deferred<UserProxyConfig>()
  first.getProxyConfig.mockReturnValue(pending.promise)
  const { rerender } = render(<ProxySettingsPage />)
  typeLocal('http://local:8080')
  context.token = 'next'
  rerender(<ProxySettingsPage />)
  await screen.findByText('http://cloud.example.test:8080')
  await act(async () => pending.resolve(config('http://old.example.test:8080')))
  expect(screen.queryByText('http://old.example.test:8080')).not.toBeInTheDocument()
  expect(screen.getByTestId('local-proxy-config-url-input')).toHaveValue('http://local:8080')
  expect(host.effective).toHaveBeenCalledTimes(1)
})

test('does not publish an old account save receipt or clear the new cloud draft', async () => {
  const pending = deferred<UserProxyConfig>()
  first.updateProxyConfig.mockReturnValue(pending.promise)
  const { rerender } = render(<ProxySettingsPage />)
  fireEvent.change(screen.getByTestId('proxy-config-url-input'), {
    target: { value: 'http://old:8080' },
  })
  fireEvent.click(screen.getByTestId('proxy-config-save-button'))
  context.token = 'next'
  rerender(<ProxySettingsPage />)
  fireEvent.change(screen.getByTestId('proxy-config-url-input'), {
    target: { value: 'http://new:8080' },
  })
  await act(async () => pending.resolve(config('http://old-saved.example.test:8080')))
  expect(screen.getByTestId('proxy-config-url-input')).toHaveValue('http://new:8080')
  expect(screen.queryByTestId('proxy-config-notice')).not.toBeInTheDocument()
  expect(next.updateProxyConfig).not.toHaveBeenCalled()
})

test('a successful save supersedes a pending older configuration read', async () => {
  const pending = deferred<UserProxyConfig>()
  first.getProxyConfig.mockReturnValue(pending.promise)
  render(<ProxySettingsPage />)
  fireEvent.change(screen.getByTestId('proxy-config-url-input'), {
    target: { value: 'http://fresh:8080' },
  })
  fireEvent.click(screen.getByTestId('proxy-config-save-button'))
  await screen.findByText('http://saved.example.test:8080')
  await act(async () => pending.resolve(config('http://stale.example.test:8080')))
  expect(screen.queryByText('http://stale.example.test:8080')).not.toBeInTheDocument()
})

test('keeps a rejected cloud draft and permits an explicit save retry', async () => {
  first.updateProxyConfig.mockRejectedValueOnce(new Error('Write rejected'))
  render(<ProxySettingsPage />)
  fireEvent.change(screen.getByTestId('proxy-config-url-input'), {
    target: { value: 'http://draft:8080' },
  })
  fireEvent.click(screen.getByTestId('proxy-config-save-button'))
  expect(await screen.findByTestId('proxy-config-error')).toHaveTextContent('Write rejected')
  expect(screen.getByTestId('proxy-config-url-input')).toHaveValue('http://draft:8080')
  fireEvent.click(screen.getByTestId('proxy-config-save-button'))
  await screen.findByTestId('proxy-config-notice')
  expect(screen.getByTestId('proxy-config-url-input')).toHaveValue('')
})

test('does not report a failed cloud read as an unconfigured proxy', async () => {
  first.getProxyConfig.mockRejectedValueOnce(new Error('Cloud unavailable'))
  render(<ProxySettingsPage />)
  await screen.findByTestId('proxy-config-error')
  expect(screen.getByTestId('proxy-config-status')).not.toHaveTextContent('未配置')
  expect(screen.getByTestId('local-proxy-config-save-button')).toBeEnabled()
})

test('retains invalid local input without changing saved settings or restarting', async () => {
  render(<ProxySettingsPage />)
  typeLocal('not-a-proxy-url')
  fireEvent.click(screen.getByTestId('local-proxy-config-save-button'))
  expect(screen.getByTestId('local-proxy-config-error')).toBeInTheDocument()
  expect(screen.getByTestId('local-proxy-config-url-input')).toHaveValue('not-a-proxy-url')
  expect(getLocalProxyConfig().mode).toBe('system')
  expect(host.restart).not.toHaveBeenCalled()
})

test('retries system resolution without saving settings or restarting the runtime', async () => {
  host.effective.mockRejectedValueOnce(new Error('System proxy unavailable'))
  render(<ProxySettingsPage />)
  await screen.findByTestId('local-proxy-config-error')
  fireEvent.click(screen.getByTestId('local-proxy-config-retry-resolution'))
  await waitFor(() =>
    expect(screen.queryByTestId('local-proxy-config-error')).not.toBeInTheDocument()
  )
  expect(host.effective).toHaveBeenCalledTimes(2)
  expect(getLocalProxyConfig().updatedAt).toBeNull()
  expect(host.restart).not.toHaveBeenCalled()
})

test('keeps newer local settings marked for restart after an older restart completes', async () => {
  const pending = deferred<void>()
  host.restart.mockReturnValueOnce(pending.promise)
  render(<ProxySettingsPage />)
  await saveLocal()
  fireEvent.click(screen.getByTestId('local-proxy-config-restart-codex-button'))
  await waitFor(() => expect(host.restart).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByTestId('local-proxy-mode-direct'))
  fireEvent.click(screen.getByTestId('local-proxy-config-save-button'))
  await act(async () => pending.resolve())
  expect(screen.getByTestId('local-proxy-config-restart-codex-button')).toBeEnabled()
  fireEvent.click(screen.getByTestId('local-proxy-config-restart-codex-button'))
  await waitFor(() =>
    expect(host.restart).toHaveBeenLastCalledWith('runtime.codex.app_server.restart', {
      proxyUrl: null,
    })
  )
  await waitFor(() =>
    expect(screen.queryByTestId('local-proxy-config-restart-codex-button')).not.toBeInTheDocument()
  )
})

test('does not begin a native restart if the page closes while resolving the proxy', async () => {
  const pending = deferred<string | null>()
  host.proxyUrl.mockReturnValueOnce(pending.promise)
  const { unmount } = render(<ProxySettingsPage />)
  await saveLocal()
  fireEvent.click(screen.getByTestId('local-proxy-config-restart-codex-button'))
  unmount()
  await act(async () => pending.resolve('http://127.0.0.1:7890'))
  expect(host.restart).not.toHaveBeenCalled()
})

test('masks credentials in the effective connection label', async () => {
  render(<ProxySettingsPage />)
  await saveLocal('http://user:example-password@127.0.0.1:7890')
  await waitFor(() =>
    expect(screen.getByTestId('local-proxy-effective-url')).toHaveTextContent('127.0.0.1:7890')
  )
  expect(screen.getByTestId('local-proxy-effective-url')).not.toHaveTextContent('example-password')
  expect(screen.getByTestId('local-proxy-config-url-input')).toHaveValue('')
})

test('retries a failed cloud read from the header without disturbing local drafts', async () => {
  first.getProxyConfig.mockRejectedValueOnce(new Error('Cloud unavailable'))
  render(<ProxySettingsPage />)
  typeLocal('http://local-draft:8080')
  await screen.findByTestId('proxy-config-error')
  fireEvent.click(screen.getByTestId('proxy-config-refresh-button'))
  await screen.findByText('http://cloud.example.test:8080')
  expect(screen.getByTestId('local-proxy-config-url-input')).toHaveValue('http://local-draft:8080')
  expect(host.effective).toHaveBeenCalledTimes(1)
  expect(first.getProxyConfig).toHaveBeenCalledTimes(2)
})

test('keeps a valid saved configuration available for restart after another save is rejected', async () => {
  render(<ProxySettingsPage />)
  await saveLocal()
  fireEvent.change(screen.getByTestId('local-proxy-config-url-input'), {
    target: { value: 'invalid' },
  })
  fireEvent.click(screen.getByTestId('local-proxy-config-save-button'))
  expect(screen.getByTestId('local-proxy-config-error')).toBeInTheDocument()
  expect(screen.getByTestId('local-proxy-config-restart-codex-button')).toBeEnabled()
  expect(getLocalProxyConfig().proxyUrl).toBe('http://127.0.0.1:7890')
})

test('keeps restart recovery available on native failure and performs no automatic restart retry', async () => {
  host.restart.mockRejectedValueOnce(new Error('Restart failed'))
  render(<ProxySettingsPage />)
  await saveLocal()
  fireEvent.click(screen.getByTestId('local-proxy-config-restart-codex-button'))
  expect(await screen.findByTestId('local-proxy-config-error')).toHaveTextContent('Restart failed')
  expect(screen.getByTestId('local-proxy-config-restart-codex-button')).toBeEnabled()
  expect(host.restart).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('local-proxy-config-restart-codex-button'))
  await waitFor(() =>
    expect(screen.queryByTestId('local-proxy-config-restart-codex-button')).not.toBeInTheDocument()
  )
  expect(host.restart).toHaveBeenCalledTimes(2)
})
