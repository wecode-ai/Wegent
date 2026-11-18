import '@/i18n'
import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { navigateTo } from '@/lib/navigation'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useOptionalWorkspaceTabs: () => null,
}))

test.each(['local', 'backend'] as const)(
  'returns to the %s Issue while optional context reads are stalled',
  projectStore => {
    const api = {
      listCloudProjects: vi.fn(() => new Promise(() => {})),
      findCloudContextForTask: vi.fn(() => new Promise(() => {})),
    }
    const { result, unmount } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: {
          deviceId: 'device',
          taskId: 'task',
          issueExecution: { projectId: 'project', issueId: 'issue', projectStore },
        },
        defaultProjectSpace: null,
        paneKey: `return-${projectStore}`,
        runtimeTaskTitle: 'Execution',
        services: { projectSpaceApis: { local: api, cloud: api } } as unknown as WorkbenchServices,
      })
    )

    expect(result.current.boundCloudProject).toBeNull()
    act(() => result.current.openBoundProjectSpaceTask())
    expect(navigateTo).toHaveBeenLastCalledWith(
      `/todo?projectStore=${projectStore}&projectId=project&itemId=issue`
    )
    unmount()
  }
)
