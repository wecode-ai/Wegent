// @vitest-environment jsdom
import { act, createRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generationModelKey, useProjectGenerationModels } from './useProjectGenerationModels'
import type { ProjectCreateGenerationModel, ProjectCreateGenerationModelCatalog } from './types'

let root: Root
let container: HTMLDivElement
const result = createRef<ReturnType<typeof useProjectGenerationModels>>()
const first: ProjectCreateGenerationModel = {
  modelName: 'first',
  modelType: 'public',
  displayName: 'First model',
  options: { reasoning: 'high', toolMode: 'auto' },
}
const second: ProjectCreateGenerationModel = {
  modelName: 'second',
  modelType: 'public',
  displayName: 'Second model',
  options: {},
}
const catalog: ProjectCreateGenerationModelCatalog = {
  models: [first, second],
  defaultSelection: first,
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
function Harness({
  active,
  loader,
  formatError,
}: {
  active: boolean
  loader(): Promise<ProjectCreateGenerationModelCatalog>
  formatError?(cause: unknown): string
}) {
  const state = useProjectGenerationModels(active, loader, formatError, 'Failed')
  useImperativeHandle(result, () => state, [state])
  return <input defaultValue="Project draft" aria-label="Project name" />
}

it('loads only on activation and recovers from a failed request without remounting the draft', async () => {
  const loader = vi
    .fn()
    .mockRejectedValueOnce(new Error('Model service unavailable'))
    .mockResolvedValueOnce(catalog)
  await act(async () => root.render(<Harness active={false} loader={loader} />))
  const draft = container.querySelector('input')!
  draft.value = 'Keep this name'
  expect(loader).not.toHaveBeenCalled()
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(loader).toHaveBeenCalledWith()
  expect(result.current!.error).toBe('Model service unavailable')
  expect(result.current!.loading).toBe(false)
  await act(async () => {
    await result.current!.reload()
  })
  expect(result.current!.error).toBeNull()
  expect(result.current!.models).toEqual(catalog.models)
  expect(result.current!.key).toBe(generationModelKey(first))
  expect(container.querySelector('input')).toBe(draft)
  expect(draft.value).toBe('Keep this name')
})

it('distinguishes a successful empty catalog and reloads it', async () => {
  const emptyCatalog: ProjectCreateGenerationModelCatalog = { models: [], defaultSelection: null }
  const loader = vi.fn().mockResolvedValueOnce(emptyCatalog).mockResolvedValueOnce(catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(result.current!.error).toBeNull()
  expect(result.current!.models).toEqual([])
  await act(async () => {
    await result.current!.reload()
  })
  expect(result.current!.models).toEqual(catalog.models)
  expect(loader).toHaveBeenCalledTimes(2)
})

it('merges saved options over defaults only when the saved model is available', async () => {
  const saved: ProjectCreateGenerationModelCatalog = {
    models: catalog.models,
    defaultSelection: {
      modelName: first.modelName,
      modelType: first.modelType,
      options: { reasoning: 'low', runtimeId: 'saved-runtime' },
    },
  }
  const loader = vi.fn().mockResolvedValue(saved)
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(result.current!.key).toBe(generationModelKey(first))
  expect(result.current!.options).toEqual({
    reasoning: 'low',
    toolMode: 'auto',
    runtimeId: 'saved-runtime',
  })
})

it('does not apply saved options to a different fallback model', async () => {
  const missing: ProjectCreateGenerationModelCatalog = {
    models: catalog.models,
    defaultSelection: {
      modelName: 'removed-model',
      modelType: 'public',
      options: { reasoning: 'low', runtimeId: 'removed-runtime' },
    },
  }
  const loader = vi.fn().mockResolvedValue(missing)
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(result.current!.key).toBe(generationModelKey(first))
  expect(result.current!.options).toEqual(first.options)
})

it('retains the selected model and its options when refresh fails or succeeds', async () => {
  const loader = vi
    .fn()
    .mockResolvedValueOnce(catalog)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  await act(async () => {
    result.current!.selectModel(second, { reasoning: 'low' })
  })
  await act(async () => {
    await result.current!.reload()
  })
  expect(result.current!.error).toBe('Offline')
  expect(result.current!.models).toEqual(catalog.models)
  expect(result.current!.key).toBe(generationModelKey(second))
  expect(result.current!.options).toEqual({ reasoning: 'low' })
  await act(async () => {
    await result.current!.reload()
  })
  expect(result.current!.error).toBeNull()
  expect(result.current!.key).toBe(generationModelKey(second))
  expect(result.current!.options).toEqual({ reasoning: 'low' })
})

it('rejects selections outside the current catalog without changing the current model', async () => {
  const loader = vi.fn(async () => catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  const initialKey = result.current!.key
  const initialOptions = result.current!.options
  await act(async () => {
    expect(
      result.current!.selectModel(
        { modelName: 'unlisted', modelType: 'public' },
        { reasoning: 'low' }
      )
    ).toBe(false)
  })
  expect(result.current!.key).toBe(initialKey)
  expect(result.current!.options).toEqual(initialOptions)
})

it('isolates a replaced loader from an older pending catalog', async () => {
  let finish!: (value: ProjectCreateGenerationModelCatalog) => void
  const oldLoader = vi.fn(
    () =>
      new Promise<ProjectCreateGenerationModelCatalog>(resolve => {
        finish = resolve
      })
  )
  const newLoader = vi.fn().mockResolvedValue({ models: [second], defaultSelection: second })
  await act(async () => root.render(<Harness active loader={oldLoader} />))
  await act(async () => root.render(<Harness active loader={newLoader} />))
  expect(result.current!.models).toEqual([second])
  expect(result.current!.key).toBe(generationModelKey(second))
  await act(async () => finish(catalog))
  expect(result.current!.models).toEqual([second])
  expect(result.current!.key).toBe(generationModelKey(second))
})

it('retains a successful catalog and edited options when the picker is closed and reopened', async () => {
  const loader = vi.fn().mockResolvedValue(catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  await act(async () => {
    result.current!.selectModel(second, { reasoning: 'low' })
  })
  await act(async () => root.render(<Harness active={false} loader={loader} />))
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(loader).toHaveBeenCalledOnce()
  expect(result.current!.key).toBe(generationModelKey(second))
  expect(result.current!.options).toEqual({ reasoning: 'low' })
})

it('updates error formatting without restarting model discovery', async () => {
  const cause = { code: 'unavailable' }
  const loader = vi.fn().mockRejectedValue(cause)
  const firstError = vi.fn(() => 'Models unavailable')
  const secondError = vi.fn(() => '模型暂不可用')
  await act(async () => root.render(<Harness active loader={loader} formatError={firstError} />))
  expect(result.current!.error).toBe('Models unavailable')
  await act(async () => root.render(<Harness active loader={loader} formatError={secondError} />))
  expect(result.current!.error).toBe('模型暂不可用')
  expect(secondError).toHaveBeenCalledWith(cause)
  expect(loader).toHaveBeenCalledOnce()
})

it('keeps the latest reload result when an earlier refresh completes later', async () => {
  let finish!: (value: ProjectCreateGenerationModelCatalog) => void
  const loader = vi
    .fn()
    .mockResolvedValueOnce(catalog)
    .mockImplementationOnce(
      () =>
        new Promise<ProjectCreateGenerationModelCatalog>(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ models: [second], defaultSelection: second })
  await act(async () => root.render(<Harness active loader={loader} />))
  let previous!: Promise<void>
  await act(async () => {
    previous = result.current!.reload()
  })
  await act(async () => result.current!.reload())
  expect(result.current!.models).toEqual([second])
  await act(async () => {
    finish(catalog)
    await previous
  })
  expect(result.current!.models).toEqual([second])
  expect(result.current!.key).toBe(generationModelKey(second))
})

it('keeps an in-flight catalog request when closing and reopening the picker', async () => {
  let finish!: (value: ProjectCreateGenerationModelCatalog) => void
  const loader = vi.fn(
    () =>
      new Promise<ProjectCreateGenerationModelCatalog>(resolve => {
        finish = resolve
      })
  )
  await act(async () => root.render(<Harness active loader={loader} />))
  await act(async () => root.render(<Harness active={false} loader={loader} />))
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(loader).toHaveBeenCalledOnce()
  await act(async () => finish(catalog))
  expect(result.current!.models).toEqual(catalog.models)
})

it('allows explicit refresh after the picker closes once it has been activated', async () => {
  const loader = vi
    .fn()
    .mockResolvedValueOnce(catalog)
    .mockResolvedValueOnce({ models: [second], defaultSelection: second })
  await act(async () => root.render(<Harness active loader={loader} />))
  await act(async () => root.render(<Harness active={false} loader={loader} />))
  await act(async () => result.current!.reload())
  expect(loader).toHaveBeenCalledTimes(2)
  expect(result.current!.models).toEqual([second])
})
