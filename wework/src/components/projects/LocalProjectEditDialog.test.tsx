import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { LocalProjectEditDialog } from './LocalProjectEditDialog'

const pickerMocks = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPickers: pickerMocks.open,
}))

const projectWork = {
  project: {
    key: 'multi-root',
    name: 'Product',
    source: 'local_project',
    stateDeviceId: 'local-device',
    roots: [
      { kind: 'local', path: '/repo/web' },
      { kind: 'local', path: '/repo/api' },
    ],
  },
  deviceWorkspaces: [],
}

const folderPickerProps = {
  device: { device_id: 'local-device', name: 'Local' },
  onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/repo'),
  onListDeviceDirectories: vi.fn().mockResolvedValue([]),
  onCreateDeviceDirectory: vi.fn().mockResolvedValue(undefined),
}

describe('LocalProjectEditDialog', () => {
  test('edits the name, primary folder, and source folder list', async () => {
    pickerMocks.open.mockResolvedValue(['/repo/docs'])
    const onSave = vi.fn().mockResolvedValue(undefined)

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={projectWork}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    const nameInput = screen.getByTestId('local-project-name-input')
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Platform')
    await userEvent.click(screen.getByTestId('make-primary-root-1'))
    expect(screen.getByTestId('local-project-root-0')).toHaveTextContent('api')

    await userEvent.click(screen.getByTestId('add-local-project-folders'))
    expect(await screen.findByText('docs')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('remove-local-project-root-1'))
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(onSave).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'multi-root',
      name: 'Platform',
      roots: ['/repo/api', '/repo/docs'],
      defaultProjectSpace: null,
    })
  })

  test('keeps the final source folder and exposes delete project', async () => {
    const onDelete = vi.fn()
    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={{
          ...projectWork,
          project: { ...projectWork.project, roots: [{ kind: 'local', path: '/repo/web' }] },
        }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onDelete={onDelete}
      />
    )

    expect(screen.getByTestId('remove-local-project-root-0')).toBeDisabled()
    await userEvent.click(screen.getByTestId('delete-local-project-button'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  test('configures whether new conversations automatically join a project space', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const projectSpaceApi = {
      listCloudProjects: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'space-1',
            public_id: 'space-public-1',
            project_key: 'FOLLOWUP',
            name: 'Task Follow-up Board',
            description: '',
            project_store: 'local',
            task_provider: 'local',
            provider_config: {},
            created_by_user_id: 1,
            status: 'active',
            tags: [],
            version: 1,
            created_at: '2026-08-04T00:00:00Z',
            updated_at: '2026-08-04T00:00:00Z',
          },
        ],
      }),
    } as unknown as ProjectSpaceApi

    render(
      <LocalProjectEditDialog
        {...folderPickerProps}
        open
        projectWork={{
          ...projectWork,
          project: {
            ...projectWork.project,
            defaultProjectSpace: { projectStore: 'local', projectId: 'space-1' },
          },
        }}
        projectSpaceApis={[projectSpaceApi]}
        onClose={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    )

    const select = await screen.findByTestId('local-project-auto-join-space-select')
    await waitFor(() => expect(select).toHaveValue('local:space-1'))
    await userEvent.selectOptions(select, '')
    await userEvent.click(screen.getByTestId('save-local-project-button'))

    expect(onSave).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'multi-root',
      name: 'Product',
      roots: ['/repo/web', '/repo/api'],
      defaultProjectSpace: null,
    })
  })
})
