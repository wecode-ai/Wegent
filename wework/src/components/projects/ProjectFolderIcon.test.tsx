import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { ProjectFolderIcon } from './ProjectFolderIcon'
import type { ProjectWithTasks } from '@/types/api'

describe('ProjectFolderIcon', () => {
  test('marks Git workspace projects with a Git folder icon', () => {
    const project: ProjectWithTasks = {
      id: 7,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        workspace: {
          source: 'git',
          checkoutPath: 'Wegent',
        },
      },
    }

    render(<ProjectFolderIcon project={project} className="h-4 w-4" />)

    expect(screen.getByTestId('project-git-folder-icon-7')).toBeInTheDocument()
  })
})
