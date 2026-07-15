// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from '@testing-library/react'

import { getToken } from '@/apis/user'
import { getSocketUrl } from '@/lib/runtime-config'
import { VncViewer } from '@wecode/components/cloud-device/VncViewer'
import { loadRFB } from '@wecode/components/cloud-device/rfb-loader'

jest.mock('@/apis/user', () => ({
  getToken: jest.fn(),
}))

jest.mock('@/lib/runtime-config', () => ({
  getSocketUrl: jest.fn(),
}))

jest.mock('@wecode/components/cloud-device/rfb-loader', () => ({
  loadRFB: jest.fn(),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('VncViewer', () => {
  const rfb = {
    addEventListener: jest.fn(),
    disconnect: jest.fn(),
  }
  const RFB = jest.fn(() => rfb)

  beforeEach(() => {
    jest.clearAllMocks()
    ;(getToken as jest.Mock).mockReturnValue('test-token')
    ;(getSocketUrl as jest.Mock).mockReturnValue('https://backend.example.com')
    ;(loadRFB as jest.Mock).mockResolvedValue(RFB)
  })

  test('uses the VNC proxy path when a socket base URL is configured', async () => {
    render(<VncViewer deviceId="device-1" />)

    await waitFor(() => {
      expect(RFB).toHaveBeenCalledWith(
        expect.any(HTMLDivElement),
        'wss://backend.example.com/vnc-proxy/device-1?token=test-token'
      )
    })
  })
})
