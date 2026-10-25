import { beforeEach, expect, test, vi } from 'vitest'
import { ensureLocalModelCatalogReady } from './local-model-catalog-readiness'

const { listModels, listLocalModelConfigs } = vi.hoisted(() => ({
  listModels: vi.fn(),
  listLocalModelConfigs: vi.fn(),
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: () => ({ modelApi: { listModels } }),
}))
vi.mock('@/features/model-settings/localModelSettings', () => ({ listLocalModelConfigs }))

beforeEach(() => {
  vi.resetAllMocks()
  listLocalModelConfigs.mockReturnValue([])
})

test('waits for catalog reconciliation before checking readiness', async () => {
  let finish!: () => void
  listModels.mockReturnValue(
    new Promise<void>(resolve => {
      finish = resolve
    })
  )
  const ready = ensureLocalModelCatalogReady()

  expect(listLocalModelConfigs).not.toHaveBeenCalled()
  listLocalModelConfigs.mockReturnValue([{ id: 'fixture', catalogEntry: {}, catalogReady: true }])
  finish()
  await ready
  expect(listLocalModelConfigs).toHaveBeenCalledOnce()
})

test('rejects a catalog that remains unready after reconciliation', async () => {
  listModels.mockResolvedValue({ data: [] })
  listLocalModelConfigs.mockReturnValue([{ id: 'fixture', catalogEntry: {}, catalogReady: false }])

  await expect(ensureLocalModelCatalogReady()).rejects.toThrow(
    'Local model catalog is not ready: fixture'
  )
})

test('preserves reconciliation errors', async () => {
  listModels.mockRejectedValue(new Error('restart failed'))

  await expect(ensureLocalModelCatalogReady()).rejects.toThrow('restart failed')
  expect(listLocalModelConfigs).not.toHaveBeenCalled()
})
