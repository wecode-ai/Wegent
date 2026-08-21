import type { UnifiedModel } from '@/apis/models'
import {
  selectedVisionSidecarRef,
  UNRESOLVED_VISION_SIDECAR_KEY,
  visionSidecarApiFormat,
  visionSidecarModelKey,
  visionSidecarModels,
  visionSidecarRef,
} from '@/features/settings/utils/vision-sidecar-model'

const vision: UnifiedModel = {
  name: 'vision',
  type: 'user',
  namespace: 'default',
  resourceUserId: 42,
  modelCapabilities: { supportsImage: true },
  config: { protocol: 'openai-responses', apiFormat: 'responses' },
}

// Models that only declare env.model are published with a bare runtime family and
// no config.protocol, which is how most public Model CRDs look in practice.
const bareFamilyModel = (family: string): UnifiedModel => ({
  ...vision,
  name: `vision-${family}`,
  config: {},
  runtime: { family },
})

describe('vision sidecar model helpers', () => {
  test('filters to active image-capable models with a supported Wework protocol', () => {
    expect(
      visionSidecarModels(
        [
          vision,
          { ...vision, name: 'text', modelCapabilities: {} },
          { ...vision, name: 'disabled', isActive: false },
          { ...vision, name: 'unsupported', config: { protocol: 'gemini' } },
        ],
        'primary'
      ).map(model => model.name)
    ).toEqual(['vision'])
  })

  test('creates the safe cloud identity consumed by Wework', () => {
    expect(visionSidecarApiFormat(vision)).toBe('openai-responses')
    expect(visionSidecarRef(vision)).toEqual({
      modelName: 'vision',
      modelType: 'user',
      namespace: 'default',
      resourceUserId: 42,
      apiFormat: 'openai-responses',
    })
  })

  test('detects every protocol Wework can drive as a vision sidecar', () => {
    expect(visionSidecarApiFormat(bareFamilyModel('claude'))).toBe('anthropic-messages')
    expect(visionSidecarApiFormat(bareFamilyModel('claude.anthropic-messages'))).toBe(
      'anthropic-messages'
    )
    expect(visionSidecarApiFormat(bareFamilyModel('openai'))).toBe('openai-chat-completions')
    expect(visionSidecarApiFormat(bareFamilyModel('openai.openai-chat-completions'))).toBe(
      'openai-chat-completions'
    )
    expect(visionSidecarApiFormat(bareFamilyModel('openai.openai-responses'))).toBe(
      'openai-responses'
    )
    expect(visionSidecarApiFormat(bareFamilyModel('gemini'))).toBeNull()
  })

  test('accepts the snake_case and wire_api aliases Wework also reads', () => {
    expect(visionSidecarApiFormat({ ...vision, config: { api_format: 'responses' } })).toBe(
      'openai-responses'
    )
    expect(visionSidecarApiFormat({ ...vision, config: { wire_api: 'responses' } })).toBe(
      'openai-responses'
    )
    expect(visionSidecarApiFormat({ ...vision, config: { wire_api: 'chat/completions' } })).toBe(
      'openai-chat-completions'
    )
  })

  test('offers bare-family image models as sidecar candidates', () => {
    const anthropicVision = bareFamilyModel('claude')

    expect(visionSidecarModels([anthropicVision], 'primary').map(model => model.name)).toEqual([
      anthropicVision.name,
    ])
    expect(visionSidecarRef(anthropicVision)).toEqual({
      modelName: anthropicVision.name,
      modelType: 'user',
      namespace: 'default',
      resourceUserId: 42,
      apiFormat: 'anthropic-messages',
    })
  })

  test('prefers Responses when a model declares both a family and a Responses wire format', () => {
    expect(
      visionSidecarApiFormat({
        ...vision,
        config: { apiFormat: 'responses' },
        runtime: { family: 'openai' },
      })
    ).toBe('openai-responses')
  })
})

describe('selectedVisionSidecarRef', () => {
  const unresolvedRef = {
    modelName: 'wecode-claude-weibo-kimi-k2.5',
    modelType: 'public' as const,
    namespace: 'default',
    resourceUserId: 0,
    apiFormat: 'anthropic-messages' as const,
  }

  test('persists the selected candidate', () => {
    expect(selectedVisionSidecarRef(true, visionSidecarModelKey(vision), [vision], null)).toEqual(
      visionSidecarRef(vision)
    )
  })

  test('keeps a configured reference whose target is not selectable', () => {
    expect(
      selectedVisionSidecarRef(true, UNRESOLVED_VISION_SIDECAR_KEY, [vision], unresolvedRef)
    ).toEqual(unresolvedRef)
  })

  test('clears the reference when the sidecar is switched off', () => {
    expect(selectedVisionSidecarRef(true, '', [vision], unresolvedRef)).toBeUndefined()
  })

  test('clears the reference when the model cannot host a sidecar', () => {
    expect(
      selectedVisionSidecarRef(false, UNRESOLVED_VISION_SIDECAR_KEY, [vision], unresolvedRef)
    ).toBeUndefined()
  })
})
