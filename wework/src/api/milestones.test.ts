// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createLocalDeliveryApi } from './local/localDelivery'
import { createDeliveryApi } from './deliveries'
import { createWeworkDeliverySharedWorkspaceApi } from '@/features/collaboration/weworkSharedWorkspaceApi'
import type { HttpClient } from './http'

const input = { title: 'Release', description: '', due_on: null, state: 'open' as const }

it('routes local milestone management through the real IPC method names', async () => {
  const request = vi.fn().mockResolvedValue({ id: 'ms1' })
  const api = createLocalDeliveryApi(request)
  await api.listMilestones('p1')
  await api.createMilestone('p1', input)
  await api.updateMilestone('p1', 'ms1', { ...input, version: 4 })
  await api.deleteMilestone('p1', 'ms1', 5)
  expect(request.mock.calls).toEqual([
    ['milestones.list', { project_id: 'p1' }],
    ['milestones.create', { project_id: 'p1', milestone: input }],
    [
      'milestones.update',
      { project_id: 'p1', milestone_id: 'ms1', milestone: { ...input, version: 4 } },
    ],
    ['milestones.delete', { project_id: 'p1', milestone_id: 'ms1', version: 5 }],
  ])
})

it('routes cloud milestones and explicit Issue association clearing through the shared adapter', async () => {
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue({ id: 'I-1', cloud_project_id: 'p1' }),
    delete: vi.fn(),
  } as unknown as HttpClient
  const api = createWeworkDeliverySharedWorkspaceApi(createDeliveryApi(client))
  await api.milestones.list('p1')
  await api.milestones.create('p1', input)
  await api.milestones.remove('p1', 'ms1', 2)
  await api.issues.update('I-1', { version: 3, milestoneId: null })
  expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/p1/milestones', { cache: 'no-store' })
  expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/p1/milestones', input)
  expect(client.delete).toHaveBeenCalledWith('/v1/cloud-projects/p1/milestones/ms1', { version: 2 })
  expect(client.patch).toHaveBeenCalledWith('/v1/loop-items/I-1', {
    version: 3,
    milestone_id: null,
  })
})
