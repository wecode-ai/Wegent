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
        ANTHROPIC_AUTH_TOKEN: 'wework-local-router',
      },
    })
  })
})
