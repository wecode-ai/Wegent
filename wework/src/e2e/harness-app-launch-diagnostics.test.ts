import { afterEach, expect, test, vi } from 'vitest'
import {
  captureHarnessAppLaunchDiagnostics,
  observeHarnessAppLaunchCatalog,
} from './harness-app-launch-diagnostics'

afterEach(() => vi.unstubAllEnvs())

test('captures only the connected owner and its actual catalog snapshot', () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const disconnect = observeHarnessAppLaunchCatalog('app-1', ['Default', 'Extra'])
  const disconnectOther = observeHarnessAppLaunchCatalog('app-2', ['Other'])
  try {
    expect(captureHarnessAppLaunchDiagnostics('app-1')).toEqual({
      installationId: 'app-1',
      modelLabels: ['Default', 'Extra'],
    })
    disconnect()
    expect(captureHarnessAppLaunchDiagnostics('app-1')).toBeNull()
    expect(captureHarnessAppLaunchDiagnostics('app-2')?.modelLabels).toEqual(['Other'])
  } finally {
    disconnect()
    disconnectOther()
  }
})

test('does not expose catalog diagnostics in production', () => {
  vi.stubEnv('MODE', 'production')
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  expect(() => captureHarnessAppLaunchDiagnostics('app-1')).toThrow('only available in E2E')
  expect(() => observeHarnessAppLaunchCatalog('app-1', [])).toThrow('only available in E2E')
})
