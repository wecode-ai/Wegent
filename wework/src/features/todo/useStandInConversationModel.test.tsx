import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  cloudRunnerModelIdentity,
  type RunnerModel,
  type WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { UnifiedModel } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useStandInConversationModel } from './useStandInConversationModel'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'

const native: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'gpt-6.1-sol',
  local_model_id: 'gpt-6.1-sol',
  label: 'GPT-6.1 Sol',
  is_default: true,
  default_reasoning_effort: 'low',
  supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
}
const settings: WorkspaceStandInSettings = {
  enabled: true,
  prompt: '',
  version: 1,
  executionDeviceId: 'device',
  model: { runtime: 'codex', provider: 'openai', model_id: native.model_id },
  modelOptions: { reasoning: 'high' },
}

function fixture() {
  return {
    standInApi: { catalog: vi.fn(async () => ({ models: [native] })) },
    modelApi: { listModels: vi.fn(async () => ({ data: [] })) },
  } as unknown as WorkbenchServices
}

it('inherits the saved effort and uses the device default when no model was selected', async () => {
  const services = fixture()
  const { result, rerender } = renderHook(
    ({ value }) => useStandInConversationModel(services, value),
    {
      initialProps: {
        value: { ...settings, model: null, modelOptions: { reasoningEffort: 'high' } },
      },
    }
  )
  expect(result.current.loading).toBe(true)
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.selectedModel?.modelId).toBe(native.local_model_id)
  expect(result.current.selectedModelOptions.reasoning).toBe('high')
  rerender({ value: { ...settings, model: null, modelOptions: {} } })
  expect(result.current.selectedModelOptions.reasoning).toBe('low')
})

it('keeps a temporary choice on equivalent saves and resets it immediately on real changes', async () => {
  const services = fixture()
  const { result, rerender } = renderHook(
    ({ value }) => useStandInConversationModel(services, value),
    { initialProps: { value: settings } }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setSelectedModelOption('reasoning', 'medium'))
  expect(result.current.selectedModelOptions.reasoning).toBe('medium')
  rerender({
    value: {
      ...settings,
      version: 2,
      prompt: 'Other responsibilities',
      modelOptions: { reasoningEffort: 'high' },
    },
  })
  expect(result.current.selectedModelOptions.reasoning).toBe('medium')
  rerender({ value: { ...settings, modelOptions: { reasoning: 'low' } } })
  expect(result.current.selectedModelOptions.reasoning).toBe('low')
  rerender({ value: settings })
  expect(result.current.selectedModelOptions.reasoning).toBe('high')
})

it('does not reuse a temporary selection after the saved native provider changes', async () => {
  const services = fixture()
  vi.mocked(services.standInApi!.catalog).mockResolvedValue({
    models: [native, { ...native, provider: 'other', is_default: false }],
  })
  const { result, rerender } = renderHook(
    ({ value }) => useStandInConversationModel(services, value),
    { initialProps: { value: settings } }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setSelectedModelOption('reasoning', 'low'))
  rerender({ value: { ...settings, model: { ...settings.model!, provider: 'other' } } })
  expect(result.current.selectedModel?.config?.codexProviderId).toBe('other')
  expect(result.current.selectedModelOptions.reasoning).toBe('high')
})

