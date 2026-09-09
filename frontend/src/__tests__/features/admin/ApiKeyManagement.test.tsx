// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import ApiKeyManagement from '@/features/admin/components/ApiKeyManagement'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/admin/components/ServiceKeyList', () => ({
  __esModule: true,
  default: () => <div data-testid="service-key-list-mock" />,
}))

jest.mock('@/features/admin/components/PluginReleaseKeyList', () => ({
  __esModule: true,
  default: () => <div data-testid="plugin-release-key-list-mock" />,
}))

jest.mock('@/features/admin/components/PersonalKeyList', () => ({
  __esModule: true,
  default: () => <div data-testid="personal-key-list-mock" />,
}))

jest.mock('@/features/admin/components/OutboundTokenIssuerList', () => ({
  __esModule: true,
  default: () => <div data-testid="outbound-token-list-mock" />,
}))

jest.mock('@/features/settings/components/OAuthClientManagement', () => ({
  __esModule: true,
  default: () => <div data-testid="oauth-client-list-mock" />,
}))

describe('ApiKeyManagement', () => {
  it('opens the dedicated plugin release key management tab', () => {
    render(<ApiKeyManagement />)

    expect(screen.getByTestId('service-key-list-mock')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('plugin-release-keys-tab-button'))

    expect(screen.getByTestId('plugin-release-key-list-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('service-key-list-mock')).not.toBeInTheDocument()
  })
})
