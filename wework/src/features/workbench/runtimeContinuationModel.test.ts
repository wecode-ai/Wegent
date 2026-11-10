import { createLocalAppServices } from '@/api/local/localServices'
import type { ModelSelectionConfig, RuntimeSendRequest, RuntimeWorkListResponse } from '@/types/api'
import { describe, expect, it, vi } from 'vitest'
import { prepareRuntimeContinuationModel } from './runtimeContinuationModel'

const selection: ModelSelectionConfig = {
  modelName: 'deepseek-v4-flash',
  modelType: 'user',
  options: {
    weworkCloudModelNamespace: 'team-models',
    weworkCloudModelResourceUserId: '42',
    weworkCloudModelUpstreamApiFormat: 'openai-chat-completions',
    weworkCloudModelCodexCatalogModelId: 'wework-deepseek-v4-flash',
    reasoning: 'high',
    permissionMode: 'full-access',
  },
}
const request: RuntimeSendRequest = {
  address: { deviceId: 'device-1', taskId: 'board-task' },
  message: '继续处理',
}

function workList(
  modelSelection: ModelSelectionConfig | null = selection
): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [
      {
        deviceId: 'device-1',
        workspacePath: '/workspace',
        tasks: [{ taskId: 'board-task', runtime: 'codex', modelSelection }],
      },
      {
        deviceId: 'another-device',
        workspacePath: '/other',
        tasks: [{ taskId: 'board-task', modelSelection: { modelName: 'wrong-model' } }],
      },
    ],
    totalTasks: 2,
  } as RuntimeWorkListResponse
}

describe('runtime continuation model routing', () => {
  it('uses persisted handle configuration without requiring a model catalog', async () => {
    const list = vi.fn()
    const result = await prepareRuntimeContinuationModel(
      { ...request, address: { ...request.address, runtimeHandle: { modelSelection: selection } } },
      null,
      list
    )
    expect(result.modelSelection).toEqual(selection)
    expect(list).not.toHaveBeenCalled()
  })

  it('supplies execution fields when a caller only sends modelSelection', async () => {
    const result = await prepareRuntimeContinuationModel(
      { ...request, modelSelection: selection },
      null,
      vi.fn()
    )
    expect(result.modelId).toBe(selection.modelName)
    expect(result.modelType).toBe('user')
    expect(result.modelOptions).toEqual(selection.options)
  })

  it('continues a switched session with its confirmed model instead of a stale task cache', async () => {
    const activeSelection: ModelSelectionConfig = {
      modelName: 'gpt-6.1-sol',
      modelType: 'runtime',
      options: { collaborationMode: 'default', reasoning: 'high' },
    }
    const result = await prepareRuntimeContinuationModel(
      request,
      workList(selection),
      vi.fn(),
      () => activeSelection
    )

    expect(result.modelId).toBe('gpt-6.1-sol')
    expect(result.modelType).toBe('runtime')
    expect(result.modelOptions).toEqual(activeSelection.options)
    expect(result.modelSelection).toEqual(activeSelection)
  })

  it('keeps an explicitly supplied model ahead of the active session selection', async () => {
    const explicitSelection: ModelSelectionConfig = {
      modelName: 'deepseek',
      modelType: 'public',
      options: { reasoning: 'low' },
    }
    const resolveActiveSelection = vi.fn()
    const result = await prepareRuntimeContinuationModel(
      { ...request, modelSelection: explicitSelection },
      workList(),
      vi.fn(),
      resolveActiveSelection
    )

    expect(result.modelSelection).toEqual(explicitSelection)
    expect(resolveActiveSelection).not.toHaveBeenCalled()
  })

  it('rejects an unknown task instead of routing to the native default', async () => {
    await expect(
      prepareRuntimeContinuationModel(
        request,
        null,
        vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
      )
    ).rejects.toThrow()
  })

  it('propagates a failed refresh without sending a default model request', async () => {
    await expect(
      prepareRuntimeContinuationModel(
        request,
        null,
        vi.fn().mockRejectedValue(new Error('offline'))
      )
    ).rejects.toThrow('offline')
  })

  it('builds a cloud gateway execution request for a board reply sent through the local executor', async () => {
    const ipc = vi.fn().mockResolvedValue({ accepted: true })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-1' }),
      request: ipc,
      subscribe: vi.fn(),
      cloudModelGateway: {
        baseUrl: 'https://cloud.example/api/runtime-work/llm-responses-proxy',
        apiKey: 'test-cloud-token',
        backendUrl: 'https://cloud.example',
      },
    })
    const outbound = await prepareRuntimeContinuationModel(request, workList(), vi.fn())
    await services.runtimeWorkApi!.sendRuntimeMessage(outbound)
    const payload = ipc.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
    expect(payload.address).toMatchObject(request.address)
    expect(payload.modelSelection).toEqual(selection)
    expect(payload.executionRequest.model_config).toMatchObject({
      model_id: selection.modelName,
      wework_model_kind: 'cloud',
      base_url: 'https://cloud.example/api/runtime-work/llm-responses-proxy',
      upstream_api_format: 'openai-chat-completions',
      api_key: 'test-cloud-token',
      reasoning: { effort: 'high' },
      default_headers: {
        'X-Wegent-Model-Type': 'user',
        'X-Wegent-Model-Namespace': 'team-models',
        'X-Wegent-Model-User-Id': '42',
      },
      runtime_config: { codex: { use_user_config: false } },
    })
  })
})
