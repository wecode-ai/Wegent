// @vitest-environment node

import { beforeEach, expect, test, vi } from 'vitest'
import { ensureLocalModelCatalogReady } from './local-model-catalog-readiness'

const { prepareRuntimeModel, listLocalModelConfigs } = vi.hoisted(() => ({
  prepareRuntimeModel: vi.fn(),
  listLocalModelConfigs: vi.fn(),
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: () => ({ runtimeWorkApi: { prepareRuntimeModel } }),
}))
vi.mock('@/features/model-settings/localModelSettings', () => ({ listLocalModelConfigs }))
vi.mock('./automation', () => ({ waitForDesktopE2ELocalModelSeed: () => Promise.resolve() }))

beforeEach(() => {
  vi.resetAllMocks()
  listLocalModelConfigs.mockReturnValue([])
})

test('waits for catalog reconciliation before checking readiness', async () => {
  let finish!: () => void
  prepareRuntimeModel.mockReturnValue(
    new Promise<void>(resolve => {
      finish = resolve
    })
  )
  const ready = ensureLocalModelCatalogReady()
  await vi.waitFor(() => expect(prepareRuntimeModel).toHaveBeenCalledOnce())

  expect(listLocalModelConfigs).not.toHaveBeenCalled()
  listLocalModelConfigs.mockReturnValue([{ id: 'fixture', catalogEntry: {}, catalogReady: true }])
  finish()
  await ready
  expect(listLocalModelConfigs).toHaveBeenCalledOnce()
  expect(prepareRuntimeModel).toHaveBeenCalledWith({ deviceId: 'local-device' })
})

test('rejects a catalog that remains unready after reconciliation', async () => {
  prepareRuntimeModel.mockResolvedValue(true)
  listLocalModelConfigs.mockReturnValue([{ id: 'fixture', catalogEntry: {}, catalogReady: false }])

  await expect(ensureLocalModelCatalogReady()).rejects.toThrow(
    'Local model catalog is not ready: fixture'
  )
})

test('preserves reconciliation errors', async () => {
  prepareRuntimeModel.mockRejectedValue(new Error('restart failed'))

  await expect(ensureLocalModelCatalogReady()).rejects.toThrow('restart failed')
  expect(listLocalModelConfigs).not.toHaveBeenCalled()
})
