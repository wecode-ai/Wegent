import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import type { CodexOfficialModelList } from '@/features/model-settings/codexOfficialModels'
import type { CodexModelCatalogOverride } from '@/api/local/codexOfficialModels'
import { CodexOfficialModelsSection } from './CodexOfficialModelsSection'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  restart: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('@/api/local/codexOfficialModels', () => ({
  getLocalCodexModelCatalogOverrides: mocks.read,
  saveLocalCodexModelCatalogOverride: mocks.save,
  deleteLocalCodexModelCatalogOverride: mocks.remove,
}))
vi.mock('@/desktop/localExecutor', () => ({ requestLocalExecutor: mocks.restart }))
function list(slug: string): CodexOfficialModelList {
  const model = {
    id: slug,
    modelId: slug,
    displayName: slug,
    providerId: 'openai',
    providerName: 'OpenAI',
    providerType: 'official' as const,
    providerCurrent: true,
    description: null,
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    supportsFastMode: false,
  }
  return {
    models: [model],
    providers: [
      {
        id: 'openai',
        displayName: 'OpenAI',
        type: 'official',
        current: true,
        available: true,
        error: null,
        models: [model],
      },
    ],
  }
}
function entry(slug: string): CodexModelCatalogOverride {
  return {
    slug,
    baseline: { slug, context_window: 1000 },
    effective: { slug, context_window: 2000 },
    overridden: true,
  }
}
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function view(modelList = list('model-a')) {
  return (
    <CodexOfficialModelsSection
      modelList={modelList}
      loading={false}
      error={null}
      onRefresh={mocks.refresh}
    />
  )
}
async function expand() {
  await userEvent.click(screen.getByTestId('codex-model-provider-toggle-openai'))
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockImplementation(async (slugs: string[]) => slugs.map(entry))
  mocks.restart.mockResolvedValue({ restarted: true, requiresConfirmation: false })
})

