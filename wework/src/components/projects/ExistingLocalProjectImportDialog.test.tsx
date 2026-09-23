import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { ProjectWithTasks } from '@/types/api'
import { ExistingLocalProjectImportDialog } from './ExistingLocalProjectImportDialog'

const projects: ProjectWithTasks[] = [
  {
    id: 1,
    name: 'wegent',
    config: {
      mode: 'workspace',
      execution: { targetType: 'local', deviceId: 'local-device' },
      workspace: { source: 'local_path', localPath: '/workspace/wegent' },
    },
    tasks: [],
  },
  {
    id: 2,
    name: 'wecode-proxy',
    config: {
      mode: 'workspace',
      execution: { targetType: 'local', deviceId: 'local-device' },
      workspace: { source: 'local_path', localPath: '/workspace/wecode-proxy' },
    },
    tasks: [],
  },
]

describe('ExistingLocalProjectImportDialog', () => {
  test('imports the selected task project', async () => {
    const onImport = vi.fn().mockResolvedValue(undefined)
    render(
      <ExistingLocalProjectImportDialog
        open
        projects={projects}
        onClose={vi.fn()}
        onImport={onImport}
      />
    )

    expect(screen.getByText('/workspace/wegent')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('existing-local-project-option-2'))
    await userEvent.click(screen.getByTestId('confirm-existing-local-project-import'))

    expect(onImport).toHaveBeenCalledWith(projects[1])
  })

  test('shows an empty state when every task project is already in collaboration', () => {
    render(
      <ExistingLocalProjectImportDialog open projects={[]} onClose={vi.fn()} onImport={vi.fn()} />
    )

    expect(screen.getByTestId('existing-local-project-import-empty')).toHaveTextContent(
      '任务中的本地项目都已加入协作空间。'
    )
    expect(screen.getByTestId('confirm-existing-local-project-import')).toBeDisabled()
  })
})
