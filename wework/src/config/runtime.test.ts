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
      'https://wiki.example.com/cloud-device-scaling'
    )

    expect(getRuntimeConfig().cloudDeviceScalingWikiUrl).toBe(
      'https://wiki.example.com/cloud-device-scaling'
    )
  })

  test('reads the default Wegent Backend URL from build-time config', () => {
    delete window.__WEWORK_RUNTIME_CONFIG__
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://cloud.example.com/api')

    expect(getRuntimeConfig().wegentBackendUrl).toBe('https://cloud.example.com')
    expect(getRuntimeConfig().apiBaseUrl).toBe('https://cloud.example.com/api')
    expect(getRuntimeConfig().socketBaseUrl).toBe('https://cloud.example.com')
  })

  test('uses the optional Wegent Socket URL from build-time config', () => {
    delete window.__WEWORK_RUNTIME_CONFIG__
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://cloud.example.com/api')
    vi.stubEnv('VITE_WEGENT_SOCKET_URL', 'wss://wss-cloud.example.com/')

    expect(getRuntimeConfig().socketBaseUrl).toBe('wss://wss-cloud.example.com')
  })

  test('prefers the runtime default Wegent Backend URL over build-time config', () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://build.example.com')
    window.__WEWORK_RUNTIME_CONFIG__ = {
      wegentBackendUrl: 'https://runtime.example.com',
    }

    expect(getRuntimeConfig().wegentBackendUrl).toBe('https://runtime.example.com')
  })

  test('prefers runtime config over the configured backend URL', () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'http://build.example.com')
    vi.stubEnv('VITE_LOGIN_MODE', 'password')
    window.__WEWORK_RUNTIME_CONFIG__ = {
      apiBaseUrl: 'http://runtime.example.com/api',
      socketBaseUrl: 'http://runtime.example.com',
      socketPath: '/socket.io',
      runtimeMode: 'backend',
      loginMode: 'oidc',
    }

    const config = getRuntimeConfig()

    expect(config.apiBaseUrl).toBe('http://runtime.example.com/api')
    expect(config.socketBaseUrl).toBe('http://runtime.example.com')
    expect(config.socketPath).toBe('/socket.io')
    expect(config.runtimeMode).toBe('backend')
    expect(config.loginMode).toBe('oidc')
  })

  test('ignores invalid runtime and build-time login modes', () => {
    vi.stubEnv('VITE_LOGIN_MODE', 'invalid-env-mode')
    window.__WEWORK_RUNTIME_CONFIG__ = {
      loginMode: 'invalid-runtime-mode' as never,
    }

    expect(getRuntimeConfig().loginMode).toBe('all')
  })

  test('defaults to local-first mode without explicit runtime config', () => {
    expect(getRuntimeConfig().runtimeMode).toBe('local-first')
  })

  test('uses local-first mode from runtime config override', () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      runtimeMode: 'local-first',
    }

    expect(getRuntimeConfig().runtimeMode).toBe('local-first')
  })

  test('uses local-first mode from build-time environment', () => {
    vi.stubEnv('VITE_WEWORK_RUNTIME_MODE', 'local-first')

    expect(getRuntimeConfig().runtimeMode).toBe('local-first')
  })

  test('uses backend mode from build-time environment', () => {
    vi.stubEnv('VITE_WEWORK_RUNTIME_MODE', 'backend')

    expect(getRuntimeConfig().runtimeMode).toBe('backend')
  })

  test('ignores invalid runtime modes', () => {
    vi.stubEnv('VITE_WEWORK_RUNTIME_MODE', 'invalid-mode')
    window.__WEWORK_RUNTIME_CONFIG__ = {
      runtimeMode: 'invalid-runtime-mode' as never,
    }

    expect(getRuntimeConfig().runtimeMode).toBe('local-first')
  })
})
