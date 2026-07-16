// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { modelApis } from '@/apis/models'
import {
  DEFAULT_MODEL_NAME,
  useModelSelection,
  type Model,
  type TeamWithBotDetails,
} from '@/features/tasks/hooks/useModelSelection'
import {
  getModelFromConfig,
  getModelNamespaceFromConfig,
  getModelTypeFromConfig,
} from '@/features/settings/services/bots'
import { getCompatibleProviderFromAgentType } from '@/utils/modelCompatibility'
import { getGlobalModelPreference } from '@/utils/modelPreferences'

const mockTranslate = (_key: string, fallback?: string) => fallback ?? _key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockTranslate,
  }),
}))

jest.mock('@/apis/models', () => ({
  modelApis: {
    getUnifiedModels: jest.fn(),
  },
}))

jest.mock('@/features/settings/services/bots', () => ({
  isPredefinedModel: jest.fn(() => false),
  getModelFromConfig: jest.fn(() => null),
  getModelNamespaceFromConfig: jest.fn(() => undefined),
  getModelTypeFromConfig: jest.fn(() => undefined),
  getAllowedModelsFromConfig: jest.fn(() => []),
}))

jest.mock('@/utils/modelCompatibility', () => ({
  getCompatibleProviderFromAgentType: jest.fn(() => null),
}))

jest.mock('@/utils/modelPreferences', () => ({
  getGlobalModelPreference: jest.fn(() => null),
  saveGlobalModelPreference: jest.fn(),
}))

const mockModel: Model = {
  name: 'claude-3-5-sonnet',
  displayName: 'Claude 3.5 Sonnet',
  provider: 'anthropic',
  modelId: 'claude-3-5-sonnet-20241022',
  type: 'public',
}

const mockAdvancedModel: Model = {
  name: 'claude-opus-4-advanced',
  displayName: 'Claude Opus 4 Advanced',
  provider: 'anthropic',
  modelId: 'claude-opus-4-advanced',
  type: 'public',
  isAdvanced: true,
}

const mockOpenAIAdvancedModel: Model = {
  name: 'gpt-5-advanced',
  displayName: 'GPT-5 Advanced',
  provider: 'openai',
  modelId: 'gpt-5-advanced',
  type: 'public',
  isAdvanced: true,
}

const mockTeam: TeamWithBotDetails = {
  id: 1,
  name: 'chat-team',
  namespace: 'default',
  displayName: 'Chat Team',
  description: '',
  icon: '',
  agent_type: 'chat',
  is_mix_team: false,
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  bots: [],
}

function mockDeferredModelLoad() {
  let resolveModels!: (value: { data: Model[] }) => void
  const promise = new Promise<{ data: Model[] }>(resolve => {
    resolveModels = resolve
  })
  ;(modelApis.getUnifiedModels as jest.Mock).mockReturnValue(promise)
  return {
    async resolve() {
      await act(async () => {
        resolveModels({ data: [mockModel] })
        await promise
      })
    },
  }
}

async function renderModelSelectionHook() {
  const modelLoad = mockDeferredModelLoad()
  const hook = renderHook(() =>
    useModelSelection({
      teamId: 1,
      taskId: null,
      selectedTeam: mockTeam,
    })
  )

  await modelLoad.resolve()

  await waitFor(() => {
    expect(hook.result.current.models).toHaveLength(1)
    expect(hook.result.current.isLoading).toBe(false)
  })

  return hook
}

function mockDeferredModelsLoad(models: Model[]) {
  let resolveModels!: (value: { data: Model[] }) => void
  const promise = new Promise<{ data: Model[] }>(resolve => {
    resolveModels = resolve
  })
  ;(modelApis.getUnifiedModels as jest.Mock).mockReturnValue(promise)
  return {
    async resolve() {
      await act(async () => {
        resolveModels({ data: models })
        await promise
      })
    },
  }
}

