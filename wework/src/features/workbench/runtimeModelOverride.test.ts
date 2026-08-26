import { describe, expect, it } from 'vitest'
import { applyExecutionModelOverride } from './useWorkbenchRuntimeMessaging'

const baseIntent = {
  projectId: 1,
  message: 'run',
  modelId: 'global-model',
  modelType: 'runtime' as const,
  modelOptions: { reasoning: 'medium', collaborationMode: 'default' },
}

describe('applyExecutionModelOverride', () => {
  it('replaces every global model field with the comment execution model', () => {
    const next = applyExecutionModelOverride(baseIntent, {
      modelId: 'wecode-moonshot-kimi-k2.7-code-highspeed(公网)',
      modelType: 'runtime',
      modelOptions: {
        reasoning: 'high',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'namespace-1',
      },
    })

    expect(next).toEqual({
      projectId: 1,
      message: 'run',
      modelId: 'wecode-moonshot-kimi-k2.7-code-highspeed(公网)',
      modelType: 'runtime',
      modelOptions: {
        reasoning: 'high',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'namespace-1',
      },
    })
  })

  it('drops the global model fields when the comment run has no explicit model', () => {
    const next = applyExecutionModelOverride(baseIntent, {
      modelId: undefined,
      modelType: undefined,
      modelOptions: { collaborationMode: 'default' },
    })

    expect(next).toEqual({
      projectId: 1,
      message: 'run',
      modelOptions: { collaborationMode: 'default' },
    })
  })
})
