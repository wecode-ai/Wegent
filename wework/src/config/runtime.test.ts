import { afterEach, describe, expect, test, vi } from 'vitest'
import { getRuntimeConfig } from './runtime'

describe('getRuntimeConfig', () => {
  afterEach(() => {
    delete window.__WEWORK_RUNTIME_CONFIG__
    vi.unstubAllEnvs()
  })

  test('uses runtime config before build-time Vite env values', () => {
    vi.stubEnv('VITE_APP_BASE_PATH', '/wework/')
    vi.stubEnv('VITE_API_BASE_URL', 'https://preview-wegent.intra.weibo.com/api')
    vi.stubEnv('VITE_SOCKET_BASE_URL', 'wss://wss-wegent.intra.weibo.com')

    window.__WEWORK_RUNTIME_CONFIG__ = {
      appBasePath: '/beta-wework/',
      apiBaseUrl: 'https://beta-wegent.intra.weibo.com/api',
      socketBaseUrl: 'https://beta-wegent.intra.weibo.com',
      socketPath: '/beta-wework/socket.io',
    }

    expect(getRuntimeConfig()).toMatchObject({
      appBasePath: '/beta-wework',
      apiBaseUrl: 'https://beta-wegent.intra.weibo.com/api',
      socketBaseUrl: 'https://beta-wegent.intra.weibo.com',
      socketPath: '/beta-wework/socket.io',
    })
  })

  test('uses base-path proxy defaults when runtime api and socket path are omitted', () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    vi.stubEnv('VITE_SOCKET_BASE_URL', '')
    vi.stubEnv('VITE_SOCKET_PATH', '')

    window.__WEWORK_RUNTIME_CONFIG__ = {
      appBasePath: '/wework/',
      socketBaseUrl: window.location.origin,
    }

    expect(getRuntimeConfig()).toMatchObject({
      appBasePath: '/wework',
      apiBaseUrl: '/wework/api',
      socketBaseUrl: window.location.origin,
      socketPath: '/wework/socket.io',
    })
  })

  test('does not fall back to preview build-time URLs when runtime keys are present', () => {
    vi.stubEnv('VITE_APP_BASE_PATH', '/wework/')
    vi.stubEnv('VITE_API_BASE_URL', 'https://preview-wegent.intra.weibo.com/api')
    vi.stubEnv('VITE_SOCKET_BASE_URL', 'wss://wss-wegent.intra.weibo.com')
    vi.stubEnv('VITE_SOCKET_PATH', '/socket.io')
    vi.stubEnv('VITE_LOGIN_MODE', 'oidc')

    window.__WEWORK_RUNTIME_CONFIG__ = {
      appBasePath: '/wework/',
      apiBaseUrl: undefined,
      socketBaseUrl: undefined,
      socketPath: undefined,
      loginMode: 'oidc',
    }

    expect(getRuntimeConfig()).toMatchObject({
      apiBaseUrl: '/wework/api',
      socketBaseUrl: window.location.origin,
      socketPath: '/wework/socket.io',
      loginMode: 'oidc',
    })
  })

  test('reads cloud device scaling wiki URL from wework frontend config', () => {
    vi.stubEnv(
      'VITE_CLOUD_DEVICE_SCALING_WIKI_URL',
      'https://wiki.example.com/cloud-device-scaling',
    )

    expect(getRuntimeConfig().cloudDeviceScalingWikiUrl).toBe(
      'https://wiki.example.com/cloud-device-scaling',
    )
  })
})
