// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type { RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import {
  resolveTemporaryChatActiveModel,
  resolveTemporaryChatModelSelection,
} from './temporaryChatModelContext'

const kimiModel: UnifiedModel = {
  name: 'kimi-k2',
  displayName: 'Kimi K2',
  type: 'user',
}
const gptModel: UnifiedModel = {
  name: 'gpt-5.6-sol',
  displayName: 'GPT 5.6 Sol',
  type: 'user',
}

describe('resolveTemporaryChatActiveModel', () => {
  it('treats a new task composer as a fresh conversation', () => {
    expect(resolveTemporaryChatActiveModel([kimiModel, gptModel], undefined, null)).toBeNull()
  })

  it('preserves the immutable task identity even when the model catalog is unavailable', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'cloud-device',
      taskId: 'codex-queue-293',
      runtimeHandle: {
        modelSelection: {
          modelName: 'moonshot-kimi-k2.7-code-highspeed',
          modelType: 'public',
          options: {
            weworkCloudModelNamespace: 'default',
            weworkCloudModelResourceUserId: '0',
          },
        },
      },
    }

    expect(resolveTemporaryChatModelSelection(null, address)).toEqual({
      modelName: 'moonshot-kimi-k2.7-code-highspeed',
      modelType: 'public',
      options: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
      },
    })
    expect(resolveTemporaryChatActiveModel([gptModel], null, address)).toBeNull()
  })
})
