// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import Page from '@/app/auth/connector/authorize/page'
import { authorizeConnectorApp } from '@/features/settings/connectorOAuth'

jest.mock('next/navigation', () => ({ useRouter: () => ({}) }))

jest.mock('@/features/common/UserContext', () => ({
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useUser: () => ({ user: { id: 7, user_name: 'alice' }, isLoading: false }),
}))

jest.mock('@/hooks/useSessionToken', () => ({ useSessionToken: () => 'session' }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/settings/connectorOAuth', () => ({
  authorizeConnectorApp: jest.fn(),
}))

const mockAuthorize = jest.mocked(authorizeConnectorApp)

describe('Connector authorization links', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockAuthorize.mockReset().mockResolvedValue(undefined)
    history.replaceState({}, '', '/auth/connector/authorize#slug=docs&ticket=original')
  })

  it('replaces a completed consent when a new link opens in the same tab', async () => {
    render(<Page />)

    fireEvent.click(screen.getByTestId('authorize-external-connector'))
    expect(await screen.findByTestId('external-connector-authorized')).toBeVisible()
    expect(mockAuthorize).toHaveBeenLastCalledWith(
      'docs',
      expect.objectContaining({ authorizationTicket: 'original' })
    )

    window.location.hash = 'slug=wiki&ticket=replacement'
    fireEvent.click(await screen.findByTestId('authorize-external-connector'))

    expect(await screen.findByTestId('external-connector-authorized')).toBeVisible()
    expect(mockAuthorize).toHaveBeenLastCalledWith(
      'wiki',
      expect.objectContaining({ authorizationTicket: 'replacement' })
    )
    expect(window.location.hash).toBe('')
  })

  it('restores the authorization request when returning from login', async () => {
    const { unmount } = render(<Page />)
    expect(window.location.hash).toBe('')
    unmount()

    render(<Page />)
    fireEvent.click(screen.getByTestId('authorize-external-connector'))

    expect(await screen.findByTestId('external-connector-authorized')).toBeVisible()
    expect(mockAuthorize).toHaveBeenCalledWith(
      'docs',
      expect.objectContaining({ authorizationTicket: 'original' })
    )
  })
})
