import { describe, expect, it } from 'vitest'
import type { ModelSelectionConfig } from '@/types/api'
import { runtimeTaskBindingAddress } from './runtimeTaskBindingAddress'

describe('runtimeTaskBindingAddress', () => {
  it('carries the bound agent model and full resource identity into its conversation', () => {
    const modelSelection: ModelSelectionConfig = {
      modelName: 'deepseek-v4-pro-responses(公网)',
      modelType: 'public',
      options: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
        weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-pro',
      },
    }

    expect(
      runtimeTaskBindingAddress({
        device_id: 'remote-device',
        task_id: 'codex-queue-85',
        modelSelection,
      })
    ).toEqual({
      deviceId: 'remote-device',
      taskId: 'codex-queue-85',
      runtimeHandle: { modelSelection },
    })
  })

  it('does not manufacture a model for an unconfigured binding', () => {
    expect(
      runtimeTaskBindingAddress({ device_id: 'device', task_id: 'task', modelSelection: null })
    ).toEqual({ deviceId: 'device', taskId: 'task' })
  })
})
