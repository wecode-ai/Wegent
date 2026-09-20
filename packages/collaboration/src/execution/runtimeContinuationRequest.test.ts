import { describe, expect, it } from 'vitest'
import { findModelForSelection } from '@wegent/chat-core/runtime-model-selection'
import { runtimeContinuationRequest } from './runtimeContinuationRequest'

const address = { deviceId: 'device', taskId: 'task' }
const options = {
  weworkCloudModelNamespace: 'team',
  weworkCloudModelResourceUserId: '42',
  reasoningEffort: 'high',
}
const selection = { modelName: 'same-name', modelType: 'user' as const, options }
const task = {
  taskId: 'task',
  title: 'pwd',
  runtime: 'codex',
  workspacePath: '/worktree',
  threadId: 'thread-1',
  modelSelection: selection,
}

describe('continuation model identity shared by browser send and retry', () => {
  it('resolves same-name models using the original owner and namespace', () => {
    const models = [
      { name: 'same-name', type: 'user' as const, namespace: 'personal', resourceUserId: 42 },
      { name: 'same-name', type: 'user' as const, namespace: 'team', resourceUserId: 7 },
      { name: 'same-name', type: 'user' as const, namespace: 'team', resourceUserId: 42 },
    ]
    expect(findModelForSelection(models, selection)).toBe(models[2])
    expect(findModelForSelection(models.slice(0, 2), selection)).toBeNull()
  })
  it('retains stored settings and the real execution address before catalog load', () => {
    expect(runtimeContinuationRequest(address, task, null, 'project-1')).toMatchObject({
      address: { ...address, runtime: 'codex', threadId: 'thread-1', workspacePath: '/worktree' },
      modelId: 'same-name',
      modelType: 'user',
      modelOptions: options,
      modelSelection: selection,
      cloudProjectId: 'project-1',
    })
  })
  it('reads the canonical runtime handle and respects an explicit model override', () => {
    const destination = {
      ...task,
      modelSelection: undefined,
      runtimeHandle: {
        model_selection: {
          model_name: selection.modelName,
          model_type: selection.modelType,
          options,
        },
      },
    }
    expect(runtimeContinuationRequest(address, destination, null).modelSelection).toEqual(selection)
    const changed = runtimeContinuationRequest(address, destination, {
      model: { name: 'another-model', type: 'runtime', provider: 'local' },
      options: { reasoningEffort: 'low' },
    })
    expect(changed.modelSelection).toEqual({
      modelName: 'another-model',
      modelType: 'runtime',
      options: { reasoningEffort: 'low', collaborationMode: 'default' },
    })
  })
})
