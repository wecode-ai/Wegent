import { afterEach, describe, expect, test, vi } from 'vitest'
import { getRuntimeConfig } from './runtime'

describe('getRuntimeConfig', () => {
  afterEach(() => {
    delete window.__WEWORK_RUNTIME_CONFIG__
    vi.unstubAllEnvs()
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

  test('prefers runtime config over build-time environment values', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://build.example.com/api')
    vi.stubEnv('VITE_SOCKET_BASE_URL', 'http://build.example.com')
    vi.stubEnv('VITE_LOGIN_MODE', 'password')
    window.__WEWORK_RUNTIME_CONFIG__ = {
      apiBaseUrl: 'http://runtime.example.com/api',
      socketBaseUrl: 'http://runtime.example.com',
      socketPath: '/socket.io',
      loginMode: 'oidc',
    }

    const config = getRuntimeConfig()

    expect(config.apiBaseUrl).toBe('http://runtime.example.com/api')
    expect(config.socketBaseUrl).toBe('http://runtime.example.com')
    expect(config.socketPath).toBe('/socket.io')
    expect(config.loginMode).toBe('oidc')
  })

  test('ignores invalid runtime and build-time login modes', () => {
    vi.stubEnv('VITE_LOGIN_MODE', 'invalid-env-mode')
    window.__WEWORK_RUNTIME_CONFIG__ = {
      loginMode: 'invalid-runtime-mode' as never,
    }

    expect(getRuntimeConfig().loginMode).toBe('all')
  })
})
