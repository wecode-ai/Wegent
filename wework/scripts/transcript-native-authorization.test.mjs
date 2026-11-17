// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/transcript-sync.scenario.mjs'

const native = vi.hoisted(() => ({ authorize: vi.fn(), restore: vi.fn(), fixture: vi.fn() }))
vi.mock('../e2e/desktop/modules/native-cloud-authorization-client.mjs', () => ({
  nativeCloudAuthorizationFixture: (...args) => {
    native.fixture(...args)
    return { authorize: native.authorize, restore: native.restore }
  },
}))
vi.mock('../e2e/desktop/modules/transcript-backend-evidence.mjs', () => ({
  TranscriptBackendEvidence: class {
    proxy = { url: 'http://127.0.0.1:9001' }
    async start() {
      return this
    }
    async stop() {}
  },
}))

test('transcript authorization waits for the connected native host, uses its proxy, and cleans up failure', async () => {
  native.authorize.mockRejectedValueOnce(new Error('native authorization rejected'))
  const scenario = createDesktopScenario({ electronUserDataDirectory: '/isolated/device-a' })
  const cloud = { backendUrl: 'http://127.0.0.1:8000', authToken: 'synthetic-owner' }
  scenario.setCloudEnvironment(cloud)
  const appEnvironment = {}
  await scenario.prepareApp({ appEnvironment })
  expect(scenario.requiresNativeCloudInspector).toBe(true)
  expect(native.fixture).not.toHaveBeenCalled()
  expect(appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL).toBe('http://127.0.0.1:9001')

  const control = { nativeInspectorPort: 1234, applicationProcessId: 4321, command: vi.fn() }
  await expect(scenario.verify(control)).rejects.toThrow('native authorization rejected')
  expect(native.fixture).toHaveBeenCalledExactlyOnceWith(
    { backendUrl: 'http://127.0.0.1:9001', authToken: 'synthetic-owner' },
    '/isolated/device-a',
    control
  )
  expect(control.command).not.toHaveBeenCalled()
  await scenario.cleanup()
  expect(native.restore).toHaveBeenCalledOnce()
})
