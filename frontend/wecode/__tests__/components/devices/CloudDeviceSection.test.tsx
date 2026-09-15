// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { DeviceInfo } from '@/apis/devices'
import { CloudDeviceSection } from '@wecode/components/devices/CloudDeviceSection'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@wecode/components/devices/DeviceMetrics', () => ({
  DeviceMetrics: () => null,
}))

jest.mock('@wecode/apis/cloud-devices', () => ({
  cloudDeviceApis: {
    deleteCloudDevice: jest.fn(),
  },
}))

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

function createCloudDevice(overrides: Partial<DeviceInfo>): DeviceInfo {
  return {
    id: 1,
    device_id: 'executor-device',
    name: 'Executor Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: '2.0.14',
    latest_version: '2.0.14',
    update_available: false,
    bind_shell: 'claudecode',
    cloud_config: {
      sandboxId: 'sandbox-1',
      imageId: 'image-1',
      createdAt: '2026-09-02T00:00:00Z',
    },
    ...overrides,
  }
}

const executor = createCloudDevice({})
const openClaw = createCloudDevice({
  id: 2,
  device_id: 'openclaw-device',
  name: 'OpenClaw Device',
  bind_shell: 'openclaw',
})

const handlers = {
  onDeviceCreated: jest.fn(),
  onDeleteDevice: jest.fn().mockResolvedValue(undefined),
  onSetDefault: jest.fn().mockResolvedValue(undefined),
  onStartTask: jest.fn(),
  onCancelTask: jest.fn().mockResolvedValue(undefined),
}

describe('CloudDeviceSection', () => {
  it('keeps Executor and OpenClaw in the same machine card when advanced devices appear', () => {
    const { rerender } = render(<CloudDeviceSection cloudDevices={[executor]} {...handlers} />)

    expect(screen.getAllByTestId(/^cloud-machine-card-/)).toHaveLength(1)
    expect(screen.getByTestId('cloud-runtime-row-claudecode-executor-device')).toHaveTextContent(
      'Executor Device'
    )
    expect(screen.queryByTestId(/^cloud-runtime-row-openclaw-/)).not.toBeInTheDocument()

    rerender(<CloudDeviceSection cloudDevices={[openClaw, executor]} {...handlers} />)

    expect(screen.getAllByTestId(/^cloud-machine-card-/)).toHaveLength(1)
    expect(screen.getAllByTestId(/^cloud-runtime-row-/).map(row => row.textContent)).toEqual([
      expect.stringContaining('Executor Device'),
      expect.stringContaining('OpenClaw Device'),
    ])
  })

  it('highlights the machine containing the requested device', () => {
    render(
      <CloudDeviceSection
        cloudDevices={[openClaw, executor]}
        highlightedDeviceId={openClaw.id}
        {...handlers}
      />
    )

    expect(screen.getByTestId('cloud-machine-card-sandbox-1')).toHaveAttribute(
      'data-highlighted',
      'true'
    )
    expect(screen.getByTestId('cloud-runtime-row-openclaw-openclaw-device')).toHaveAttribute(
      'data-device-record-id',
      String(openClaw.id)
    )
  })
})
