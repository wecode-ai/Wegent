import { beforeEach, expect, test, vi } from 'vitest'
import { releaseHarnessAppRoutes } from './harnessAppRoutes'

const mocks = vi.hoisted(() => ({
  takeProxy: vi.fn(),
  takeAdditional: vi.fn(),
  takeContext: vi.fn(),
  takeDecision: vi.fn(),
}))
vi.mock('./harnessAppTabs', () => ({
  takeHarnessAppProxyToken: mocks.takeProxy,
  takeHarnessAppAdditionalProxyTokens: mocks.takeAdditional,
  takeHarnessAppContextToken: mocks.takeContext,
  takeHarnessAppDecisionToken: mocks.takeDecision,
}))
beforeEach(() => {
  mocks.takeProxy.mockReset().mockResolvedValue('default-token')
  mocks.takeAdditional.mockReset().mockResolvedValue(['second-token'])
  mocks.takeContext.mockReset().mockResolvedValue('context-token')
  mocks.takeDecision.mockReset().mockResolvedValue('decision-token')
})

test('deduplicates host and locally retained routes before unregistering', async () => {
  const modelApi = {
    resolveLaunch: vi.fn(),
    unregisterProxy: vi.fn().mockResolvedValue(undefined),
    unregisterContext: vi.fn().mockResolvedValue(undefined),
  }
  const decisionApi = { resolveLaunch: vi.fn(), unregister: vi.fn().mockResolvedValue(undefined) }
  await releaseHarnessAppRoutes('app-1', modelApi, decisionApi, {
    proxyToken: 'default-token',
    additionalProxyTokens: ['second-token', 'local-only-token'],
    contextToken: 'context-token',
    decisionToken: 'decision-token',
  })
  expect(modelApi.unregisterProxy.mock.calls.map(([token]) => token).sort()).toEqual([
    'default-token',
    'local-only-token',
    'second-token',
  ])
  expect(modelApi.unregisterContext).toHaveBeenCalledExactlyOnceWith('context-token')
  expect(decisionApi.unregister).toHaveBeenCalledExactlyOnceWith('decision-token')
})

test('releases local routes despite all host reads failing and one unregister rejecting', async () => {
  Object.values(mocks).forEach(mock => mock.mockRejectedValue(new Error('Host read failed')))
  const modelApi = {
    resolveLaunch: vi.fn(),
    unregisterProxy: vi
      .fn()
      .mockRejectedValueOnce(new Error('Default unregister failed'))
      .mockResolvedValue(undefined),
    unregisterContext: vi.fn().mockResolvedValue(undefined),
  }
  const decisionApi = { resolveLaunch: vi.fn(), unregister: vi.fn().mockResolvedValue(undefined) }
  await releaseHarnessAppRoutes('app-1', modelApi, decisionApi, {
    proxyToken: 'default-token',
    additionalProxyTokens: ['second-token'],
    contextToken: 'context-token',
    decisionToken: 'decision-token',
  })
  expect(modelApi.unregisterProxy).toHaveBeenCalledWith('default-token')
  expect(modelApi.unregisterProxy).toHaveBeenCalledWith('second-token')
  expect(modelApi.unregisterContext).toHaveBeenCalledWith('context-token')
  expect(decisionApi.unregister).toHaveBeenCalledWith('decision-token')
})
