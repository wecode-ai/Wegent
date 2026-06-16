// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { projectApis } from '@/apis/projects'
import { ProjectProvider, useProjectContext } from '@/features/projects/contexts/projectContext'
import { PROJECT_DELETED_EVENT, ProjectDeletedEventDetail } from '@/features/projects/events'

const toastMock = jest.fn()

jest.mock('@/apis/projects', () => ({
  projectApis: {
    getProjects: jest.fn(),
    createProject: jest.fn(),
    updateProject: jest.fn(),
    deleteProject: jest.fn(),
    addTaskToProject: jest.fn(),
    removeTaskFromProject: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: toastMock,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({
    enableProjectWorkspace: true,
    projectWorkspaceWhitelist: '',
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { user_name: 'sifang' },
  }),
}))

const mockedProjectApis = projectApis as jest.Mocked<typeof projectApis>

function DeleteProjectProbe() {
  const { deleteProject } = useProjectContext()

  return (
    <button type="button" onClick={() => void deleteProject(42)}>
      delete project
    </button>
  )
}

describe('ProjectContext delete project behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedProjectApis.getProjects.mockResolvedValue({ total: 0, items: [] })
    mockedProjectApis.deleteProject.mockResolvedValue({ message: 'ok' })
  })

  test('emits a project deleted event after deletion succeeds', async () => {
    const deletedListener = jest.fn((event: Event) => {
      const detail = (event as CustomEvent<ProjectDeletedEventDetail>).detail
      expect(detail).toEqual({ projectId: 42 })
    })
    window.addEventListener(PROJECT_DELETED_EVENT, deletedListener)

    try {
      render(
        <ProjectProvider>
          <DeleteProjectProbe />
        </ProjectProvider>
      )

      await waitFor(() => expect(mockedProjectApis.getProjects).toHaveBeenCalled())

      fireEvent.click(screen.getByText('delete project'))

      await waitFor(() => {
        expect(mockedProjectApis.deleteProject).toHaveBeenCalledWith(42)
        expect(deletedListener).toHaveBeenCalledTimes(1)
      })
    } finally {
      window.removeEventListener(PROJECT_DELETED_EVENT, deletedListener)
    }
  })
})
