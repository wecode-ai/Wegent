import { expect, test } from 'vitest'

import { applyBrandRuntimeEnvironment } from './brand-runtime-environment.js'

test('applies branded cloud defaults', () => {
  expect(
    applyBrandRuntimeEnvironment(
      {},
      {
        weworkBackendUrl: 'https://cloud.example.com/api',
        weworkExecutorNamespace: 'com.example.wework',
        weworkSocketUrl: 'wss://socket.example.com',
      }
    )
  ).toEqual({
    WEWORK_BACKEND_URL: 'https://cloud.example.com/api',
    WEWORK_SOCKET_URL: 'wss://socket.example.com',
  })
})

test('preserves explicit runtime environment values', () => {
  expect(
    applyBrandRuntimeEnvironment(
      {
        WEGENT_BACKEND_URL: 'https://override.example.com',
        WEGENT_EXECUTOR_HOME: '/tmp/executor',
        VITE_WEGENT_SOCKET_URL: 'wss://override-socket.example.com',
      },
      {
        weworkBackendUrl: 'https://cloud.example.com/api',
        weworkExecutorNamespace: 'com.example.wework',
        weworkSocketUrl: 'wss://socket.example.com',
      }
    )
  ).toEqual({
    WEGENT_BACKEND_URL: 'https://override.example.com',
    WEGENT_EXECUTOR_HOME: '/tmp/executor',
    VITE_WEGENT_SOCKET_URL: 'wss://override-socket.example.com',
  })
})
