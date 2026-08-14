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

  test('leaves the feedback URL empty by default', () => {
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', '')
    expect(getRuntimeConfig().feedbackUrl).toBe('')
  })

  test('uses the official PlantUML SVG server by default', () => {
    expect(getRuntimeConfig().plantumlServerUrl).toBe('https://www.plantuml.com/plantuml/svg')
  })

  test('prefers and normalizes the runtime PlantUML server URL', () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      plantumlServerUrl: 'https://plantuml.example.com/svg/',
    }

    expect(getRuntimeConfig().plantumlServerUrl).toBe('https://plantuml.example.com/svg')
  })

  test('reads and normalizes the feedback URL from build-time config', () => {
    vi.stubEnv('VITE_WEWORK_FEEDBACK_URL', 'https://feedback.example.com/v1/reports/')

    expect(getRuntimeConfig().feedbackUrl).toBe('https://feedback.example.com/v1/reports')
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
