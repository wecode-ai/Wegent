import { describe, expect, it } from 'vitest'
import type { ChatSendPayload } from '@/types/api'
import { applyExecutionModelOverride } from './useWorkbenchRuntimeMessaging'

const basePayload: ChatSendPayload = {
  team_id: 1,
  message: 'run',
  force_override_bot_model: 'global-model',
  force_override_bot_model_type: 'runtime',
  model_options: { reasoning: 'medium', collaborationMode: 'default' },
}

describe('applyExecutionModelOverride', () => {
  it('replaces every global model field with the comment execution model', () => {
    const next = applyExecutionModelOverride(basePayload, {
      modelId: 'wecode-moonshot-kimi-k2.7-code-highspeed(公网)',
      modelType: 'runtime',
      modelOptions: {
        reasoning: 'high',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'namespace-1',
      },
    })

    expect(next).toEqual({
      team_id: 1,
      message: 'run',
      force_override_bot_model: 'wecode-moonshot-kimi-k2.7-code-highspeed(公网)',
      force_override_bot_model_type: 'runtime',
      model_options: {
        reasoning: 'high',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'namespace-1',
      },
    })
  })

  it('drops the global model fields when the comment run has no explicit model', () => {
    const next = applyExecutionModelOverride(basePayload, {
      modelId: undefined,
      modelType: undefined,
      modelOptions: { collaborationMode: 'default' },
    })

    expect(next).toEqual({
      team_id: 1,
      message: 'run',
      model_options: { collaborationMode: 'default' },
    })
  })
})
