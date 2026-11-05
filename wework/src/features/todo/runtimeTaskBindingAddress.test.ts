// @vitest-environment node

import type { ModelSelectionConfig } from '@/types/api'
import { describe, expect, it } from 'vitest'
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

  it('preserves the bound execution workspace and thread together with its model', () => {
    const modelSelection: ModelSelectionConfig = {
      modelName: 'agent-model',
      modelType: 'public',
      options: {},
    }
    const executionContext = {
      runtime: 'codex',
      threadId: 'original-thread',
      workspacePath: '/tmp/issue-worktree',
      workspaceKind: 'worktree',
      worktreeId: 'issue-task',
    }

    expect(
      runtimeTaskBindingAddress({
        device_id: 'remote-device',
        task_id: 'issue-task',
        modelSelection,
        executionContext,
      })
    ).toEqual({
      deviceId: 'remote-device',
      taskId: 'issue-task',
      ...executionContext,
      runtimeHandle: { modelSelection },
    })
  })
})
