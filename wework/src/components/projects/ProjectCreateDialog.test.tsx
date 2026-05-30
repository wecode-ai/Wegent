import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { ProjectCreateDialog } from './ProjectCreateDialog'

const devices: DeviceInfo[] = [
  {
    id: 1,
    device_id: 'cloud-device',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
  },
  {
    id: 2,
    device_id: 'local-device',
    name: 'Local Device',
    status: 'online',
    is_default: false,
    device_type: 'local',
  },
]

describe('ProjectCreateDialog', () => {
  test('uses the preferred device and keeps form state when device preference changes', async () => {
    const onSelectDevicePreference = vi.fn()

    function Harness() {
      const [preferredDeviceId, setPreferredDeviceId] = useState('local-device')

      return (
        <ProjectCreateDialog
          open
          mode="scratch"
          devices={devices}
          preferredDeviceId={preferredDeviceId}
          onSelectDevicePreference={deviceId => {
            onSelectDevicePreference(deviceId)
            setPreferredDeviceId(deviceId)
          }}
          onClose={vi.fn()}
          onCreateProject={vi.fn()}
          onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
          onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
          onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        />
      )
    }

    render(<Harness />)

    const deviceSelect = screen.getByTestId('project-device-select')
    const projectNameInput = screen.getByTestId('project-name-input')

    expect(deviceSelect).toHaveValue('local-device')

    await userEvent.type(projectNameInput, 'hello')
    await userEvent.selectOptions(deviceSelect, 'cloud-device')

    expect(onSelectDevicePreference).toHaveBeenCalledWith('cloud-device')
    expect(projectNameInput).toHaveValue('hello')
  })

  test('closes when Escape is pressed', () => {
    const onClose = vi.fn()

    render(
      <ProjectCreateDialog
        open
        mode="scratch"
        devices={devices}
        onClose={onClose}
        onCreateProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
