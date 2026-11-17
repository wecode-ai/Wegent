import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executionFields, continuationSelection } from '@/domain/modelSelection'
import type { RuntimeApi } from '@/services/runtimeApi'
import type {
  DeviceInfo,
  ModelSelectionConfig,
  RunnerModel,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/runtime'
import { useDeviceModels } from './useDeviceModels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const device = (id: number): DeviceInfo => ({
  id,
  device_id: `app-record-${id}`,
  name: `Computer ${id}`,
  device_type: 'app',
  bind_shell: 'claudecode',
  status: 'online',
})
const native: RunnerModel = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'gpt-6.1-sol',
  local_model_id: 'gpt-6.1-sol',
  label: 'GPT-6.1 Sol',
  account_label: 'ChatGPT',
  is_default: true,
  default_reasoning_effort: 'medium',
  supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
}
const cloud: UnifiedModel = {
  name: 'same-cloud',
  type: 'public',
  provider: 'openai',
  namespace: 'default',
  resourceUserId: 0,
  config: { protocol: 'openai-responses' },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('device-owned model catalogs', () => {
  let renderer: ReactTestRenderer
  let state: ReturnType<typeof useDeviceModels>
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  function setup(load = vi.fn().mockResolvedValue({ models: [native] })) {
    const api = { listNativeModels: load } as unknown as RuntimeApi
    function Harness({ id = 11 }: { id?: number }) {
      state = useDeviceModels(api, device(id), [cloud])
      return null
    }
    return { load, Harness }
  }

  it('loads lazily, coalesces reads, preserves explicit selection and sends native identity for create and continue', async () => {
    const pending = deferred<{ models: RunnerModel[] }>()
    const { load, Harness } = setup(vi.fn().mockReturnValue(pending.promise))
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(load).not.toHaveBeenCalled()
    expect(state.models).toEqual([cloud])
    await act(() => {
      void state.loadModels()
      void state.loadModels()
    })
    expect(load).toHaveBeenCalledExactlyOnceWith(11, 'app-record-11')
    expect(state.modelsLoading).toBe(true)
    await act(() => {
      pending.resolve({ models: [native, { ...native, provider: 'other', is_default: false }] })
    })
    expect(state.modelsLoading).toBe(false)
    expect(state.models).toHaveLength(3)
    expect(state.selectedModel?.runtime?.provider).toBe('openai')
    await act(() => state.selectModel(state.models[1], { reasoning: 'xhigh' }))
    const fields = executionFields(state.selectedModel!, state.selectedModelOptions)
    expect(fields).toMatchObject({
      modelId: native.model_id,
      modelType: 'runtime',
      modelOptions: { runnerModelProvider: 'other', codexProviderId: 'other', reasoning: 'xhigh' },
    })
    expect(continuationSelection(fields)).toEqual({
      modelName: fields.modelId,
      modelType: 'runtime',
      options: fields.modelOptions,
    })
    await act(() => state.loadModels())
    expect(load).toHaveBeenCalledOnce()
    await act(() => state.selectModel(cloud))
    await act(() => state.loadModels(true))
    expect(state.selectedModel).toBe(cloud)
  })

  it('isolates late responses and model options when switching between two computers', async () => {
    const pending = deferred<{ models: RunnerModel[] }>()
    const { Harness } = setup(
      vi
        .fn()
        .mockImplementation(id => (id === 11 ? pending.promise : Promise.resolve({ models: [] })))
    )
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => {
      void state.loadModels()
    })
    await act(() => renderer.update(<Harness id={12} />))
    await act(() => {
      pending.resolve({ models: [native] })
    })
    expect(state.models).toEqual([cloud])
    expect(state.selectedModel).toBe(cloud)
    await act(() => renderer.update(<Harness />))
    expect(state.selectedModel?.name).toBe(native.model_id)
    await act(() => state.selectModel(state.selectedModel!, { reasoning: 'xhigh' }))
    await act(() => renderer.update(<Harness id={12} />))
    expect(state.selectedModelOptions).not.toHaveProperty('reasoning', 'xhigh')
    await act(() => renderer.update(<Harness />))
    expect(state.selectedModelOptions.reasoning).toBe('xhigh')
  })

  it('exposes failed discovery without blocking cloud selection and retries explicitly', async () => {
    const { Harness } = setup(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('catalog denied'))
        .mockResolvedValue({ models: [native], catalog_error: null })
    )
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadModels())
    expect(state.modelsError).toBe('catalog denied')
    expect(state.modelsLoading).toBe(false)
    expect(state.selectedModel).toBe(cloud)
    await act(() => state.loadModels(true))
    expect(state.modelsError).toBeNull()
    expect(state.selectedModel?.name).toBe(native.model_id)
  })

  it('invalidates old Backend catalogs, including responses that finish after a same-host account switch', async () => {
    const pending = deferred<{ models: RunnerModel[] }>()
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ models: [] })
    const api = { listNativeModels: load } as unknown as RuntimeApi
    function Harness({ session = 'account-a' }) {
      state = useDeviceModels(api, device(11), [], session)
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => {
      void state.loadModels()
    })
    await act(() => renderer.update(<Harness session="account-b" />))
    await act(() => pending.resolve({ models: [native] }))
    expect(state.models).toEqual([])
    await act(() => state.loadModels())
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('refreshes the phone catalog directly while a cloud device is selected and preserves it across Backend login', async () => {
    const load = vi.fn().mockResolvedValue({ models: [native] })
    const api = { listNativeModels: load } as unknown as RuntimeApi
    const phone: DeviceInfo = {
      ...device(-1),
      device_type: 'local',
      device_id: 'mobile-local:phone:stable',
    }
    function Harness({ session = 'account-a', local = false }) {
      state = useDeviceModels(api, local ? phone : device(11), [], session)
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadDeviceModels(phone, true))
    expect(load).toHaveBeenCalledExactlyOnceWith(-1, phone.device_id)
    expect(state.models).toEqual([])
    await act(() => renderer.update(<Harness session="account-b" local />))
    expect(state.selectedModel?.name).toBe(native.model_id)
    await act(() => state.loadModels())
    expect(load).toHaveBeenCalledOnce()
  })

  it('performs a requested forced refresh after a pending catalog read finishes', async () => {
    const pending = deferred<{ models: RunnerModel[] }>()
    const { Harness, load } = setup(
      vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ models: [] })
    )
    await act(() => {
      renderer = create(<Harness />)
    })
    let forced!: Promise<void>
    await act(() => {
      void state.loadModels()
      forced = state.loadModels(true)
    })
    await act(async () => {
      pending.resolve({ models: [native] })
      await forced
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(state.models).toEqual([cloud])
  })

  it('keeps same-name cloud owners distinct and retains a native selection through background cloud refresh', async () => {
    const api = {
      listNativeModels: vi.fn().mockResolvedValue({ models: [native] }),
    } as unknown as RuntimeApi
    function Harness({ owner = 1 }: { owner?: number }) {
      state = useDeviceModels(api, device(11), [{ ...cloud, type: 'user', resourceUserId: owner }])
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadModels())
    await act(() => state.selectModel(state.models[0], { reasoning: 'low' }))
    await act(() => renderer.update(<Harness owner={2} />))
    expect(state.selectedModel?.type).toBe('runtime')
    expect(state.selectedModelOptions.reasoning).toBe('low')
  })

  it('restores the task GPT identity and every saved option before and after loading a different device default', async () => {
    const selection: ModelSelectionConfig = {
      modelName: native.model_id,
      modelType: 'runtime',
      options: {
        runnerModelProvider: 'openai',
        reasoning: 'xhigh',
        speed: 'fast',
        custom: 'retained',
      },
    }
    const pending = deferred<{ models: RunnerModel[] }>()
    const api = {
      listNativeModels: vi.fn().mockReturnValue(pending.promise),
    } as unknown as RuntimeApi
    const address = {
      deviceId: 'app-record-11',
      taskId: 'gpt-task',
      runtimeHandle: { modelSelection: selection },
    }
    function Harness() {
      state = useDeviceModels(api, device(11), [cloud], null, undefined, {
        address,
        autoLoad: true,
      })
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.selectedModel?.name).toBe(native.model_id)
    expect(state.modelsLoading).toBe(true)
    expect(state.modelSelection).toEqual(selection)
    expect(state.selectedModelOptions).toEqual(selection.options)
    await act(() =>
      pending.resolve({
        models: [
          { ...native, provider: 'other', is_default: true },
          { ...native, is_default: false },
        ],
      })
    )
    expect(state.selectedModel?.runtime?.provider).toBe('openai')
    expect(state.modelSelection).toEqual(selection)
    expect(state.selectedModelOptions).toEqual(selection.options)
  })

  it('isolates overrides for two conversations and the new-conversation default on one device', async () => {
    const selections: Record<string, ModelSelectionConfig> = {
      a: { modelName: native.model_id, modelType: 'runtime', options: { reasoning: 'low' } },
      b: { modelName: cloud.name, modelType: cloud.type, options: { reasoning: 'high' } },
    }
    const api = {
      listNativeModels: vi.fn().mockResolvedValue({ models: [native] }),
    } as unknown as RuntimeApi
    function Harness({ task = 'a' }: { task?: string }) {
      const address: RuntimeTaskAddress | null = task
        ? {
            deviceId: 'app-record-11',
            taskId: task,
            runtimeHandle: { modelSelection: selections[task] },
          }
        : null
      state = useDeviceModels(api, device(11), [cloud], null, undefined, { address })
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadModels())
    await act(() => state.selectModel(cloud, { reasoning: 'xhigh' }))
    await act(() => renderer.update(<Harness task="b" />))
    expect(state.selectedModel?.name).toBe(cloud.name)
    expect(state.selectedModelOptions.reasoning).toBe('high')
    await act(() => renderer.update(<Harness task="" />))
    expect(state.selectedModel?.name).toBe(native.model_id)
    expect(state.selectedModelOptions.reasoning).toBe('medium')
    await act(() => renderer.update(<Harness />))
    expect(state.selectedModel?.name).toBe(cloud.name)
    expect(state.selectedModelOptions.reasoning).toBe('xhigh')
  })

  it('retains an unavailable task model on discovery failure and supports editing its options', async () => {
    const selection: ModelSelectionConfig = {
      modelName: 'removed-gpt',
      modelType: 'runtime',
      options: { codexProviderId: 'my-provider', reasoning: 'ultra', speed: 'fast' },
    }
    const api = {
      listNativeModels: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as RuntimeApi
    function Harness() {
      state = useDeviceModels(api, device(11), [cloud], null, undefined, {
        address: {
          deviceId: 'app-record-11',
          taskId: 'task',
          runtimeHandle: { modelSelection: selection },
        },
      })
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    await act(() => state.loadModels())
    expect(state.modelsError).toBe('offline')
    expect(state.selectedModel?.name).toBe('removed-gpt')
    expect(state.modelSelection).toEqual(selection)
    await act(() =>
      state.selectModel(state.selectedModel!, { ...state.selectedModelOptions, reasoning: 'high' })
    )
    expect(state.modelSelection).toEqual({
      ...selection,
      options: { ...selection.options, reasoning: 'high' },
    })
  })

  it('does not invent a task model when metadata is missing and accepts an explicit catalog selection', async () => {
    const api = { listNativeModels: vi.fn() } as unknown as RuntimeApi
    function Harness() {
      state = useDeviceModels(api, device(11), [cloud], null, undefined, {
        address: { deviceId: 'app-record-11', taskId: 'unknown' },
      })
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.selectedModel).toBeNull()
    expect(state.modelSelection).toBeNull()
    await act(() => state.selectModel(cloud))
    expect(state.selectedModel).toBe(cloud)
    expect(state.modelSelection?.modelName).toBe(cloud.name)
  })

  it('uses the PC automatic catalog model for a loaded task without a saved selection', async () => {
    const api = { listNativeModels: vi.fn() } as unknown as RuntimeApi
    function Harness() {
      state = useDeviceModels(api, device(11), [cloud], null, undefined, {
        address: {
          deviceId: 'app-record-11',
          taskId: 'legacy',
          runtimeHandle: {
            modelSelection: { modelName: 'stale-model', modelType: 'runtime', options: {} },
          },
        },
        task: {
          taskId: 'legacy',
          title: 'Legacy task',
          runtime: 'codex',
          workspacePath: '/repo',
          modelSelection: null,
        },
      })
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.selectedModel).toBe(cloud)
    expect(state.modelSelection).toEqual(
      continuationSelection(executionFields(cloud, state.selectedModelOptions))
    )
  })

  it('takes the loaded task model and options over an outdated address snapshot', async () => {
    const selection: ModelSelectionConfig = {
      modelName: 'saved-gpt',
      modelType: 'runtime',
      options: { runnerModelProvider: 'openai', reasoning: 'high' },
    }
    const api = { listNativeModels: vi.fn() } as unknown as RuntimeApi
    function Harness() {
      state = useDeviceModels(api, device(11), [cloud], null, undefined, {
        address: {
          deviceId: 'app-record-11',
          taskId: 'task',
          runtimeHandle: { modelSelection: { ...selection, modelName: 'outdated' } },
        },
        task: {
          taskId: 'task',
          title: 'Task',
          runtime: 'codex',
          workspacePath: '/repo',
          modelSelection: selection,
        },
      })
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.selectedModel?.name).toBe('saved-gpt')
    expect(state.selectedModelOptions.reasoning).toBe('high')
    expect(state.modelSelection).toEqual(selection)
  })

  it('matches a saved cloud model by namespace and owner instead of taking a same-name entry', async () => {
    const selection: ModelSelectionConfig = {
      modelName: cloud.name,
      modelType: 'user',
      options: { weworkCloudModelNamespace: 'team', weworkCloudModelResourceUserId: '7' },
    }
    const api = { listNativeModels: vi.fn() } as unknown as RuntimeApi
    const owned = { ...cloud, type: 'user' as const, namespace: 'team', resourceUserId: 7 }
    function Harness() {
      state = useDeviceModels(
        api,
        device(11),
        [{ ...owned, namespace: 'default' }, { ...owned, resourceUserId: 8 }, owned],
        null,
        undefined,
        {
          address: {
            deviceId: 'app-record-11',
            taskId: 'task',
            runtimeHandle: { modelSelection: selection },
          },
        }
      )
      return null
    }
    await act(() => {
      renderer = create(<Harness />)
    })
    expect(state.selectedModel).toBe(owned)
    expect(state.modelSelection).toEqual(selection)
  })
})
