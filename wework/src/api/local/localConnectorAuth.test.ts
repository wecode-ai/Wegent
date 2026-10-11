import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GITHUB_CLI_TARGET, githubVerificationUrl } from './githubCli'
import {
  clearLocalConnectorAuthHealthCache,
  isLocalBrowserConnector,
  isLocalConnector,
  isLocalQrConnector,
  localConnectorAuthHealth,
  localConnectorAuthLogout,
  LocalConnectorAuthLogoutError,
  localQrManageActionFromHealth,
  pluginLocalConnectorAuthTarget,
} from './localConnectorAuth'

const mocks = vi.hoisted(() => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: () => mocks.ensureLocalExecutorStarted(),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
}))

describe('pluginLocalConnectorAuthTarget', () => {
  test('shares the canonical CLI target only for the official GitHub connector', () => {
    const connector = { slug: 'github', authPolicy: 'on_use' as const }
    expect(pluginLocalConnectorAuthTarget('GitHub', 'openai-curated-remote', connector)).toEqual(
      GITHUB_CLI_TARGET
    )
    expect(pluginLocalConnectorAuthTarget('github', 'wework', connector)).toBeNull()
    expect(
      pluginLocalConnectorAuthTarget('figma', 'openai-curated-remote', { slug: 'figma' })
    ).toBeNull()
    const local = { slug: 'wiki', localAuth: GITHUB_CLI_TARGET.localAuth }
    expect(pluginLocalConnectorAuthTarget('wiki', 'wework', local)).toEqual({
      pluginKey: 'wiki',
      connectorSlug: 'wiki',
      localAuth: local.localAuth,
    })
  })

  test('retains actionable executor logout errors', () => {
    expect(
      new LocalConnectorAuthLogoutError({ status: 'error', errorCode: 'gh_logout_env_token' })
        .errorCode
    ).toBe('gh_logout_env_token')
  })
})

describe('localQrManageActionFromHealth', () => {
  test('returns logout when session is healthy', () => {
    expect(localQrManageActionFromHealth({ status: 'ok' })).toBe('logout')
  })

  test('returns login when session needs authorization', () => {
    expect(localQrManageActionFromHealth({ status: 'need_login' })).toBe('login')
    expect(localQrManageActionFromHealth({ status: 'need_scan' })).toBe('login')
    expect(localQrManageActionFromHealth({ status: 'waiting_scan' })).toBe('login')
    expect(localQrManageActionFromHealth({ status: 'error' })).toBe('login')
    expect(localQrManageActionFromHealth(null)).toBe('login')
    expect(localQrManageActionFromHealth(undefined)).toBe('login')
  })
})

