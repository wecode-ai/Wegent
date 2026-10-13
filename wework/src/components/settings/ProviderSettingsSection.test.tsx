import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ModelConfigurationSnapshot } from '@/features/model-settings/providerModelConfiguration'
import { ProviderSettingsSection } from './ProviderSettingsSection'
import { reloadProviderConfiguration } from '@/features/model-settings/providerModelConfiguration'
import { replaceProviderModelConfigs } from '@/features/model-settings/providerModelState'
import { findLocalModelProviderProfile } from '@/features/model-settings/localModelProviders'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import { saveLocalModelConfig } from '@/features/model-settings/localModelSettings'

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
  test('connection testing is available only inside the model editor', async () => {
    const user = await openEditor()
    expect(screen.queryByTestId('provider-test-relay')).toBeNull()
    expect(screen.getByTestId('provider-editor-test')).toBeDisabled()
    await user.click(screen.getByTestId('provider-model-add'))
    const input = document.querySelector('[data-testid^="provider-model-id-"]')!
    await user.type(input, 'upstream-a')
    expect(screen.getByTestId('provider-editor-test')).toBeEnabled()
    expect(savedProviders()).toBeUndefined()
  })
  test.each(['success', 'failure'])(
    'waits for a superseding catalog refresh before completing a deletion: %s',
    async outcome => {
      snapshot.providers[0].models = [{ id: 'deleted', model_id: 'deleted-model' }]
      await reloadProviderConfiguration()
      const user = await openEditor()
      const original = invoke.getMockImplementation()!
      const releases: Array<() => void> = []
      invoke.mockImplementation(async (method, params) => {
        if (method === 'modelConfiguration.runtime' && snapshot.revision === 'two') {
          const requestIndex = releases.length
          await new Promise<void>(resolve => releases.push(resolve))
          if (requestIndex === 1 && outcome === 'failure') throw new Error('Refresh failed')
        }
        return original(method, params)
      })
      await user.click(screen.getByTestId('provider-model-remove-deleted'))
      await user.click(screen.getByTestId('provider-editor-save'))
      await waitFor(() => expect(releases).toHaveLength(1))
      const newerRefresh = reloadProviderConfiguration()
      await waitFor(() => expect(releases).toHaveLength(2))
      await act(async () => releases[0]())
      expect(screen.getByTestId('provider-editor')).toBeInTheDocument()
      expect(screen.getByTestId('provider-model-deleted')).toBeInTheDocument()
      await act(async () => {
        releases[1]()
        await newerRefresh
      })
      if (outcome === 'success') {
        await waitFor(() => expect(screen.queryByTestId('provider-editor')).not.toBeInTheDocument())
        expect(screen.queryByTestId('provider-model-deleted')).not.toBeInTheDocument()
      } else {
        expect(screen.getByTestId('provider-editor')).toBeInTheDocument()
        expect(screen.getByTestId('provider-editor-error')).toHaveTextContent('Refresh failed')
        expect(screen.getByTestId('provider-model-deleted')).toBeInTheDocument()
      }
    }
  )

  test('DeepSeek only needs a key and preserves the preset runtime settings', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-add'))
    await user.selectOptions(screen.getByTestId('provider-preset'), 'deepseek')
    expect(screen.queryByTestId('provider-base-url')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-protocol')).not.toBeInTheDocument()
    expect(screen.getByTestId('provider-discover')).toBeDisabled()
    const profile = findLocalModelProviderProfile('deepseek')
    const modelId = profile.allowedModelIds![0]
    discover = async () => [modelId, 'unsupported-model']
    await user.type(screen.getByTestId('provider-api-key'), 'deepseek-test-key')
    await user.click(screen.getByTestId('provider-discover'))
    expect(screen.queryByTestId('provider-discovered-unsupported-model')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId(`provider-discovered-${modelId}`))
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()).toHaveLength(2))
    expect(savedProviders()[1]).toEqual(
      expect.objectContaining({
        base_url: profile.baseUrl,
        api_format: profile.apiFormat,
        request_path: profile.requestPath,
        api_key: 'deepseek-test-key',
        models: [
          expect.objectContaining({
            model_id: modelId,
            provider_profile_id: 'deepseek',
            context_window: profile.contextWindow,
            tool_profile: profile.toolProfile,
            web_search_mode: profile.webSearchMode,
          }),
        ],
      })
    )
  })

  test('custom endpoint is the last service option and switching services invalidates discovery', async () => {
    render(<ProviderSettingsSection />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('provider-add'))
    expect(within(screen.getByTestId('provider-preset')).getAllByRole('option').at(-1)).toHaveValue(
      'custom'
    )
    await user.selectOptions(screen.getByTestId('provider-preset'), 'deepseek')
    await user.type(screen.getByTestId('provider-api-key'), 'draft-key')
    let finish!: (value: string[]) => void
    discover = () =>
      new Promise(resolve => {
        finish = resolve
      })
    await user.click(screen.getByTestId('provider-discover'))
    await user.selectOptions(screen.getByTestId('provider-preset'), 'custom')
    expect(screen.getByTestId('provider-base-url')).toHaveValue('')
    expect(screen.getByTestId('provider-api-key')).toHaveValue('')
    await act(async () => finish(['stale-model']))
    expect(screen.queryByTestId('provider-discovered-stale-model')).not.toBeInTheDocument()
  })

  test('selected models can be unchecked without saving and the modal restores trigger focus', async () => {
    const user = await openEditor()
    expect(screen.getByTestId('provider-editor')).toHaveAttribute('role', 'dialog')
    await user.click(screen.getByTestId('provider-discover'))
    await user.click(await screen.findByTestId('provider-discovered-upstream-a'))
    expect(screen.getByTestId('provider-discovered-upstream-a')).toBeChecked()
    await user.click(screen.getByTestId('provider-discovered-upstream-a'))
    expect(screen.queryByTestId(/^provider-model-editor-/)).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('provider-editor')).not.toBeInTheDocument())
    expect(screen.getByTestId('provider-edit-relay')).toHaveFocus()
    expect(savedProviders()).toBeUndefined()
  })

  test('keeps a provider with a missing device key editable and allows replacement', async () => {
    snapshot.providers[0].api_key_ref = 'wework-model-key.missing'
    snapshot.providers[0].api_key_configured = false
    await reloadProviderConfiguration()
    const user = await openEditor()
    expect(screen.getByTestId('provider-api-key')).toBeEnabled()
    await user.type(screen.getByTestId('provider-api-key'), 'replacement-key')
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()?.[0].api_key).toBe('replacement-key'))
    expect(screen.queryByTestId('provider-settings-error')).not.toBeInTheDocument()
  })

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
    await user.selectOptions(screen.getByTestId('provider-preset'), 'custom')
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
    expect(screen.getByTestId('provider-discovered-upstream-a')).toBeChecked()
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
    expect(context.closest('details')).toHaveAttribute('open')
    expect(model.queryByTestId(/^provider-model-capabilities-/)).not.toBeInTheDocument()
    await user.click(model.getByTestId('local-model-input-modality-image'))
    await user.click(model.getByTestId('local-model-reasoning-level-high'))
    await user.click(model.getByTestId('local-model-parallel-tools-select'))
    await user.type(context, '128000')
    const output = model.getByTestId('local-model-max-output-tokens-input')
    expect(output).toBeVisible()
    await user.type(output, '16000')
    expect(
      (model.getByTestId('local-model-base-instructions-input') as HTMLTextAreaElement).value
    ).toContain('# Working with the user')
    await user.selectOptions(model.getByTestId('local-model-default-reasoning-input'), 'high')
    await user.click(model.getByTestId(/^provider-model-image-generation-/))
    await user.selectOptions(model.getByTestId(/^provider-model-web-search-/), 'live')
    await user.click(model.getByTestId('local-model-advanced-capabilities-toggle'))
    await user.selectOptions(
      screen.getByTestId('local-model-codex-tool-compatibility-select'),
      'standard'
    )
    await user.click(screen.getByTestId('local-model-advanced-section-metadata'))
    await user.type(screen.getByTestId('local-model-speed-tiers-input'), 'fast')
    await user.click(screen.getByTestId('local-model-speed-tiers-add'))
    await user.click(screen.getByTestId('local-model-service-tiers-add'))
    await user.type(screen.getByTestId('local-model-service-tiers-0-id'), 'priority')
    await user.type(screen.getByTestId('local-model-service-tiers-0-name'), 'Priority')
    await user.type(
      screen.getByTestId('local-model-service-tiers-0-description'),
      'Faster requests'
    )
    await user.selectOptions(
      screen.getByTestId('local-model-default-service-tier-input'),
      'priority'
    )
    await user.click(screen.getByTestId('local-model-advanced-capabilities-close'))
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()).toBeDefined())
    const saved = savedProviders()[0].models[0]
    expect(saved.context_window).toBe(128000)
    expect(saved.max_output_tokens).toBe(16000)
    expect(saved.catalog_entry.context_window).toBe(128000)
    expect(saved.catalog_entry.max_context_window).toBe(128000)
    expect(saved.catalog_entry.input_modalities).toContain('image')
    expect(saved.catalog_entry.supported_reasoning_levels).toEqual([
      expect.objectContaining({ effort: 'high' }),
    ])
    expect(saved.catalog_entry.supports_parallel_tool_calls).toBe(true)
    expect(saved).toMatchObject({
      image_generation_enabled: true,
      web_search_mode: 'live',
      codex_tool_compatibility: 'standard',
    })
    expect(saved.catalog_entry).toMatchObject({
      default_reasoning_level: 'high',
      service_tiers: [{ id: 'priority', name: 'Priority', description: 'Faster requests' }],
      additional_speed_tiers: ['fast'],
      default_service_tier: 'priority',
    })
    expect(saved.catalog_entry.base_instructions).toContain('# Rules for getting work done')
  })

  test.each(['kimi-coding', 'minimax', 'minimax-global'])(
    '%s discovers and saves models with managed endpoint and capability defaults',
    async preset => {
      const profile = findLocalModelProviderProfile(preset)
      const modelId = preset === 'kimi-coding' ? 'k3' : 'MiniMax-M2.7'
      discover = async () => [modelId]
      render(<ProviderSettingsSection />)
      const user = userEvent.setup()
      await user.click(await screen.findByTestId('provider-add'))
      expect(screen.getByTestId('provider-preset')).toHaveValue('')
      await user.selectOptions(screen.getByTestId('provider-preset'), preset)
      await user.type(screen.getByTestId('provider-api-key'), 'test-key')
      await user.click(screen.getByTestId('provider-discover'))
      await user.click(await screen.findByTestId(`provider-discovered-${modelId}`))
      await user.click(screen.getByTestId('provider-editor-save'))
      await waitFor(() => expect(savedProviders()).toHaveLength(2))
      expect(invoke).toHaveBeenCalledWith(
        'modelConfiguration.discover',
        expect.objectContaining({
          provider: expect.objectContaining({
            base_url: profile.modelsBaseUrl ?? profile.baseUrl,
            api_format: profile.apiFormat,
            models_path: profile.modelsPath,
            models_api_key_header: profile.modelsApiKeyHeader,
          }),
        })
      )
      expect(savedProviders()[1]).toMatchObject({
        base_url: profile.baseUrl,
        request_path: profile.requestPath,
        models: [
          expect.objectContaining({
            model_id: modelId,
            provider_profile_id: preset,
            context_window:
              profile.modelDefaults?.[modelId]?.contextWindow ?? profile.contextWindow,
          }),
        ],
      })
    }
  )

  test('offers image models as vision proxies and preserves the selected model ID', async () => {
    const entry = createDefaultLocalModelCatalogEntry({
      id: 'vision',
      displayName: 'Vision Model',
      toolProfile: 'custom',
    })
    entry.input_modalities = ['text', 'image']
    const user = await openEditor()
    saveLocalModelConfig({
      id: 'vision',
      providerProfileId: 'custom',
      displayName: 'Vision Model',
      modelId: 'vision-model',
      baseUrl: 'https://vision.example/v1',
      catalogEntry: entry,
      enabled: true,
    })
    await user.click(screen.getByTestId('provider-model-add'))
    await user.type(screen.getByTestId(/^provider-model-id-/), 'text-model')
    const visionSelect = screen.getByTestId(/^provider-model-vision-/)
    expect(visionSelect).toHaveTextContent('Vision Model')
    await user.selectOptions(visionSelect, 'vision')
    await user.click(screen.getByTestId('provider-editor-save'))
    await waitFor(() => expect(savedProviders()).toBeDefined())
    expect(savedProviders()[0].models[0].vision_model_config_id).toBe('vision')
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
    await user.selectOptions(screen.getByTestId('provider-preset'), 'custom')
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
