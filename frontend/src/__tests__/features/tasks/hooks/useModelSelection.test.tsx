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

const mockTeam: TeamWithBotDetails = {
  id: 1,
  name: 'chat-team',
  namespace: 'default',
  display_name: 'Chat Team',
  description: '',
  icon: '',
  agent_type: 'chat',
  is_mix_team: false,
  bots: [],
} as TeamWithBotDetails

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

describe('useModelSelection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
})
