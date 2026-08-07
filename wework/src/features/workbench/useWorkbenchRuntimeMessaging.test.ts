import { describe, expect, test } from 'vitest'
import { friendlyTitleForTask, runtimeThreadId } from './useWorkbenchRuntimeMessaging'

describe('runtimeThreadId', () => {
  test('uses the direct thread id from a hydrated runtime task address', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        threadId: 'thread-1',
        runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
      })
    ).toBe('thread-1')
  })

  test('falls back to the runtime handle thread id', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        runtimeHandle: { threadId: 'thread-from-handle' },
      })
    ).toBe('thread-from-handle')
  })
})

describe('friendlyTitleForTask', () => {
  const taskExecutionModel = {
    modelId: 'local-model:current',
    modelType: 'runtime' as const,
    modelOptions: { collaborationMode: 'default' },
  }

  test('skips title generation when the previously selected title model is gone', () => {
    expect(
      friendlyTitleForTask(
        {
          friendlyTaskTitlesEnabled: true,
          friendlyTaskTitleModel: {
            modelName: 'local-model:removed',
            modelType: 'runtime',
            executionModelId: 'local-model:removed',
            executionModelType: 'runtime',
          },
        },
        [{ name: 'local-model:current', type: 'runtime' }] as never,
        taskExecutionModel
      )
    ).toBeNull()
  })

  test('uses an available configured title model', () => {
    expect(
      friendlyTitleForTask(
        {
          friendlyTaskTitlesEnabled: true,
          friendlyTaskTitleModel: {
            modelName: 'local-model:title',
            modelType: 'runtime',
            executionModelId: 'local-model:title',
            executionModelType: 'runtime',
            options: { collaborationMode: 'default' },
          },
        },
        [{ name: 'local-model:title', type: 'runtime' }] as never,
        taskExecutionModel
      )
    ).toEqual({
      modelId: 'local-model:title',
      modelType: 'runtime',
      modelOptions: { collaborationMode: 'default' },
    })
  })
})
