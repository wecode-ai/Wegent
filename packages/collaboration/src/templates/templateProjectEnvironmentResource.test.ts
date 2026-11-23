import { expect, it, vi } from 'vitest'
import {
  createTemplateProjectEnvironmentResource,
  type TemplateProjectEnvironmentResource,
} from './templateProjectEnvironmentResource'
import type { CollaborationExecutionEnvironment, CollaborationProject } from '../types'

const project = { id: 'project', project_store: 'cloud' } as CollaborationProject
const device = (id: string) =>
  ({ id, status: 'online', can_use: true }) as CollaborationExecutionEnvironment

async function startCatalog(resource: TemplateProjectEnvironmentResource) {
  let stop!: () => void
  await new Promise<void>(resolve => {
    stop = resource.catalog.subscribe(() => {
      if (resource.catalog.getSnapshot().status === 'ready') resolve()
    })
  })
  return stop
}

it('keeps selection observation lazy and releases selection listeners', async () => {
  const list = vi.fn(async () => [device('first'), device('second')])
  const resource = createTemplateProjectEnvironmentResource(
    { renderDialog: () => null, listTemplateAgentEnvironments: list },
    project
  )
  const changed = vi.fn()
  const stopSelection = resource.subscribeSelection(changed)
  expect(list).not.toHaveBeenCalled()
  const stopCatalog = await startCatalog(resource)
  expect(list).toHaveBeenCalledExactlyOnceWith('project', 'cloud')
  expect(resource.getSelection()).toBeUndefined()
  resource.select('second')
  expect(changed).toHaveBeenCalledTimes(1)
  stopSelection()
  resource.select('first')
  expect(resource.getSelection()).toBe('first')
  expect(changed).toHaveBeenCalledTimes(1)
  stopCatalog()
})

it('preserves a choice on refresh failure and revalidates it when usable devices change', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce([device('first'), device('second')])
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([device('first'), { ...device('second'), can_use: false }])
    .mockResolvedValueOnce([])
  const resource = createTemplateProjectEnvironmentResource(
    { renderDialog: () => null, listTemplateAgentEnvironments: list },
    project
  )
  const stop = await startCatalog(resource)
  resource.select('second')
  await resource.catalog.reload()
  expect(resource.catalog.getSnapshot().status).toBe('error')
  expect(resource.getSelection()).toBe('second')
  await resource.catalog.reload()
  expect(resource.catalog.getSnapshot().data?.map(item => item.id)).toEqual(['first'])
  expect(resource.getSelection()).toBe('first')
  await resource.catalog.reload()
  expect(resource.getSelection()).toBeUndefined()
  stop()
})

it('does not auto-select an environment after detaching its pending catalog', async () => {
  let resolve!: (value: CollaborationExecutionEnvironment[]) => void
  const pending = new Promise<CollaborationExecutionEnvironment[]>(done => {
    resolve = done
  })
  const resource = createTemplateProjectEnvironmentResource(
    { renderDialog: () => null, listTemplateAgentEnvironments: () => pending },
    project
  )
  const changed = vi.fn()
  const stopSelection = resource.subscribeSelection(changed)
  const stopCatalog = resource.catalog.subscribe(vi.fn())
  const refresh = resource.catalog.reload()
  stopCatalog()
  resolve([device('late')])
  await refresh
  expect(resource.getSelection()).toBeUndefined()
  expect(changed).not.toHaveBeenCalled()
  stopSelection()
})
