import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { CloudModelsSection } from './CloudModelsSection'

const mocks = vi.hoisted(() => ({ list: vi.fn(), client: vi.fn() }))
vi.mock('@/api/http', () => ({ createHttpClient: mocks.client }))
vi.mock('@/api/models', () => ({ createModelApi: () => ({ listModels: mocks.list }) }))
const connection = {
  isConnected: true,
  apiBaseUrl: 'https://cloud.example.invalid',
  token: 'account-a',
}
const model = {
  name: 'model-a',
  displayName: 'Model A',
  provider: 'provider',
  type: 'public',
  isActive: true,
}
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.list.mockResolvedValue({ data: [model] })
  mocks.client.mockReturnValue({})
})

test('keeps the existing model preview limit, metadata and disabled indicator', async () => {
  mocks.list.mockResolvedValue({
    data: Array.from({ length: 10 }, (_, index) => ({
      ...model,
      name: `model-${index}`,
      displayName: `Model ${index}`,
      isActive: index !== 0,
    })),
  })
  render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model 0')
  expect(screen.getByText('Model 7')).toBeInTheDocument()
  expect(screen.queryByText('Model 8')).not.toBeInTheDocument()
  expect(screen.getByText(i18n.t('workbench.plugin_detail_disabled'))).toBeInTheDocument()
  expect(screen.getByText(i18n.t('workbench.cloud_models_more', { count: 2 }))).toBeInTheDocument()
})

test('an equivalent connection object does not refetch models', async () => {
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model A')
  await act(async () => {
    view.rerender(<CloudModelsSection cloudConnection={{ ...connection }} />)
  })
  expect(mocks.list).toHaveBeenCalledOnce()
})

test('language changes update text without refetching the catalog', async () => {
  const previousLanguage = i18n.language
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  try {
    await screen.findByText('Model A')
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(mocks.list).toHaveBeenCalledOnce()
  } finally {
    view.unmount()
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test.each([
  { ...connection, token: 'account-b' },
  { ...connection, apiBaseUrl: 'https://another-cloud.example.invalid' },
])('a changed account or backend hides previous data immediately', async nextConnection => {
  const pending = held<{ data: (typeof model)[] }>()
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model A')
  mocks.list.mockReturnValueOnce(pending.promise)
  view.rerender(<CloudModelsSection cloudConnection={nextConnection} />)
  expect(screen.queryByText('Model A')).not.toBeInTheDocument()
  await act(async () => {
    pending.resolve({ data: [{ ...model, displayName: 'Model B' }] })
    await pending.promise
  })
  expect(screen.getByText('Model B')).toBeInTheDocument()
  const options = mocks.client.mock.calls.at(-1)![0]
  expect(options.baseUrl).toBe(nextConnection.apiBaseUrl)
  expect(options.getToken()).toBe(nextConnection.token)
})

test('late results from the previous account cannot replace the current catalog', async () => {
  const pending = held<{ data: (typeof model)[] }>()
  mocks.list
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ data: [{ ...model, displayName: 'Model B' }] })
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce())
  view.rerender(<CloudModelsSection cloudConnection={{ ...connection, token: 'account-b' }} />)
  await screen.findByText('Model B')
  await act(async () => {
    pending.resolve({ data: [model] })
    await pending.promise
  })
  expect(screen.queryByText('Model A')).not.toBeInTheDocument()
  expect(screen.getByText('Model B')).toBeInTheDocument()
})

test('disconnecting hides the catalog and does not read models until connected again', async () => {
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model A')
  view.rerender(<CloudModelsSection cloudConnection={{ ...connection, isConnected: false }} />)
  expect(screen.queryByText('Model A')).not.toBeInTheDocument()
  expect(mocks.list).toHaveBeenCalledOnce()
  view.rerender(<CloudModelsSection cloudConnection={connection} />)
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
})

test('an initially disconnected section performs no API work', () => {
  render(<CloudModelsSection cloudConnection={{ isConnected: false, token: null }} />)
  expect(mocks.client).not.toHaveBeenCalled()
  expect(mocks.list).not.toHaveBeenCalled()
  expect(screen.queryByText(i18n.t('workbench.cloud_models_loading'))).not.toBeInTheDocument()
})

test('an initial failure is distinct from an empty catalog and reconnecting retries it', async () => {
  mocks.list.mockRejectedValueOnce(new Error('catalog unavailable'))
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('catalog unavailable')
  expect(screen.queryByText(i18n.t('workbench.cloud_models_empty'))).not.toBeInTheDocument()
  expect(screen.queryByText('0')).not.toBeInTheDocument()
  view.rerender(<CloudModelsSection cloudConnection={{ ...connection, isConnected: false }} />)
  view.rerender(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model A')
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('catalog unavailable')).not.toBeInTheDocument()
})

test('a successful empty catalog keeps the existing empty state', async () => {
  mocks.list.mockResolvedValue({ data: [] })
  render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText(i18n.t('workbench.cloud_models_empty'))
  expect(screen.getByText('0')).toBeInTheDocument()
})

test('a detached request cannot populate a reopened section', async () => {
  const pending = held<{ data: (typeof model)[] }>()
  mocks.list.mockReturnValueOnce(pending.promise)
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  expect(mocks.list).toHaveBeenCalledOnce()
  view.unmount()
  render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model A')
  await act(async () => {
    pending.resolve({ data: [{ ...model, displayName: 'Detached model' }] })
    await pending.promise
  })
  expect(screen.queryByText('Detached model')).not.toBeInTheDocument()
})

test('a same-account refresh failure keeps the last known model preview visible', async () => {
  const view = render(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('Model A')
  mocks.list.mockRejectedValueOnce(new Error('refresh unavailable'))
  view.rerender(<CloudModelsSection cloudConnection={{ ...connection, isConnected: false }} />)
  view.rerender(<CloudModelsSection cloudConnection={connection} />)
  await screen.findByText('refresh unavailable')
  expect(screen.getByText('Model A')).toBeInTheDocument()
  expect(screen.getByText('1')).toBeInTheDocument()
})
