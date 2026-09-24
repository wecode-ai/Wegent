import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ModelConfigurationSnapshot } from '@/features/model-settings/providerModelConfiguration'
import { ProviderSettingsSection } from './ProviderSettingsSection'
import { reloadProviderConfiguration } from '@/features/model-settings/providerModelConfiguration'
import { replaceProviderModelConfigs } from '@/features/model-settings/providerModelState'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invoke,
  subscribeDesktopHostEvents: vi.fn(() => () => {}),
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

let snapshot: ModelConfigurationSnapshot
let discover: () => Promise<string[]>
beforeEach(async () => {
  localStorage.clear()
  replaceProviderModelConfigs([])
  snapshot = {
    path: '/test/model.yml',
    revision: 'one',
    loadedAt: '',
    providers: [
      {
        id: 'relay',
        name: 'My relay',
        base_url: 'https://relay.example/v1',
        api_format: 'openai-responses',
        api_key_configured: true,
        models: [],
      },
    ],
  }
  discover = async () => ['upstream-a', 'upstream-b']
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    if (method === 'modelConfiguration.read') return snapshot
    if (method === 'modelConfiguration.runtime') return { revision: snapshot.revision, models: [] }
    if (method === 'modelConfiguration.save') {
      snapshot = { ...snapshot, revision: 'two', providers: params.providers }
      return snapshot
    }
    if (method === 'modelConfiguration.discover') return discover()
    throw new Error(`Unexpected invocation: ${method}`)
  })
  await reloadProviderConfiguration()
})

async function openEditor() {
  render(<ProviderSettingsSection />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('provider-edit-relay'))
  return user
}

function savedProviders() {
  return invoke.mock.calls.find(call => call[0] === 'modelConfiguration.save')?.[1].providers
}