describe('useModelSelection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(getModelFromConfig as jest.Mock).mockReturnValue(null)
    ;(getModelTypeFromConfig as jest.Mock).mockReturnValue(undefined)
    ;(getModelNamespaceFromConfig as jest.Mock).mockReturnValue(undefined)
    ;(getGlobalModelPreference as jest.Mock).mockReturnValue(null)
  })

  it('selects concrete models as force override without showing override text', async () => {
    const { result } = await renderModelSelectionHook()

    act(() => {
      result.current.selectModel(mockModel)
    })

    expect(result.current.forceOverride).toBe(true)
    expect(result.current.getDisplayText()).toBe('Claude 3.5 Sonnet')
  })

  it('does not force override when selecting the default model', async () => {
    const { result } = await renderModelSelectionHook()

    act(() => {
      result.current.selectModel({
        name: DEFAULT_MODEL_NAME,
        provider: '',
        modelId: '',
      })
    })

    expect(result.current.forceOverride).toBe(false)
  })

  it('resolves the concrete bot preset model from bot config', async () => {
    ;(getModelFromConfig as jest.Mock).mockReturnValue(mockAdvancedModel.name)
    ;(getModelTypeFromConfig as jest.Mock).mockReturnValue(mockAdvancedModel.type)
    ;(getModelNamespaceFromConfig as jest.Mock).mockReturnValue(undefined)
    const teamWithBotModel: TeamWithBotDetails = {
      ...mockTeam,
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            agent_config: { bind_model: mockAdvancedModel.name },
          },
        },
      ],
    } satisfies TeamWithBotDetails

    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    let resolveModels!: (value: { data: Model[] }) => void
    const promise = new Promise<{ data: Model[] }>(resolve => {
      resolveModels = resolve
    })
    ;(modelApis.getUnifiedModels as jest.Mock).mockReturnValue(promise)

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: null,
        selectedTeam: teamWithBotModel,
      })
    )

    await act(async () => {
      resolveModels({ data: [mockAdvancedModel] })
      await promise
    })

    await waitFor(() => {
      expect(result.current.boundDefaultModel).toEqual(mockAdvancedModel)
    })
  })

  it('selects an advanced bot preset model when restoring a new chat team', async () => {
    ;(getModelFromConfig as jest.Mock).mockReturnValue(mockAdvancedModel.name)
    ;(getModelTypeFromConfig as jest.Mock).mockReturnValue(mockAdvancedModel.type)
    ;(getModelNamespaceFromConfig as jest.Mock).mockReturnValue(undefined)
    const teamWithAdvancedBotModel: TeamWithBotDetails = {
      ...mockTeam,
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            agent_config: { bind_model: mockAdvancedModel.name },
          },
        },
      ],
    } satisfies TeamWithBotDetails

    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    const modelLoad = mockDeferredModelsLoad([mockModel, mockAdvancedModel])

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: null,
        selectedTeam: teamWithAdvancedBotModel,
      })
    )

    await modelLoad.resolve()

    await waitFor(() => {
      expect(result.current.selectedModel).toEqual(expect.objectContaining(mockAdvancedModel))
    })
    expect(result.current.forceOverride).toBe(false)
    expect(result.current.showAdvancedModels).toBe(true)
    expect(result.current.filteredModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining(mockAdvancedModel),
        expect.objectContaining(mockModel),
      ])
    )
  })

  it('uses the configured model type when restoring an advanced bot preset model', async () => {
    const regularSharedModel: Model = {
      name: 'same-model',
      displayName: 'Same Model',
      provider: 'anthropic',
      modelId: 'same-model-regular',
      type: 'public',
      isAdvanced: false,
    }
    const advancedUserModel: Model = {
      name: 'same-model',
      displayName: 'Same Model',
      provider: 'anthropic',
      modelId: 'same-model-advanced',
      type: 'user',
      namespace: 'default',
      isAdvanced: true,
    }
    ;(getModelFromConfig as jest.Mock).mockReturnValue(advancedUserModel.name)
    ;(getModelTypeFromConfig as jest.Mock).mockReturnValue(advancedUserModel.type)
    ;(getModelNamespaceFromConfig as jest.Mock).mockReturnValue(advancedUserModel.namespace)
    const teamWithAdvancedBotModel: TeamWithBotDetails = {
      ...mockTeam,
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            agent_config: {
              bind_model: advancedUserModel.name,
              bind_model_type: advancedUserModel.type,
              bind_model_namespace: advancedUserModel.namespace,
            },
          },
        },
      ],
    } satisfies TeamWithBotDetails

    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    const modelLoad = mockDeferredModelsLoad([regularSharedModel, advancedUserModel])

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: null,
        selectedTeam: teamWithAdvancedBotModel,
      })
    )

    await modelLoad.resolve()

    await waitFor(() => {
      expect(result.current.selectedModel).toEqual(expect.objectContaining(advancedUserModel))
    })
    expect(result.current.showAdvancedModels).toBe(true)
    expect(result.current.filteredModels).toContainEqual(expect.objectContaining(advancedUserModel))
  })

  it('restores advanced model from team preference and opens advanced model mode', async () => {
    ;(getGlobalModelPreference as jest.Mock).mockReturnValue({
      modelName: mockAdvancedModel.name,
      modelType: mockAdvancedModel.type,
      forceOverride: true,
      updatedAt: Date.now(),
    })
    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    const modelLoad = mockDeferredModelsLoad([mockModel, mockAdvancedModel])

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: null,
        selectedTeam: mockTeam,
      })
    )

    await modelLoad.resolve()

    await waitFor(() => {
      expect(result.current.selectedModel).toEqual(expect.objectContaining(mockAdvancedModel))
    })
    expect(result.current.showAdvancedModels).toBe(true)
    expect(result.current.filteredModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining(mockAdvancedModel),
        expect.objectContaining(mockModel),
      ])
    )
  })

  it('keeps advanced task model selection and opens advanced model mode', async () => {
    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    const modelLoad = mockDeferredModelsLoad([mockModel, mockAdvancedModel])

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: 100,
        taskModelId: mockAdvancedModel.name,
        selectedTeam: mockTeam,
      })
    )

    await modelLoad.resolve()

    await waitFor(() => {
      expect(result.current.selectedModel).toEqual(expect.objectContaining(mockAdvancedModel))
    })

    await act(async () => {})

    expect(result.current.selectedModel).toEqual(expect.objectContaining(mockAdvancedModel))
    expect(result.current.showAdvancedModels).toBe(true)
    expect(result.current.filteredModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining(mockAdvancedModel),
        expect.objectContaining(mockModel),
      ])
    )
  })

  it('shows advanced models when every compatible model is advanced', async () => {
    ;(getCompatibleProviderFromAgentType as jest.Mock).mockReturnValue(['openai'])
    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    const modelLoad = mockDeferredModelsLoad([mockModel, mockOpenAIAdvancedModel])
    const agnoTeam: TeamWithBotDetails = {
      ...mockTeam,
      agent_type: 'agno',
    }

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: null,
        selectedTeam: agnoTeam,
      })
    )

    await modelLoad.resolve()

    await waitFor(() => {
      expect(result.current.filteredModels).toEqual([
        expect.objectContaining(mockOpenAIAdvancedModel),
      ])
    })
    expect(result.current.showAdvancedModels).toBe(true)
  })

  it('filters OpenAI models out for ClaudeCode-compatible teams', async () => {
    ;(getCompatibleProviderFromAgentType as jest.Mock).mockReturnValue(['claude', 'anthropic'])
    ;(modelApis.getUnifiedModels as jest.Mock).mockReset()
    const modelLoad = mockDeferredModelsLoad([mockModel, mockOpenAIAdvancedModel])
    const claudeCodeTeam: TeamWithBotDetails = {
      ...mockTeam,
      agent_type: 'claude',
    }

    const { result } = renderHook(() =>
      useModelSelection({
        teamId: 1,
        taskId: null,
        selectedTeam: claudeCodeTeam,
      })
    )

    await modelLoad.resolve()

    await waitFor(() => {
      expect(result.current.filteredModels).toEqual([expect.objectContaining(mockModel)])
    })
  })
})
