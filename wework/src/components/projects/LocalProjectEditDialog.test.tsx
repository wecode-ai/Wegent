import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
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
})
