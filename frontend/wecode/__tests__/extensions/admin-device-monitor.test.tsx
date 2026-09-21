// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

import type { AdminDeviceInfo } from '@/apis/admin'
import { useAdminDeviceMonitorExtension } from '@extensions/admin-device-monitor'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/features/layout/hooks/useMediaQuery', () => ({
  useIsMobile: () => false,
}))

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@wecode/components/cloud-device', () => ({
  DeviceVncPanel: ({
    deviceId,
    ownerUserId,
    title,
    containerClassName,
  }: {
    deviceId: string
    ownerUserId?: number
    title?: string
    containerClassName?: string
  }) => (
    <div
      data-testid="mock-device-vnc-panel"
      data-title={title}
      data-container-class={containerClassName}
    >
      {deviceId}:{ownerUserId}
    </div>
  ),
}))

function buildDevice(overrides: Partial<AdminDeviceInfo> = {}): AdminDeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'device-name',
    status: 'online',
    device_type: 'local',
    bind_shell: 'claudecode',
    user_id: 1,
    user_name: 'alice',
    client_ip: '127.0.0.1',
    executor_version: '1.7.0',
    slot_used: 0,
    slot_max: 0,
    created_at: '2026-03-31T12:00:00',
    ...overrides,
  }
}

function ExtensionHarness({ devices }: { devices: AdminDeviceInfo[] }) {
  const extension = useAdminDeviceMonitorExtension(devices)

  return (
    <div>
      <div>
        {devices.map(device => (
          <React.Fragment key={`${device.device_id}-${device.user_id}`}>
            {extension.renderAction(device)}
          </React.Fragment>
        ))}
      </div>
      {extension.renderPanel()}
    </div>
  )
}

describe('useAdminDeviceMonitorExtension', () => {
  it('renders the VNC action and opens the panel for online cloud Claude Code devices', () => {
    const devices = [
      buildDevice({
        id: 2,
        device_id: 'device-cloud-1',
        name: 'cloud-device',
        device_type: 'cloud',
        user_id: 99,
        user_name: 'bob',
        client_ip: '10.0.0.1',
      }),
    ]

    render(<ExtensionHarness devices={devices} />)

    const button = screen.getByTestId('vnc-device-device-cloud-1')
    expect(button).toBeEnabled()

    fireEvent.click(button)

    expect(screen.getByTestId('admin-device-vnc-panel')).toBeInTheDocument()
    expect(screen.getByTestId('mock-device-vnc-panel')).toHaveTextContent('device-cloud-1:99')
    expect(screen.getByTestId('mock-device-vnc-panel')).toHaveAttribute(
      'data-title',
      'vnc_panel_title - cloud-device'
    )
    expect(screen.getByTestId('mock-device-vnc-panel')).toHaveAttribute(
      'data-container-class',
      'w-full h-[60vh] min-h-[60vh]'
    )
  })

  it('does not render a VNC action for unsupported devices', () => {
    const devices = [
      buildDevice({
        id: 3,
        device_id: 'device-local-1',
        name: 'local-device',
        device_type: 'local',
      }),
      buildDevice({
        id: 4,
        device_id: 'device-cloud-openclaw',
        name: 'openclaw-cloud',
        device_type: 'cloud',
        bind_shell: 'openclaw',
        user_id: 2,
        user_name: 'bob',
        client_ip: '10.0.0.2',
      }),
    ]

    render(<ExtensionHarness devices={devices} />)

    expect(screen.queryByTestId('vnc-device-device-local-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('vnc-device-device-cloud-openclaw')).not.toBeInTheDocument()
  })

  it('renders VNC action for offline cloud Claude Code devices (admin only)', () => {
    const offlineDevice = buildDevice({
      id: 5,
      device_id: 'device-cloud-offline',
      name: 'cloud-device-offline',
      device_type: 'cloud',
      status: 'offline',
      user_id: 7,
      client_ip: '10.0.0.3',
    })

    render(<ExtensionHarness devices={[offlineDevice]} />)

    const button = screen.getByTestId('vnc-device-device-cloud-offline')
    expect(button).toBeEnabled()

    fireEvent.click(button)

    expect(screen.getByTestId('admin-device-vnc-panel')).toBeInTheDocument()
  })

  it('closes the panel when the active device is no longer available for VNC', () => {
    const onlineDevice = buildDevice({
      id: 6,
      device_id: 'device-cloud-3',
      name: 'cloud-device-3',
      device_type: 'cloud',
      user_id: 8,
      client_ip: '10.0.0.4',
    })

    const { rerender } = render(<ExtensionHarness devices={[onlineDevice]} />)

    fireEvent.click(screen.getByTestId('vnc-device-device-cloud-3'))
    expect(screen.getByTestId('admin-device-vnc-panel')).toBeInTheDocument()

    // Panel closes when device changes to local (no longer cloud)
    rerender(
      <ExtensionHarness
        devices={[
          {
            ...onlineDevice,
            device_type: 'local',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('admin-device-vnc-panel')).not.toBeInTheDocument()
  })
})
