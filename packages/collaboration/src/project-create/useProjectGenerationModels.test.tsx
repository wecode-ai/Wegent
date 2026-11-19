// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generationModelKey, useProjectGenerationModels } from './useProjectGenerationModels'
import type { ProjectCreateGenerationModel, ProjectCreateGenerationModelCatalog } from './types'

let root: Root
let container: HTMLDivElement
let current: ReturnType<typeof useProjectGenerationModels>
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
  scope,
}: {
  active: boolean
  loader(): Promise<ProjectCreateGenerationModelCatalog>
  scope?: string
}) {
  current = useProjectGenerationModels(active, loader, undefined, 'Failed', scope)
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
  expect(current.error).toBe('Model service unavailable')
  expect(current.loading).toBe(false)
  await act(async () => {
    await current.reload()
  })
  expect(current.error).toBeNull()
  expect(current.models).toEqual(catalog.models)
  expect(current.key).toBe(generationModelKey(first))
  expect(container.querySelector('input')).toBe(draft)
  expect(draft.value).toBe('Keep this name')
})

it('distinguishes a successful empty catalog and reloads it', async () => {
  const emptyCatalog: ProjectCreateGenerationModelCatalog = { models: [], defaultSelection: null }
  const loader = vi.fn().mockResolvedValueOnce(emptyCatalog).mockResolvedValueOnce(catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  expect(current.error).toBeNull()
  expect(current.models).toEqual([])
  await act(async () => {
    await current.reload()
  })
  expect(current.models).toEqual(catalog.models)
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
  expect(current.key).toBe(generationModelKey(first))
  expect(current.options).toEqual({
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
  expect(current.key).toBe(generationModelKey(first))
  expect(current.options).toEqual(first.options)
})

it('retains the selected model and its options when refresh fails or succeeds', async () => {
  const loader = vi
    .fn()
    .mockResolvedValueOnce(catalog)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  await act(async () => {
    current.selectModel(second, { reasoning: 'low' })
  })
  await act(async () => {
    await current.reload()
  })
  expect(current.error).toBe('Offline')
  expect(current.models).toEqual(catalog.models)
  expect(current.key).toBe(generationModelKey(second))
  expect(current.options).toEqual({ reasoning: 'low' })
  await act(async () => {
    await current.reload()
  })
  expect(current.error).toBeNull()
  expect(current.key).toBe(generationModelKey(second))
  expect(current.options).toEqual({ reasoning: 'low' })
})

it('rejects selections outside the current catalog without changing the current model', async () => {
  const loader = vi.fn(async () => catalog)
  await act(async () => root.render(<Harness active loader={loader} />))
  const initialKey = current.key
  const initialOptions = current.options
  await act(async () => {
    expect(
      current.selectModel({ modelName: 'unlisted', modelType: 'public' }, { reasoning: 'low' })
    ).toBe(false)
  })
  expect(current.key).toBe(initialKey)
  expect(current.options).toEqual(initialOptions)
})

it('loads the active location catalog after a scope switch and clears the previous selection', async () => {
  const localLoader = vi.fn(async () => catalog)
  const cloudCatalog = { models: [second], defaultSelection: second }
  const cloudLoader = vi.fn(async () => cloudCatalog)
  await act(async () => root.render(<Harness active loader={localLoader} scope="local:1" />))
  expect(current.key).toBe(generationModelKey(first))
  await act(async () =>
    root.render(<Harness active={false} loader={cloudLoader} scope="cloud:1" />)
  )
  expect(cloudLoader).not.toHaveBeenCalled()
  expect(current.models).toEqual([])
  expect(current.key).toBe('')
  await act(async () => root.render(<Harness active loader={cloudLoader} scope="cloud:1" />))
  expect(cloudLoader).toHaveBeenCalledOnce()
  expect(current.models).toEqual(cloudCatalog.models)
  expect(current.key).toBe(generationModelKey(second))
})

it('ignores a pending catalog response from the previous scope', async () => {
  let resolveLocal!: (value: ProjectCreateGenerationModelCatalog) => void
  const localLoader = vi.fn(
    () =>
      new Promise<ProjectCreateGenerationModelCatalog>(resolve => {
        resolveLocal = resolve
      })
  )
  const cloudCatalog = { models: [second], defaultSelection: second }
  const cloudLoader = vi.fn(async () => cloudCatalog)
  await act(async () => root.render(<Harness active loader={localLoader} scope="local:1" />))
  await act(async () => root.render(<Harness active loader={cloudLoader} scope="cloud:1" />))
  expect(cloudLoader).toHaveBeenCalledOnce()
  await act(async () => resolveLocal(catalog))
  expect(current.models).toEqual(cloudCatalog.models)
  expect(current.key).toBe(generationModelKey(second))
})
