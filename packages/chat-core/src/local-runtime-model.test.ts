import { describe, expect, it } from 'vitest'
import {
  applyRuntimeModelOptionValues,
  CLOUD_MODEL_CODEX_REQUEST_MODE_OPTION,
  CLOUD_MODEL_NAMESPACE_OPTION,
  CLOUD_MODEL_RESOURCE_USER_ID_OPTION,
  CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION,
  CLOUD_MODEL_VISION_SIDECAR_OPTION,
  normalizeModelOptionAliases,
  resolveLocalRuntimeModelConfig,
  runtimeReasoningConfig,
} from './local-runtime-model'

const cloudInput = {
  runtime: 'codex',
  modelName: 'shared-cloud-model',
  modelType: 'group',
  modelOptions: {
    [CLOUD_MODEL_NAMESPACE_OPTION]: 'team',
    [CLOUD_MODEL_RESOURCE_USER_ID_OPTION]: '17',
  },
  cloudModelGateway: {
    baseUrl: 'https://wegent.example/api/runtime-work/llm-responses-proxy',
    apiKey: 'test-session-token',
  },
}

describe('local runtime model configuration', () => {
  it('routes a Wegent model through its gateway with authoritative resource identity', () => {
    expect(resolveLocalRuntimeModelConfig(cloudInput)).toMatchObject({
      model_id: 'shared-cloud-model',
      api_key: 'test-session-token',
      base_url: cloudInput.cloudModelGateway.baseUrl,
      codex_responses_compat_proxy: true,
      default_headers: {
        'X-Wegent-Model-Type': 'group',
        'X-Wegent-Model-Namespace': 'team',
        'X-Wegent-Model-User-Id': '17',
        'X-Wegent-Upstream-Header-wecode-executor': 'codex',
      },
      runtime_config: { codex: { use_user_config: false, configured: true } },
    })
  })

  it('keeps native Codex login and provider configuration separate from Wegent credentials', () => {
    const config = resolveLocalRuntimeModelConfig({
      ...cloudInput,
      modelType: null,
      modelName: 'native-model',
      modelOptions: {
        codexProviderId: 'openai',
        codexProviderType: 'official',
      },
    })
    expect(config).toMatchObject({
      model_id: 'native-model',
      model_provider: 'openai',
      wework_model_kind: 'codex-official',
      runtime_config: { codex: { use_user_config: true, configured: true } },
    })
    expect(config).not.toHaveProperty('api_key')
    expect(config).not.toHaveProperty('base_url')
  })

  it('rejects missing cloud identity and incompatible native passthrough protocols', () => {
    expect(() =>
      resolveLocalRuntimeModelConfig({
        ...cloudInput,
        cloudModelGateway: undefined,
      })
    ).toThrow('Cloud model gateway is not configured')
    expect(() => resolveLocalRuntimeModelConfig({ ...cloudInput, modelOptions: {} })).toThrow(
      'Cloud model identity is incomplete'
    )
    expect(() =>
      resolveLocalRuntimeModelConfig({
        ...cloudInput,
        modelOptions: {
          ...cloudInput.modelOptions,
          [CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION]: 'anthropic-messages',
          [CLOUD_MODEL_CODEX_REQUEST_MODE_OPTION]: 'passthrough',
        },
      })
    ).toThrow('Invalid Codex request mode')
  })

  it('routes a vision sidecar using its own cloud resource identity', () => {
    const config = resolveLocalRuntimeModelConfig({
      ...cloudInput,
      modelOptions: {
        ...cloudInput.modelOptions,
        [CLOUD_MODEL_VISION_SIDECAR_OPTION]: JSON.stringify({
          modelName: 'image-model',
          modelType: 'public',
          namespace: 'default',
          resourceUserId: 0,
          apiFormat: 'anthropic-messages',
        }),
      },
    })
    expect(config.vision_sidecar).toMatchObject({
      request_url: `${cloudInput.cloudModelGateway.baseUrl}/responses`,
      model_id: 'image-model',
      api_format: 'anthropic-messages',
      default_headers: {
        'X-Wegent-Model-Type': 'public',
        'X-Wegent-Model-Namespace': 'default',
        'X-Wegent-Model-User-Id': '0',
      },
    })
    expect(() =>
      resolveLocalRuntimeModelConfig({
        ...cloudInput,
        modelOptions: {
          ...cloudInput.modelOptions,
          [CLOUD_MODEL_VISION_SIDECAR_OPTION]: '{}',
        },
      })
    ).toThrow('Cloud vision sidecar reference is invalid')
  })

  it('preserves model defaults and applies normalized options without mutating shared configuration', () => {
    const config = Object.freeze({
      model_id: 'native-model',
      reasoning: { effort: 'medium' },
    })
    const options = {
      reasoning: 'extra high',
      summary: 'detailed',
      speed: 'fast',
    }
    expect(applyRuntimeModelOptionValues(config, options)).toEqual({
      model_id: 'native-model',
      reasoning: { effort: 'xhigh', summary: 'detailed' },
      service_tier: 'fast',
    })
    expect(config.reasoning).toEqual({ effort: 'medium' })
    expect(applyRuntimeModelOptionValues(config)).toEqual(config)
    expect(runtimeReasoningConfig()).toBeNull()
    expect(normalizeModelOptionAliases({ reasoning: 'maximum', speed: 'fast' })).toEqual({
      reasoning: 'max',
      speed: 'fast',
    })
  })

  it('preserves Claude gateway routing and explicit runner providers', () => {
    const claude = resolveLocalRuntimeModelConfig({
      ...cloudInput,
      runtime: 'claude_code',
    })
    expect(claude.default_headers).toMatchObject({
      'X-Wegent-Upstream-Header-wecode-executor': 'claudecode',
    })
    expect(claude).not.toHaveProperty('codex_responses_compat_proxy')
    expect(
      resolveLocalRuntimeModelConfig({
        runtime: 'codex',
        modelName: 'runner-model',
        modelOptions: { runnerModelProvider: 'runner' },
      })
    ).toEqual({ model_id: 'runner-model', model_provider: 'runner' })
  })
})
