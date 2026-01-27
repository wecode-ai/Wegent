// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor, act } from '@testing-library/react'

// Set a higher default timeout for all tests in this file
jest.setTimeout(15000)

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import AuthGuard from '@/features/common/AuthGuard'
import { userApis } from '@/apis/user'
import { paths } from '@/config/paths'

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
  usePathname: jest.fn(),
  useSearchParams: jest.fn(),
}))

// Mock user APIs
jest.mock('@/apis/user', () => ({
  userApis: {
    isAuthenticated: jest.fn(),
  },
}))

// Mock useTranslation
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

// Common waitFor timeout for async operations
const waitForOptions = { timeout: 10000 }

describe('AuthGuard', () => {
  const mockRouter = {
    replace: jest.fn(),
    push: jest.fn(),
  }

  const mockSearchParams = {
    toString: jest.fn(() => ''),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
    ;(useSearchParams as jest.Mock).mockReturnValue(mockSearchParams)
  })

  describe('Token expiry validation', () => {
    it('should redirect to login when isAuthenticated returns false', async () => {
      // Arrange
      ;(usePathname as jest.Mock).mockReturnValue('/chat')
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Act
      await act(async () => {
        render(
          <AuthGuard>
            <div>Protected Content</div>
          </AuthGuard>
        )
      })

      // Assert
      await waitFor(() => {
        expect(userApis.isAuthenticated).toHaveBeenCalled()
        expect(mockRouter.replace).toHaveBeenCalledWith(
          expect.stringContaining(paths.auth.login.getHref())
        )
      }, waitForOptions)
    })

    it('should render children when isAuthenticated returns true', async () => {
      // Arrange
      ;(usePathname as jest.Mock).mockReturnValue('/chat')
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(true)

      // Act
      let getByText: (text: string) => HTMLElement
      await act(async () => {
        const result = render(
          <AuthGuard>
            <div>Protected Content</div>
          </AuthGuard>
        )
        getByText = result.getByText
      })

      // Assert
      await waitFor(() => {
        expect(userApis.isAuthenticated).toHaveBeenCalled()
        expect(mockRouter.replace).not.toHaveBeenCalled()
        expect(getByText('Protected Content')).toBeInTheDocument()
      }, waitForOptions)
    })

    it('should include redirect path in login URL', async () => {
      // Arrange
      ;(usePathname as jest.Mock).mockReturnValue('/tasks/123')
      mockSearchParams.toString.mockReturnValue('tab=details')
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Act
      await act(async () => {
        render(
          <AuthGuard>
            <div>Protected Content</div>
          </AuthGuard>
        )
      })

      // Assert
      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining('redirect='))
        expect(mockRouter.replace).toHaveBeenCalledWith(
          expect.stringContaining(encodeURIComponent('/tasks/123?tab=details'))
        )
      }, waitForOptions)
    })

    it('should allow access to login page without authentication', async () => {
      // Arrange
      ;(usePathname as jest.Mock).mockReturnValue(paths.auth.login.getHref())
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Act
      let getByText: (text: string) => HTMLElement
      await act(async () => {
        const result = render(
          <AuthGuard>
            <div>Login Page</div>
          </AuthGuard>
        )
        getByText = result.getByText
      })

      // Assert
      await waitFor(() => {
        // Should not call isAuthenticated for allowed paths
        expect(mockRouter.replace).not.toHaveBeenCalled()
        expect(getByText('Login Page')).toBeInTheDocument()
      }, waitForOptions)
    })

    it('should allow access to shared task page without authentication', async () => {
      // Arrange
      ;(usePathname as jest.Mock).mockReturnValue('/shared/task')
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Act
      let getByText: (text: string) => HTMLElement
      await act(async () => {
        const result = render(
          <AuthGuard>
            <div>Shared Task</div>
          </AuthGuard>
        )
        getByText = result.getByText
      })

      // Assert
      await waitFor(() => {
        expect(mockRouter.replace).not.toHaveBeenCalled()
        expect(getByText('Shared Task')).toBeInTheDocument()
      }, waitForOptions)
    })
  })
})