describe('Provider settings page', () => {
  test('hides file controls, batch input and the extra capabilities gate', async () => {
    await openEditor()
    for (const id of [
      'provider-file-path',
      'provider-file-choose',
      'provider-file-open',
      'provider-file-reload',
      'provider-batch-models',
      'provider-append-models',
      'provider-add-selected',
    ]) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
    expect(screen.queryByText('/test/model.yml')).not.toBeInTheDocument()
  })

  test('adds models individually without re-entering the stored key', async () => {
    const user = await openEditor()
    expect(screen.getByTestId('provider-api-key')).toHaveValue('')
    await user.click(screen.getByTestId('provider-model-add'))
    await user.type(screen.getAllByTestId(/^provider-model-id-/)[0], 'upstream-a')
    await user.click(screen.getByTestId('provider-model-add'))
    await user.type(screen.getAllByTestId(/^provider-model-id-/)[1], 'upstream-b')
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()).toHaveLength(1))
    const provider = savedProviders()[0]
    expect(provider.base_url).toBe('https://relay.example/v1')
    expect(provider.models.map((model: { model_id: string }) => model.model_id)).toEqual([
      'upstream-a',
      'upstream-b',
    ])
    expect(provider.api_key).toBeUndefined()
    expect(invoke.mock.calls.every(call => call[0].startsWith('modelConfiguration.'))).toBe(true)
  })

  test('a new connection can fetch with the current address and key before saving', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-add'))
    expect(screen.getByTestId('provider-discover')).toBeDisabled()
    await user.type(screen.getByTestId('provider-base-url'), 'https://new.example/v1')
    await user.type(screen.getByTestId('provider-api-key'), 'draft-key')
    // Unfinished manual model rows are not part of the discovery request.
    await user.click(screen.getByTestId('provider-model-add'))
    expect(screen.getByTestId('provider-discover')).toBeEnabled()
    await user.click(screen.getByTestId('provider-discover'))
    expect(await screen.findByTestId('provider-discovered-upstream-a')).toBeEnabled()
    expect(invoke).toHaveBeenCalledWith('modelConfiguration.discover', {
      providerId: expect.stringMatching(/^provider-/),
      provider: {
        base_url: 'https://new.example/v1',
        api_key: 'draft-key',
        api_format: 'openai-responses',
        models_path: undefined,
        models_api_key_header: undefined,
      },
    })
    expect(savedProviders()).toBeUndefined()
  })

  test('discovered models are added one click at a time and duplicates are disabled', async () => {
    const user = await openEditor()
    await user.click(screen.getByTestId('provider-discover'))
    await user.click(await screen.findByTestId('provider-discovered-upstream-a'))
    expect(screen.getByTestId('provider-discovered-upstream-a')).toBeDisabled()
    expect(screen.getAllByTestId(/^provider-model-editor-/)).toHaveLength(1)
    await user.click(screen.getByTestId('provider-discovered-upstream-b'))
    expect(screen.getAllByTestId(/^provider-model-editor-/)).toHaveLength(2)
    expect(savedProviders()).toBeUndefined()
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()?.[0].models).toHaveLength(2))
  })

  test('editing a saved connection fetches the new draft rather than old saved settings', async () => {
    const user = await openEditor()
    await user.clear(screen.getByTestId('provider-base-url'))
    await user.type(screen.getByTestId('provider-base-url'), 'https://changed.example/v1')
    await user.type(screen.getByTestId('provider-api-key'), 'replacement-key')
    await user.click(screen.getByTestId('provider-discover'))
    await screen.findByTestId('provider-discovered-upstream-a')
    expect(invoke).toHaveBeenCalledWith(
      'modelConfiguration.discover',
      expect.objectContaining({
        providerId: 'relay',
        provider: expect.objectContaining({
          base_url: 'https://changed.example/v1',
          api_key: 'replacement-key',
        }),
      })
    )
    expect(savedProviders()).toBeUndefined()
    expect(snapshot.providers[0].base_url).toBe('https://relay.example/v1')
  })

  test('context and common capabilities are visible and saved without opening advanced settings', async () => {
    const user = await openEditor()
    await user.click(screen.getByTestId('provider-model-add'))
    const model = within(screen.getByTestId(/^provider-model-editor-/))
    await user.type(model.getByTestId(/^provider-model-id-/), 'upstream-a')
    const context = model.getByTestId('local-model-context-window-input')
    expect(context).toBeVisible()
    expect(context.closest('details')).toBeNull()
    expect(model.queryByTestId(/^provider-model-capabilities-/)).not.toBeInTheDocument()
    await user.click(model.getByTestId('local-model-input-modality-image'))
    await user.click(model.getByTestId('local-model-reasoning-level-high'))
    await user.click(model.getByTestId('local-model-parallel-tools-select'))
    await user.type(context, '128000')
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()).toBeDefined())
    const saved = savedProviders()[0].models[0]
    expect(saved.context_window).toBe(128000)
    expect(saved.catalog_entry.context_window).toBe(128000)
    expect(saved.catalog_entry.max_context_window).toBe(128000)
    expect(saved.catalog_entry.input_modalities).toContain('image')
    expect(saved.catalog_entry.supported_reasoning_levels).toEqual([
      expect.objectContaining({ effort: 'high' }),
    ])
    expect(saved.catalog_entry.supports_parallel_tool_calls).toBe(true)
  })

  test('a late discovery response is discarded when connection settings change', async () => {
    const user = await openEditor()
    let finish!: (value: string[]) => void
    discover = () =>
      new Promise(resolve => {
        finish = resolve
      })
    await user.click(screen.getByTestId('provider-discover'))
    expect(screen.getByTestId('provider-discover')).toBeDisabled()
    await user.type(screen.getByTestId('provider-api-key'), 'new-key')
    expect(screen.getByTestId('provider-discover')).toBeEnabled()
    await act(async () => {
      finish(['stale-model'])
    })
    expect(screen.queryByTestId('provider-discovered-stale-model')).not.toBeInTheDocument()
    discover = async () => ['fresh-model']
    await user.click(screen.getByTestId('provider-discover'))
    expect(await screen.findByTestId('provider-discovered-fresh-model')).toBeEnabled()
  })

  test('discovery errors allow retry and do not erase the draft', async () => {
    const user = await openEditor()
    await user.type(screen.getByTestId('provider-api-key'), 'draft-key')
    discover = async () => {
      throw new Error('Model discovery returned HTTP 401')
    }
    await user.click(screen.getByTestId('provider-discover'))
    expect(await screen.findByTestId('provider-discovery-error')).toHaveTextContent('HTTP 401')
    expect(screen.getByTestId('provider-api-key')).toHaveValue('draft-key')
    expect(screen.getByTestId('provider-model-add')).toBeEnabled()
    discover = async () => []
    await user.click(screen.getByTestId('provider-discover'))
    expect(await screen.findByTestId('provider-discovery-empty')).toBeVisible()
    expect(screen.queryByTestId('provider-discovery-error')).not.toBeInTheDocument()
    expect(savedProviders()).toBeUndefined()
  })

  test('a conflicting external edit keeps the unsaved form visible', async () => {
    const user = await openEditor()
    await user.type(screen.getByTestId('provider-name'), ' changed')
    invoke.mockImplementationOnce(async () => {
      throw new Error('model.yml changed externally. Reload before saving.')
    })
    await user.click(screen.getByTestId('provider-editor-save'))
    expect(await screen.findByTestId('provider-editor-error')).toHaveTextContent(
      'changed externally'
    )
    expect(screen.getByTestId('provider-name')).toHaveValue('My relay changed')
  })

  test('fetching models and cancelling does not create or save a provider', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-add'))
    await user.type(screen.getByTestId('provider-base-url'), 'https://new.example/v1')
    await user.click(screen.getByTestId('provider-discover'))
    await screen.findByTestId('provider-discovered-upstream-a')
    await user.click(screen.getByTestId('provider-editor-cancel'))
    await user.click(screen.getByTestId('provider-discard-confirm'))
    await waitFor(() => expect(screen.queryByTestId('provider-editor')).not.toBeInTheDocument())
    expect(savedProviders()).toBeUndefined()
    expect(snapshot.providers).toHaveLength(1)
  })
})
