import type { CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'
import { project } from './workbenchCloudProjectContextTestFixtures'

function pendingProjects() {
  let resolve!: (value: { items: CloudProject[] }) => void
  const promise = new Promise<{ items: CloudProject[] }>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

function renderProjects(local: object, cloud: object) {
  const services = {
    projectSpaceApis: { local, cloud },
  } as unknown as WorkbenchServices
  return renderHook(
    ({ active, services }) =>
      useWorkbenchCloudProjectContext({
        active,
        services,
        currentRuntimeTask: null,
        defaultProjectSpace: null,
        paneKey: 'project-list-regression',
        runtimeTaskTitle: null,
        userId: 1,
      }),
    { initialProps: { active: true, services } }
  )
}

test.each(['failed'])(
  'a fast %s cloud refresh preserves local projects until their own response arrives',
  async outcome => {
    const localProject = project('local-board', 'local')
    const refresh = pendingProjects()
    const local = {
      listCloudProjects: vi
        .fn()
        .mockResolvedValueOnce({ items: [localProject] })
        .mockReturnValueOnce(refresh.promise),
    }
    const cloud = {
      listCloudProjects:
        outcome === 'failed'
          ? vi.fn().mockRejectedValue(new Error('Cloud projects unavailable'))
          : vi.fn().mockResolvedValue({ items: [] }),
    }
    const { result, rerender } = renderProjects(local, cloud)
    await waitFor(() => expect(result.current.cloudProjects).toEqual([localProject]))

    const services = { projectSpaceApis: { local, cloud } } as unknown as WorkbenchServices
    rerender({ active: false, services })
    rerender({ active: true, services })
    await waitFor(() => expect(cloud.listCloudProjects).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(result.current.cloudProjects).toEqual([localProject])

    await act(async () => refresh.resolve({ items: [] }))
    expect(result.current.cloudProjects).toEqual([])
  }
)
