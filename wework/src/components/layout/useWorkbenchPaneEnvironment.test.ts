import { describe, expect, test } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import { resolveSelectedWorkspaceProject } from './useWorkbenchPaneEnvironment'

describe('resolveSelectedWorkspaceProject', () => {
  test('uses the active Runtime project when it is absent from the persisted project list', () => {
    const runtimeProject: ProjectWithTasks = {
      id: 7,
      name: 'Remote Runtime Project',
      tasks: [],
    }

    expect(
      resolveSelectedWorkspaceProject({
        currentProject: runtimeProject,
        currentProjectId: runtimeProject.id,
        projects: [],
      })
    ).toBe(runtimeProject)
  })

  test('falls back to the persisted project list', () => {
    const persistedProject: ProjectWithTasks = {
      id: 8,
      name: 'Persisted Project',
      tasks: [],
    }

    expect(
      resolveSelectedWorkspaceProject({
        currentProject: null,
        currentProjectId: persistedProject.id,
        projects: [persistedProject],
      })
    ).toBe(persistedProject)
  })
})
