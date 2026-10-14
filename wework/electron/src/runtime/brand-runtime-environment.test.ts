import { join } from 'node:path'

import { expect, test } from 'vitest'

import { applyBrandRuntimeEnvironment } from './brand-runtime-environment.js'

test('applies branded executor and cloud defaults', () => {
  expect(
    applyBrandRuntimeEnvironment(
      {},
      {
        weworkBackendUrl: 'https://cloud.example.com/api',
        weworkDecisionDefaultModel: 'decision-model-preview',
        weworkDecisionUpstreamUrl: 'https://decision.example.com/v1/decisions',
        weworkExecutorNamespace: 'com.example.wework',
        weworkSocketUrl: 'wss://socket.example.com',
      },
      '/Users/tester'
    )
  ).toEqual({
    WEGENT_EXECUTOR_HOME: join('/Users/tester', '.wework', 'apps', 'com.example.wework'),
    WEWORK_BACKEND_URL: 'https://cloud.example.com/api',
    WEWORK_DECISION_PROXY_DEFAULT_MODEL: 'decision-model-preview',
    WEWORK_DECISION_PROXY_UPSTREAM_URL: 'https://decision.example.com/v1/decisions',
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
        WEWORK_DECISION_PROXY_DEFAULT_MODEL: 'override-model',
        WEWORK_DECISION_PROXY_UPSTREAM_URL: 'https://override.example.com/v1/decisions',
      },
      {
        weworkBackendUrl: 'https://cloud.example.com/api',
        weworkDecisionDefaultModel: 'decision-model-preview',
        weworkDecisionUpstreamUrl: 'https://decision.example.com/v1/decisions',
        weworkExecutorNamespace: 'com.example.wework',
        weworkSocketUrl: 'wss://socket.example.com',
      },
      '/Users/tester'
    )
  ).toEqual({
    WEGENT_BACKEND_URL: 'https://override.example.com',
    WEGENT_EXECUTOR_HOME: '/tmp/executor',
    VITE_WEGENT_SOCKET_URL: 'wss://override-socket.example.com',
    WEWORK_DECISION_PROXY_DEFAULT_MODEL: 'override-model',
    WEWORK_DECISION_PROXY_UPSTREAM_URL: 'https://override.example.com/v1/decisions',
  })
})

test('applies each decision router default independently', () => {
  expect(
    applyBrandRuntimeEnvironment(
      {
        WEWORK_DECISION_PROXY_UPSTREAM_URL: 'https://override.example.com/v1/decisions',
      },
      {
        weworkDecisionDefaultModel: 'decision-model-preview',
        weworkDecisionUpstreamUrl: 'https://decision.example.com/v1/decisions',
      },
      '/Users/tester'
    )
  ).toEqual({
    WEWORK_DECISION_PROXY_DEFAULT_MODEL: 'decision-model-preview',
    WEWORK_DECISION_PROXY_UPSTREAM_URL: 'https://override.example.com/v1/decisions',
  })

  expect(
    applyBrandRuntimeEnvironment(
      {
        WEWORK_DECISION_PROXY_DEFAULT_MODEL: 'override-model',
      },
      {
        weworkDecisionDefaultModel: 'decision-model-preview',
        weworkDecisionUpstreamUrl: 'https://decision.example.com/v1/decisions',
      },
      '/Users/tester'
    )
  ).toEqual({
    WEWORK_DECISION_PROXY_DEFAULT_MODEL: 'override-model',
    WEWORK_DECISION_PROXY_UPSTREAM_URL: 'https://decision.example.com/v1/decisions',
  })
})

test('does not add decision router environment values without packaged metadata', () => {
  expect(applyBrandRuntimeEnvironment({}, {}, '/Users/tester')).toEqual({})
})
