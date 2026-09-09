// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { adminApis, PluginReleaseKey } from '@/apis/admin'
import PluginReleaseKeyList from '@/features/admin/components/PluginReleaseKeyList'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    getPluginReleaseKeys: jest.fn(),
    createPluginReleaseKey: jest.fn(),
    togglePluginReleaseKeyStatus: jest.fn(),
  },
}))

const toastMock = jest.fn()
const mockTranslation = (key: string) => key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslation }),
}))

const activeReleaseKey: PluginReleaseKey = {
  id: 7,
  name: 'wework-plugins release bot',
  keyPrefix: 'wg-abcd1234...',
  description: 'Protected master pipeline',
  expiresAt: '9999-12-31T23:59:59Z',
  lastUsedAt: '2026-09-02T00:00:00Z',
  createdAt: '2026-09-01T00:00:00Z',
  isActive: true,
  createdBy: 'admin',
}

const mockedAdminApis = adminApis as jest.Mocked<typeof adminApis>

describe('PluginReleaseKeyList', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedAdminApis.getPluginReleaseKeys.mockResolvedValue({
      items: [activeReleaseKey],
      total: 1,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it('loads release keys and toggles their active status', async () => {
    mockedAdminApis.togglePluginReleaseKeyStatus.mockResolvedValue({
      ...activeReleaseKey,
      isActive: false,
    })

    render(<PluginReleaseKeyList showHeader={false} />)

    expect(await screen.findByTestId('plugin-release-key-row-7')).toHaveTextContent(
      'wework-plugins release bot'
    )
    expect(screen.getByTestId('plugin-release-key-row-7')).toHaveTextContent(
      'plugin_release_keys.never_expires'
    )
    fireEvent.click(screen.getByTestId('plugin-release-key-toggle-7'))

    await waitFor(() =>
      expect(mockedAdminApis.togglePluginReleaseKeyStatus).toHaveBeenCalledWith(7)
    )
    expect(await screen.findByText('plugin_release_keys.status_disabled')).toBeInTheDocument()
  })

  it('creates a release key and shows the raw token only in the result dialog', async () => {
    mockedAdminApis.createPluginReleaseKey.mockResolvedValue({
      ...activeReleaseKey,
      id: 8,
      key: 'wg-secret-release-token',
    })

    render(<PluginReleaseKeyList showHeader={false} />)

    await screen.findByTestId('plugin-release-key-create-button')
    fireEvent.click(screen.getByTestId('plugin-release-key-create-button'))
    expect(screen.queryByTestId('plugin-release-key-expires-input')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('plugin-release-key-name-input'), {
      target: { value: 'release key' },
    })
    fireEvent.change(screen.getByTestId('plugin-release-key-description-input'), {
      target: { value: 'GitLab protected master' },
    })
    fireEvent.click(screen.getByTestId('plugin-release-key-create-submit'))

    await waitFor(() =>
      expect(mockedAdminApis.createPluginReleaseKey).toHaveBeenCalledWith({
        name: 'release key',
        description: 'GitLab protected master',
      })
    )
    expect(await screen.findByTestId('plugin-release-key-created-value')).toHaveTextContent(
      'wg-secret-release-token'
    )

    fireEvent.click(screen.getByTestId('plugin-release-key-copy-button'))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wg-secret-release-token')
    )
  })
})