describe('localConnectorAuthHealth cache', () => {
  beforeEach(() => {
    clearLocalConnectorAuthHealthCache()
    mocks.ensureLocalExecutorStarted.mockReset()
    mocks.requestLocalExecutor.mockReset()
    mocks.ensureLocalExecutorStarted.mockResolvedValue({ deviceId: 'local-device' })
    mocks.requestLocalExecutor.mockResolvedValue({ status: 'ok' })
  })

  test('reuses a recent ok health probe without calling the executor again', async () => {
    const target = { pluginKey: 'dingtalk', connectorSlug: 'dingtalk' }
    await expect(localConnectorAuthHealth(target)).resolves.toEqual({ status: 'ok' })
    await expect(localConnectorAuthHealth(target)).resolves.toEqual({ status: 'ok' })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(1)
  })

  test('bypasses a cached result while waiting for a fresh local installation', async () => {
    const target = { pluginKey: 'dingtalk', connectorSlug: 'dingtalk' }
    await localConnectorAuthHealth(target)
    await localConnectorAuthHealth(target, { bypassCache: true })

    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(2)
  })

  test('gh login is owned by the CLI, so every health check reads the actual executor state', async () => {
    await expect(localConnectorAuthHealth(GITHUB_CLI_TARGET)).resolves.toEqual({ status: 'ok' })
    mocks.requestLocalExecutor.mockResolvedValueOnce({ status: 'need_login' })
    await expect(localConnectorAuthHealth(GITHUB_CLI_TARGET)).resolves.toEqual({
      status: 'need_login',
    })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(2)
  })

  test('rejects an unsuccessful logout rather than reporting a disconnected session', async () => {
    mocks.requestLocalExecutor.mockResolvedValue({ status: 'error', hint: 'synthetic-secret' })
    await expect(
      localConnectorAuthLogout({ pluginKey: 'weibo-api-wiki', connectorSlug: 'weibo-wiki' })
    ).rejects.toMatchObject({ name: 'LocalConnectorAuthLogoutError', accountRevoked: false })
  })

  test('preserves a confirmed revocation when local cleanup fails', async () => {
    mocks.requestLocalExecutor.mockResolvedValue({ status: 'error', accountRevoked: true })
    await expect(
      localConnectorAuthLogout({ pluginKey: 'weibo-api-wiki', connectorSlug: 'weibo-wiki' })
    ).rejects.toMatchObject({ name: 'LocalConnectorAuthLogoutError', accountRevoked: true })
    expect(new LocalConnectorAuthLogoutError({ status: 'error' }).message).toBe(
      'local_auth_logout_failed'
    )
  })

  test('invalidates cached health even if account revocation fails', async () => {
    const target = { pluginKey: 'weibo-api-wiki', connectorSlug: 'weibo-wiki' }
    await localConnectorAuthHealth(target)
    mocks.requestLocalExecutor.mockRejectedValueOnce(new Error('plugin_auth_not_supported'))
    await expect(localConnectorAuthLogout(target)).rejects.toThrow('plugin_auth_not_supported')
    await localConnectorAuthHealth(target)
    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(3)
  })

  test('does not restore stale healthy state after logout', async () => {
    const target = { pluginKey: 'weibo-api-wiki', connectorSlug: 'weibo-wiki' }
    let resolveHealth: (value: { status: 'ok' }) => void = () => undefined
    mocks.requestLocalExecutor.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveHealth = resolve
        })
    )

    const staleHealth = localConnectorAuthHealth(target)
    await vi.waitFor(() => expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(1))
    mocks.requestLocalExecutor.mockResolvedValueOnce({ status: 'ok' })
    await localConnectorAuthLogout(target)
    resolveHealth({ status: 'ok' })
    await expect(staleHealth).resolves.toEqual({ status: 'ok' })

    mocks.requestLocalExecutor.mockResolvedValueOnce({ status: 'need_login' })
    await expect(localConnectorAuthHealth(target)).resolves.toEqual({ status: 'need_login' })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(3)
  })
})

describe('local connector kinds', () => {
  test('gh authorization accepts only known HTTPS GitHub endpoints on the standard port', () => {
    expect(githubVerificationUrl('https://github.com/login/device')).toBe(
      'https://github.com/login/device'
    )
    for (const address of [
      'http://github.com/login/device',
      'https://github.com:8443/login/device',
      'https://user@github.com/login/device',
      'https://github.com.evil/login/device',
      'https://github.com/settings/tokens',
      'invalid',
    ])
      expect(githubVerificationUrl(address)).toBeNull()
  })
  test('distinguishes browser and QR authentication', () => {
    const browser = {
      localAuth: {
        kind: 'browser_oauth' as const,
        health: ['health'],
        start: ['login'],
        poll: [],
      },
    }
    const qr = {
      localAuth: {
        kind: 'local_qr' as const,
        health: ['health'],
        start: ['start'],
        poll: ['poll'],
      },
    }
    expect(isLocalConnector(browser)).toBe(true)
    expect(isLocalBrowserConnector(browser)).toBe(true)
    expect(isLocalQrConnector(browser)).toBe(false)
    expect(isLocalConnector(qr)).toBe(true)
    expect(isLocalQrConnector(qr)).toBe(true)
  })
})