test('equivalent catalogs and language changes do not repeat override reads', async () => {
  const previousLanguage = i18n.language
  const rendered = render(view())
  try {
    await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    await act(async () => {
      rendered.rerender(view())
    })
    expect(mocks.read).toHaveBeenCalledOnce()
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(mocks.read).toHaveBeenCalledOnce()
  } finally {
    rendered.unmount()
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('a late old catalog cannot disable editing in the current catalog', async () => {
  const old = held<CodexModelCatalogOverride[]>()
  mocks.read.mockReturnValueOnce(old.promise)
  const rendered = render(view())
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
  rendered.rerender(view(list('model-b')))
  await expand()
  await waitFor(() => expect(screen.getByTestId('codex-catalog-edit-openai-model-b')).toBeEnabled())
  await act(async () => {
    old.resolve([entry('model-a')])
    await old.promise
  })
  expect(screen.getByTestId('codex-catalog-edit-openai-model-b')).toBeEnabled()
})

test('manual refresh rereads overrides even when the model IDs stay unchanged', async () => {
  render(view())
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
  await userEvent.click(screen.getByTestId('codex-official-models-refresh-button'))
  expect(mocks.refresh).toHaveBeenCalledOnce()
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
})

test('switching catalogs closes the old editor while preserving provider disclosure', async () => {
  const rendered = render(view())
  await expand()
  await userEvent.click(await screen.findByTestId('codex-catalog-edit-openai-model-a'))
  expect(screen.getByTestId('codex-catalog-editor-dialog')).toBeInTheDocument()
  rendered.rerender(view(list('model-b')))
  expect(screen.queryByTestId('codex-catalog-editor-dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('codex-model-provider-toggle-openai')).toHaveAttribute(
    'aria-expanded',
    'true'
  )
})

test('a restore finishing after a catalog switch cannot restart the current runtime or reload the old catalog', async () => {
  const deletion = held<void>()
  mocks.remove.mockReturnValue(deletion.promise)
  const rendered = render(view())
  await expand()
  await userEvent.click(await screen.findByTestId('codex-catalog-restore-openai-model-a'))
  rendered.rerender(view(list('model-b')))
  await waitFor(() => expect(screen.getByTestId('codex-catalog-edit-openai-model-b')).toBeEnabled())
  await act(async () => {
    deletion.resolve()
    await deletion.promise
  })
  expect(mocks.restart).not.toHaveBeenCalled()
  expect(mocks.read).toHaveBeenCalledTimes(2)
})

async function edit() {
  await expand()
  const button = await screen.findByTestId('codex-catalog-edit-openai-model-a')
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  fireEvent.change(screen.getByTestId('local-model-context-window-input'), {
    target: { value: '3000' },
  })
}

test('duplicate save clicks issue one write and preserve the explicit idle restart flow', async () => {
  const write = held<void>()
  mocks.save.mockReturnValue(write.promise)
  render(view())
  await edit()
  const save = screen.getByTestId('codex-catalog-editor-save')
  act(() => {
    fireEvent.click(save)
    fireEvent.click(save)
  })
  expect(mocks.save).toHaveBeenCalledTimes(1)
  expect(mocks.restart).not.toHaveBeenCalled()
  await act(async () => {
    write.resolve()
    await write.promise
  })
  expect(mocks.restart).toHaveBeenCalledExactlyOnceWith('runtime.codex.app_server.restart', {
    ifIdle: true,
  })
  expect(mocks.refresh).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('codex-catalog-editor-dialog')).not.toBeInTheDocument()
})

test('a busy runtime requires the existing explicit confirmation before a forced restart', async () => {
  mocks.restart
    .mockResolvedValueOnce({ restarted: false, requiresConfirmation: true })
    .mockResolvedValueOnce({})
  render(view())
  await edit()
  await userEvent.click(screen.getByTestId('codex-catalog-editor-save'))
  await screen.findByTestId('local-model-catalog-restart-now-button')
  expect(mocks.restart).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('codex-catalog-editor-dialog')).toBeInTheDocument()
  await userEvent.click(screen.getByTestId('local-model-catalog-restart-now-button'))
  await waitFor(() =>
    expect(screen.queryByTestId('codex-catalog-editor-dialog')).not.toBeInTheDocument()
  )
  expect(mocks.restart).toHaveBeenLastCalledWith('runtime.codex.app_server.restart', {
    force: true,
  })
})

test('failed writes retain the editor draft and can be retried', async () => {
  mocks.save.mockRejectedValueOnce(new Error('write failed'))
  render(view())
  await edit()
  await userEvent.click(screen.getByTestId('codex-catalog-editor-save'))
  expect(screen.getByTestId('codex-catalog-editor-error')).toHaveTextContent('write failed')
  expect(screen.getByTestId('local-model-context-window-input')).toHaveValue(3000)
  expect(mocks.restart).not.toHaveBeenCalled()
  await userEvent.click(screen.getByTestId('codex-catalog-editor-save'))
  await waitFor(() =>
    expect(screen.queryByTestId('codex-catalog-editor-dialog')).not.toBeInTheDocument()
  )
  expect(mocks.save).toHaveBeenCalledTimes(2)
})

test('refreshing clears a restore failure without losing loaded metadata', async () => {
  mocks.remove.mockRejectedValueOnce(new Error('restore failed'))
  render(view())
  await expand()
  await userEvent.click(await screen.findByTestId('codex-catalog-restore-openai-model-a'))
  expect(screen.getByTestId('codex-catalog-error')).toHaveTextContent('restore failed')
  await userEvent.click(screen.getByTestId('codex-official-models-refresh-button'))
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
  expect(screen.queryByTestId('codex-catalog-error')).not.toBeInTheDocument()
  expect(screen.getByTestId('codex-catalog-edit-openai-model-a')).toBeEnabled()
})

test('empty catalogs do not request native overrides', async () => {
  render(view({ models: [], providers: [] }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(mocks.read).not.toHaveBeenCalled()
})

test('old save receipts leave a newly opened catalog editor intact', async () => {
  const write = held<void>()
  mocks.save.mockReturnValue(write.promise)
  const rendered = render(view())
  await edit()
  await userEvent.click(screen.getByTestId('codex-catalog-editor-save'))
  rendered.rerender(view(list('model-b')))
  const next = await screen.findByTestId('codex-catalog-edit-openai-model-b')
  await waitFor(() => expect(next).toBeEnabled())
  await userEvent.click(next)
  await act(async () => {
    write.resolve()
    await write.promise
  })
  expect(mocks.restart).not.toHaveBeenCalled()
  expect(screen.getByTestId('codex-catalog-editor-dialog')).toHaveTextContent('model-b')
  expect(screen.getByTestId('codex-catalog-editor-close')).toBeEnabled()
  expect(screen.getByTestId('local-model-context-window-input')).toHaveValue(2000)
})

test('initial load failures remain visible and explicit refresh can recover', async () => {
  mocks.read.mockRejectedValueOnce(new Error('offline'))
  render(view())
  await screen.findByText('offline')
  await expand()
  expect(screen.getByTestId('codex-catalog-edit-openai-model-a')).toBeDisabled()
  await userEvent.click(screen.getByTestId('codex-official-models-refresh-button'))
  await waitFor(() => expect(screen.getByTestId('codex-catalog-edit-openai-model-a')).toBeEnabled())
  expect(screen.queryByTestId('codex-catalog-error')).not.toBeInTheDocument()
})

test('failed refreshes retain same-catalog metadata while showing the read error', async () => {
  render(view())
  await expand()
  await waitFor(() => expect(screen.getByTestId('codex-catalog-edit-openai-model-a')).toBeEnabled())
  mocks.read.mockRejectedValueOnce(new Error('refresh offline'))
  await userEvent.click(screen.getByTestId('codex-official-models-refresh-button'))
  await screen.findByText('refresh offline')
  expect(screen.getByTestId('codex-catalog-edit-openai-model-a')).toBeEnabled()
  expect(screen.getByTestId('codex-catalog-restore-openai-model-a')).toBeInTheDocument()
})