it.each(['deleted', 'empty', 'failed'])(
  'finishes loading an unavailable model after a %s catalog result without replacing it',
  async status => {
    const services = fixture()
    if (status === 'empty') {
      vi.mocked(services.standInApi!.catalog).mockResolvedValue({ models: [] })
    } else if (status === 'failed') {
      vi.mocked(services.standInApi!.catalog).mockRejectedValue(new Error('Catalog failed'))
    }
    const { result } = renderHook(() =>
      useStandInConversationModel(services, {
        ...settings,
        model: { ...settings.model!, provider: 'deleted-provider' },
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unavailable).toBe(true)
    expect(result.current.selectedModel?.modelId).toBe(native.model_id)
    act(() => result.current.setSelectedModelOption('reasoning', 'medium'))
    expect(result.current.unavailable).toBe(true)
    if (status === 'deleted') {
      act(() => result.current.setSelectedModel(result.current.models[0]))
      expect(result.current.unavailable).toBe(false)
      expect(result.current.selectedModel?.runtime?.provider).toBe('openai')
      expect(
        selectedModelExecutionFields(
          result.current.selectedModel,
          result.current.selectedModelOptions
        ).modelOptions?.codexProviderId
      ).toBe('openai')
    }
  }
)

it('blocks sending when an empty catalog has no saved or default model', async () => {
  const services = fixture()
  vi.mocked(services.standInApi!.catalog).mockResolvedValue({ models: [] })
  const { result } = renderHook(() =>
    useStandInConversationModel(services, { ...settings, model: null })
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.unavailable).toBe(true)
  expect(result.current.selectedModel).toBeNull()
})

it('inherits the real cloud model after changing an option on its loading placeholder', async () => {
  const services = fixture()
  const cloud: UnifiedModel = {
    name: 'cloud-gpt',
    modelId: native.model_id,
    type: 'public',
    provider: 'openai',
    namespace: 'default',
    resourceUserId: 7,
    config: { protocol: 'openai-responses', ui: { reasoningEfforts: ['low', 'high'] } },
  }
  let notify!: () => void
  services.modelApi.subscribe = listener => {
    notify = listener
    return () => {}
  }
  const saved = { ...settings, model: cloudRunnerModelIdentity(cloud, 'codex') }
  const before = structuredClone(saved)
  const { result } = renderHook(() => useStandInConversationModel(services, saved))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.models).toHaveLength(1)
  expect(result.current.selectedModel?.type).toBe('runtime')
  expect(result.current.unavailable).toBe(true)
  act(() => result.current.setSelectedModelOption('reasoning', 'low'))
  expect(result.current.unavailable).toBe(true)
  vi.mocked(services.modelApi.listModels).mockResolvedValue({ data: [cloud] })
  await act(async () => notify())
  await waitFor(() => expect(result.current.models).toContain(cloud))
  expect(result.current.selectedModel).toBe(cloud)
  expect(result.current.unavailable).toBe(false)
  expect(
    selectedModelExecutionFields(result.current.selectedModel, result.current.selectedModelOptions)
  ).toMatchObject({
    modelId: cloud.name,
    modelType: 'public',
    modelOptions: {
      reasoning: 'low',
      weworkCloudModelNamespace: 'default',
      weworkCloudModelResourceUserId: '7',
    },
  })
  expect(saved).toEqual(before)
})

it('keeps an explicit temporary model when the saved cloud model arrives later', async () => {
  const services = fixture()
  const cloud: UnifiedModel = {
    name: 'cloud-sol',
    type: 'public',
    modelId: 'late-custom-model',
    provider: 'openai',
    namespace: 'default',
    resourceUserId: 7,
    config: {
      protocol: 'openai-responses',
      ui: { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    },
  }
  const saved = { ...settings, model: cloudRunnerModelIdentity(cloud, 'codex'), modelOptions: {} }
  const { result } = renderHook(() => useStandInConversationModel(services, saved))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.unavailable).toBe(true)
  act(() =>
    result.current.setSelectedModelAndOptions(result.current.models[0], { reasoning: 'medium' })
  )
  const temporary = result.current.selectedModel
  vi.mocked(services.modelApi.listModels).mockResolvedValue({ data: [cloud] })
  act(() => result.current.onModelSelectorOpenChange?.(true))
  await waitFor(() => expect(result.current.models).toContain(cloud))
  expect(result.current.selectedModel).toBe(result.current.models[0])
  expect(result.current.selectedModel).toEqual(temporary)
  expect(result.current.selectedModelOptions.reasoning).toBe('medium')
  expect(result.current.unavailable).toBe(false)
  expect(saved.model).toEqual(cloudRunnerModelIdentity(cloud, 'codex'))
})

it('uses the latest complete cloud identity configuration after a manual selection', async () => {
  const services = fixture()
  const original: UnifiedModel = {
    name: 'shared-cloud-model',
    modelId: native.model_id,
    type: 'public',
    provider: 'openai',
    namespace: 'default',
    resourceUserId: 7,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    config: { protocol: 'openai-responses', ui: { reasoningEfforts: ['low', 'high'] } },
  }
  vi.mocked(services.modelApi.listModels).mockResolvedValue({ data: [original] })
  const { result } = renderHook(() => useStandInConversationModel(services, settings))
  await waitFor(() => expect(result.current.loading).toBe(false))
  act(() => result.current.setSelectedModelAndOptions(original, { reasoning: 'low' }))
  const updated = { ...original, contextWindow: 1_048_576, maxOutputTokens: 96_000 }
  const otherOwner = { ...updated, resourceUserId: 99, contextWindow: 32_000 }
  vi.mocked(services.modelApi.listModels).mockResolvedValue({ data: [otherOwner, updated] })
  act(() => result.current.onModelSelectorOpenChange?.(true))
  await waitFor(() => expect(result.current.models).toContain(updated))
  expect(result.current.selectedModel).toBe(updated)
  expect(result.current.selectedModelOptions.reasoning).toBe('low')
  expect(
    selectedModelExecutionFields(result.current.selectedModel, result.current.selectedModelOptions)
  ).toMatchObject({
    modelId: original.name,
    modelType: 'public',
    modelOptions: {
      reasoning: 'low',
      weworkCloudModelResourceUserId: '7',
      weworkCloudModelContextWindow: '1048576',
      weworkCloudModelMaxOutputTokens: '96000',
    },
  })
  vi.mocked(services.modelApi.listModels).mockResolvedValue({ data: [otherOwner] })
  act(() => result.current.onModelSelectorOpenChange?.(true))
  await waitFor(() => expect(result.current.models).not.toContain(updated))
  expect(result.current.unavailable).toBe(true)
  expect(result.current.selectedModel).not.toBe(otherOwner)
})

it('blocks saved Claude immediately and permits explicit Codex recovery without changing the profile', async () => {
  const services = fixture()
  const claude: RunnerModel = {
    ...native,
    runtime: 'claude_code',
    provider: 'shared-provider',
    model_id: 'same-model',
    local_model_id: 'same-model',
    label: 'Claude Code',
  }
  const codex: RunnerModel = { ...claude, runtime: 'codex', label: 'Codex' }
  const saved = { ...settings, model: claude }
  const before = structuredClone(saved)
  let finish!: (value: { models: RunnerModel[] }) => void
  vi.mocked(services.standInApi!.catalog).mockImplementationOnce(
    () => new Promise(resolve => (finish = resolve))
  )
  const { result } = renderHook(() => useStandInConversationModel(services, saved))
  try {
    expect(result.current.loading).toBe(true)
    expect(result.current.unavailable).toBe(true)
    expect(result.current.unavailableReason).toBe('conversation_runtime_unsupported')
    act(() => result.current.setSelectedModelOption('reasoning', 'medium'))
    expect(result.current.unavailableReason).toBe('conversation_runtime_unsupported')
    await act(async () => finish({ models: [claude, codex, native] }))
    expect(result.current.loading).toBe(false)
    expect(result.current.models.map(model => model.runtime?.family)).toEqual(['codex', 'codex'])
    expect(result.current.selectedModel?.runtime?.family).toBe('claude_code')
    expect(result.current.unavailable).toBe(true)
    expect(result.current.unavailableReason).toBe('conversation_runtime_unsupported')

    act(() => result.current.setSelectedModel(result.current.models[0]))
    expect(result.current.unavailable).toBe(false)
    expect(result.current.unavailableReason).toBeUndefined()
    expect(result.current.selectedModel?.runtime?.family).toBe('codex')
    expect(
      selectedModelExecutionFields(
        result.current.selectedModel,
        result.current.selectedModelOptions
      )
    ).toMatchObject({
      modelId: codex.model_id,
      modelType: 'runtime',
      modelOptions: { codexProviderId: codex.provider },
    })
    expect(saved).toEqual(before)
  } finally {
    await act(async () => finish({ models: [] }))
  }
})

it('allows a Claude cloud model through its saved Codex execution identity', async () => {
  const services = fixture()
  const cloud: UnifiedModel = {
    name: 'claude-api',
    modelId: 'claude-sonnet',
    type: 'public',
    provider: 'anthropic',
    namespace: 'default',
    resourceUserId: 7,
    runtime: { family: 'claude_code' },
    config: { protocol: 'anthropic-messages' },
  }
  vi.mocked(services.modelApi.listModels).mockResolvedValue({ data: [cloud] })
  const { result } = renderHook(() =>
    useStandInConversationModel(services, {
      ...settings,
      model: cloudRunnerModelIdentity(cloud, 'codex'),
    })
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.selectedModel).toBe(cloud)
  expect(result.current.unavailable).toBe(false)
  expect(result.current.unavailableReason).toBeUndefined()
  expect(
    selectedModelExecutionFields(result.current.selectedModel, result.current.selectedModelOptions)
  ).toMatchObject({
    modelId: cloud.name,
    modelType: 'public',
    modelOptions: { weworkCloudModelNamespace: 'default', weworkCloudModelResourceUserId: '7' },
  })
})

it.each([
  ['reasoningEffort', 'reasoning', 'extra_high', 'xhigh', 'high'],
  ['serviceTier', 'speed', 'fast', 'fast', 'standard'],
  ['service_tier', 'speed', 'fast', 'fast', 'standard'],
  ['permission_mode', 'permissionMode', 'read-only', 'read-only', 'workspace-write'],
  ['collaboration_mode', 'collaborationMode', 'single', 'single', 'default'],
])(
  'inherits saved %s before defaults and respects explicit %s',
  async (alias, key, value, expected, explicit) => {
    const services = fixture()
    const saved = { ...settings, modelOptions: { [alias]: value, custom: 'retained' } }
    const { result, rerender } = renderHook(
      ({ value }) => useStandInConversationModel(services, value),
      { initialProps: { value: saved } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    const request = () =>
      selectedModelExecutionFields(
        result.current.selectedModel,
        result.current.selectedModelOptions
      )
    expect(request().modelOptions).toMatchObject({ [key]: expected, custom: 'retained' })
    expect(request().modelOptions).not.toHaveProperty(alias)
    expect(saved.modelOptions).toHaveProperty(alias, value)
    rerender({ value: { ...saved, modelOptions: { ...saved.modelOptions, [key]: explicit } } })
    expect(request().modelOptions?.[key]).toBe(explicit)
  }
)
