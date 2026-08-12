import { describe, expect, it } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import {
  harnessLaunchThroughMessagesProxy,
  listLocalHarnessModelOptions,
} from './localHarnessModels'

const localModel: UnifiedModel = {
  name: 'local-model:model-1',
  type: 'runtime',
  provider: 'local',
  displayName: 'Local Model',
  modelId: 'local-upstream',
  config: { weworkModelKind: 'model-interface' },
}

const cloudModel: UnifiedModel = {
  name: 'cloud-model',
  type: 'user',
  provider: 'cloud',
  displayName: 'Cloud Model',
  namespace: 'default',
  resourceUserId: 42,
  config: { protocol: 'openai-responses' },
}

describe('localHarnessModels', () => {
  it('lists the same Wework local and cloud catalog for every harness', () => {
    const models = [localModel, cloudModel]

    expect(listLocalHarnessModelOptions('opencode', models)).toHaveLength(2)
    expect(listLocalHarnessModelOptions('claude_code', models)).toHaveLength(2)
    expect(listLocalHarnessModelOptions('kimi_code', models)).toHaveLength(2)
  })

  it('carries the current Wework model options into harness routing', () => {
    const [option] = listLocalHarnessModelOptions('opencode', [cloudModel], cloudModel, {
      reasoning: 'high',
      speed: 'fast',
    })

    expect(option.options).toEqual({ reasoning: 'high', speed: 'fast' })
  })

  it('routes OpenCode through the local Anthropic Messages endpoint', () => {
    const [option] = listLocalHarnessModelOptions('opencode', [cloudModel])
    const launch = harnessLaunchThroughMessagesProxy('opencode', option, {
      token: 'route-token',
      baseUrl: 'http://127.0.0.1:1234/v1/harness-router/route-token',
    })
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT)

    expect(launch.modelId).toBe('wework-messages/wework-selected')
    expect(launch.proxyToken).toBe('route-token')
    expect(config.provider['wework-messages']).toMatchObject({
      npm: '@ai-sdk/anthropic',
      options: {
        baseURL: 'http://127.0.0.1:1234/v1/harness-router/route-token/v1',
        apiKey: 'wework-local-router',
      },
    })
  })

  it('routes Claude Code through the same local Anthropic Messages endpoint', () => {
    const [option] = listLocalHarnessModelOptions('claude_code', [localModel])
    const launch = harnessLaunchThroughMessagesProxy('claude_code', option, {
      token: 'route-token',
      baseUrl: 'http://127.0.0.1:1234/v1/harness-router/route-token',
    })

    expect(launch).toMatchObject({
      modelId: 'wework-selected',
      proxyToken: 'route-token',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/v1/harness-router/route-token',
        ANTHROPIC_API_KEY: 'wework-local-router',
      },
    })
  })

  it('routes Kimi Code through the same local Anthropic Messages endpoint', () => {
    const modelWithLimits: UnifiedModel = {
      ...localModel,
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
    }
    const [option] = listLocalHarnessModelOptions('kimi_code', [modelWithLimits])
    const launch = harnessLaunchThroughMessagesProxy('kimi_code', option, {
      token: 'route-token',
      baseUrl: 'http://127.0.0.1:1234/v1/harness-router/route-token',
    })

    expect(launch).toEqual({
      modelId: '__kimi_env_model__',
      proxyToken: 'route-token',
      env: {
        KIMI_MODEL_NAME: 'wework-selected',
        KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
        KIMI_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1/harness-router/route-token',
        KIMI_MODEL_API_KEY: 'wework-local-router',
        KIMI_MODEL_DISPLAY_NAME: 'Local Model',
        KIMI_MODEL_MAX_CONTEXT_SIZE: '262144',
        KIMI_MODEL_MAX_OUTPUT_SIZE: '32768',
      },
    })
  })
})
