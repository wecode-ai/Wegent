// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, render, waitFor } from '@testing-library/react'

import { VncViewer } from '@wecode/components/cloud-device/VncViewer'
import { loadRFB } from '@wecode/components/cloud-device/rfb-loader'
import { validatedVncSessionUrl, type VncSession } from '@wecode/apis/cloud-devices'

jest.mock('@wecode/components/cloud-device/rfb-loader', () => ({
  loadRFB: jest.fn(),
}))

let mockTranslate = (key: string) => key

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: mockTranslate,
  }),
}))

describe('VncViewer', () => {
  const rfb = {
    addEventListener: jest.fn(),
    compressionLevel: 0,
    disconnect: jest.fn(),
    enableH264: true,
    qualityLevel: 0,
    remoteResizeDebounce: 0,
    remoteResizePixelRatio: 0,
  }
  const RFB = jest.fn(() => rfb)

  beforeEach(() => {
    jest.clearAllMocks()
    mockTranslate = (key: string) => key
    ;(loadRFB as jest.Mock).mockResolvedValue(RFB)
  })

  test('uses only the supplied session URL and configures balanced rendering', async () => {
    render(
      <VncViewer
        websocketUrl="wss://backend.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use"
        onReconnectRequired={jest.fn()}
      />
    )

    await waitFor(() => {
      expect(RFB).toHaveBeenCalledWith(
        expect.any(HTMLDivElement),
        'wss://backend.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use'
      )
    })
    expect(rfb.qualityLevel).toBe(8)
    expect(rfb.compressionLevel).toBe(2)
    expect(rfb.remoteResizeDebounce).toBe(250)
    expect(rfb.enableH264).toBe(false)
  })

  test('does not reconnect with a consumed ticket when the translation changes', async () => {
    const onReconnectRequired = jest.fn()
    const websocketUrl =
      'wss://backend.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use'
    const { rerender } = render(
      <VncViewer websocketUrl={websocketUrl} onReconnectRequired={onReconnectRequired} />
    )
    await waitFor(() => expect(RFB).toHaveBeenCalledTimes(1))

    mockTranslate = (key: string) => 'translated:' + key
    rerender(<VncViewer websocketUrl={websocketUrl} onReconnectRequired={onReconnectRequired} />)

    expect(RFB).toHaveBeenCalledTimes(1)
    expect(rfb.disconnect).not.toHaveBeenCalled()
  })

  test('ignores a stale bundle load after the session URL changes', async () => {
    let resolveRfb!: (constructor: typeof RFB) => void
    ;(loadRFB as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        resolveRfb = resolve
      })
    )
    const onReconnectRequired = jest.fn()
    const { rerender } = render(
      <VncViewer
        websocketUrl="wss://backend.example.com/old"
        onReconnectRequired={onReconnectRequired}
      />
    )
    rerender(
      <VncViewer
        websocketUrl="wss://backend.example.com/new"
        onReconnectRequired={onReconnectRequired}
      />
    )

    await act(async () => resolveRfb(RFB))

    expect(RFB).toHaveBeenCalledTimes(1)
    expect(RFB).toHaveBeenCalledWith(expect.any(HTMLDivElement), 'wss://backend.example.com/new')
  })
})

describe('validatedVncSessionUrl', () => {
  const session: VncSession = {
    session_id: 'vnc-session-1',
    device_id: 'device-1',
    type: 'vnc',
    path: '',
    url: 'wss://backend.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use',
    transport: 'websocket',
  }

  test('accepts only the matching one-time ticket path', () => {
    expect(validatedVncSessionUrl(session)).toBe(session.url)
  })

  test.each([
    'wss://backend.example.com/vnc-proxy/device-1?token=long-lived-jwt',
    'wss://user:password@backend.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use',
    'wss://backend.example.com/vnc-proxy/sessions/other-session?ticket=single-use',
    'wss://backend.example.com/vnc-proxy/sessions/vnc-session-1?ticket=one&token=two',
  ])('rejects unsafe session URL %s', url => {
    expect(() => validatedVncSessionUrl({ ...session, url })).toThrow(
      'Backend returned an invalid VNC session'
    )
  })
})
