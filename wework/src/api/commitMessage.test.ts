import { describe, expect, test, vi } from 'vitest'
import { createCommitMessageGenerator } from './commitMessage'

const preferences = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('@/desktop/appPreferences', () => ({
  getAppPreferences: vi.fn(async () => preferences.value),
}))

function setup(content = JSON.stringify({ message: 'feat: improve Git workflow' })) {
  preferences.value = {}
  const modelApi = {
    listModels: vi.fn().mockResolvedValue({
      data: [{ name: 'custom-model', type: 'user', provider: 'openai' }],
    }),
  }
  const textGenerationApi = { generateText: vi.fn().mockResolvedValue(content) }
  return {
    modelApi,
    textGenerationApi,
    generate: createCommitMessageGenerator({ modelApi, textGenerationApi }),
  }
}

describe('commit message generation', () => {
  test('uses the configured generation model through the shared text service', async () => {
    const { generate, textGenerationApi } = setup()
    preferences.value = {
      friendlyTaskTitleModel: {
        modelName: 'custom-model',
        modelType: 'user',
        executionModelId: 'custom-model',
        executionModelType: 'user',
        options: {},
      },
    }
    await expect(generate({ deviceId: 'workspace-device', stagedDiff: '+new code' })).resolves.toBe(
      'feat: improve Git workflow'
    )
    expect(textGenerationApi.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'custom-model',
        modelType: 'user',
        deviceId: 'workspace-device',
        timeoutMs: 60_000,
        prompt: expect.stringContaining('+new code'),
        outputSchema: expect.objectContaining({ required: ['message'] }),
      })
    )
  })

  test.each(['{}', '{"message":""}', '{"message":"one\\ntwo"}', 'invalid JSON'])(
    'rejects invalid model output: %s',
    async content => {
      const { generate } = setup(content)
      await expect(generate({ deviceId: 'local', stagedDiff: 'diff' })).rejects.toThrow()
    }
  )

  test('surfaces model errors without trying a separate CLI', async () => {
    const { generate, textGenerationApi } = setup()
    textGenerationApi.generateText.mockRejectedValue(new Error('Model authentication failed'))
    await expect(generate({ deviceId: 'local', stagedDiff: 'diff' })).rejects.toThrow(
      'Model authentication failed'
    )
    expect(textGenerationApi.generateText).toHaveBeenCalledTimes(1)
  })

  test('rejects an unavailable configured model before inference', async () => {
    const { generate, textGenerationApi } = setup()
    preferences.value = { friendlyTaskTitleModel: { modelName: 'deleted', modelType: 'user' } }
    await expect(generate({ deviceId: 'local', stagedDiff: 'diff' })).rejects.toThrow()
    expect(textGenerationApi.generateText).not.toHaveBeenCalled()
  })
})
