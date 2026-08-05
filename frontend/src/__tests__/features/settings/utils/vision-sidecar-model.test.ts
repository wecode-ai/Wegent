import type { UnifiedModel } from '@/apis/models'
import {
  visionSidecarApiFormat,
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
})
