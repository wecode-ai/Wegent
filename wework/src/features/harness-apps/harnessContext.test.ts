import { describe, expect, it } from 'vitest'
import type { User, UnifiedModel } from '@/types/api'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import { buildHarnessModelContext, buildHarnessUserContext } from './harnessContext'

const user: User = {
  id: 123,
  user_name: 'zhangsan',
  email: 'user@example.com',
  preferences: {
    mcp_provider_keys: {
      privateProvider: 'secret',
    },
  },
}

const model: UnifiedModel = {
  name: 'cloud-model',
  type: 'user',
  provider: 'cloud',
  displayName: 'Cloud Model',
  modelId: 'deepseek-chat',
  namespace: 'default',
  resourceUserId: 42,
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  config: {
    apiKey: 'provider-secret',
    protocol: 'anthropic-messages',
  },
}

describe('harnessContext', () => {
  it('builds a minimal user context without preferences or credentials', () => {
    expect(buildHarnessUserContext(user, 'cloud')).toEqual({
      id: 123,
      userName: 'zhangsan',
      displayName: 'zhangsan',
      email: 'user@example.com',
      mode: 'cloud',
    })
  })

  it('builds model metadata without provider credentials', () => {
    const [option] = listLocalHarnessModelOptions('opencode', [model])

    expect(buildHarnessModelContext(option)).toEqual({
      runtimeModelId: 'deepseek-chat',
      displayName: 'Cloud Model',
      modelType: 'user',
      namespace: 'default',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {},
    })
  })
})
