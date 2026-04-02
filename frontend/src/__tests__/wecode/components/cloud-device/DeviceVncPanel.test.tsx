// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DeviceVncPanel } from '@wecode/components/cloud-device'
import { cloudDeviceApis } from '@wecode/apis'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          vnc_panel_title: 'Remote Desktop',
          vnc_files_tab: 'Files',
          vnc_desktop_tab: 'Desktop',
          vnc_files_loading: 'Loading files service...',
          vnc_files_unavailable: 'Files service unavailable',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@wecode/apis', () => ({
  cloudDeviceApis: {
    getFileConfig: jest.fn(),
  },
}))

jest.mock('@wecode/components/cloud-device/VncViewer', () => ({
  VncViewer: ({ deviceId }: { deviceId: string }) => <div data-testid="vnc-viewer">{deviceId}</div>,
}))

describe('DeviceVncPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('keeps desktop as default tab and renders iframe when files tab is available', async () => {
    const user = userEvent.setup()
    ;(cloudDeviceApis.getFileConfig as jest.Mock).mockResolvedValue({
      sandbox_id: 'sandbox-1',
      ip_address: '10.2.247.79',
      files_url: 'http://10.2.247.79:8080/files/',
      available: true,
    })

    render(<DeviceVncPanel deviceId="device-1" onClose={jest.fn()} />)

    expect(screen.getByTestId('vnc-viewer')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Files' }))

    await waitFor(() => {
      expect(cloudDeviceApis.getFileConfig).toHaveBeenCalledWith('device-1')
    })

    expect(screen.getByTestId('cloud-device-files-frame')).toHaveClass(
      'relative',
      'min-h-0',
      'flex-1',
      'overflow-hidden'
    )
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
    const iframe = await screen.findByTitle('Files')
    expect(iframe).toHaveClass('absolute', 'inset-0', 'block', 'h-full', 'w-full')
    expect(iframe).toHaveAttribute('src', 'http://10.2.247.79:8080/files/')
  })

  test('shows unavailable state when files service is not reachable', async () => {
    const user = userEvent.setup()
    ;(cloudDeviceApis.getFileConfig as jest.Mock).mockResolvedValue({
      sandbox_id: 'sandbox-1',
      ip_address: '10.2.247.79',
      files_url: 'http://10.2.247.79:8080/files/',
      available: false,
    })

    render(<DeviceVncPanel deviceId="device-1" onClose={jest.fn()} />)

    await user.click(screen.getByRole('tab', { name: 'Files' }))

    expect(await screen.findByText('Files service unavailable')).toBeInTheDocument()
    expect(screen.queryByTitle('Files')).not.toBeInTheDocument()
  })
})
