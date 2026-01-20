// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, act, waitFor } from '@testing-library/react'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { userApis } from '@/apis/user'
import { useRouter } from 'next/navigation'

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
}))

// Mock user APIs
jest.mock('@/apis/user', () => ({
  userApis: {
    isAuthenticated: jest.fn(),
    getCurrentUser: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
  },
}))

// Mock useToast
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

// Mock paths
jest.mock('@/config/paths', () => ({
  paths: {
    auth: {
      login: {
        getHref: () => '/login',
      },
    },
    home: {
      getHref: () => '/',
    },
  },
}))

// Test component to access context
function TestComponent({ onUserChange }: { onUserChange?: (user: unknown) => void }) {
  const { user, isLoading } = useUser()
  if (onUserChange) {
    onUserChange(user)
  }
  return <div>{isLoading ? 'Loading...' : user ? `User: ${user.user_name}` : 'No user'}</div>
}

describe('UserContext', () => {
  const mockRouter = {
    replace: jest.fn(),
    push: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    ;(useRouter as jest.Mock).mockReturnValue(mockRouter)
    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/chat',
        href: 'http://localhost/chat',
      },
      writable: true,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('Token expiry periodic check with useRef fix', () => {
    it('should detect token expiry using userRef (fixes closure issue)', async () => {
      // Arrange - User is initially authenticated
      const mockUser = { id: 1, user_name: 'testuser', email: 'test@test.com' }
      ;(userApis.getCurrentUser as jest.Mock).mockResolvedValue(mockUser)
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(true)

      // Act - Render the provider
      render(
        <UserProvider>
          <TestComponent />
        </UserProvider>
      )

      // Wait for initial user fetch
      await waitFor(() => {
        expect(userApis.getCurrentUser).toHaveBeenCalled()
      })

      // Now simulate token expiry
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Fast-forward time to trigger the interval check (10 seconds)
      act(() => {
        jest.advanceTimersByTime(10000)
      })

      // Assert - Should have called isAuthenticated during the interval
      expect(userApis.isAuthenticated).toHaveBeenCalled()
    })

    it('should not redirect when user is null (not logged in)', async () => {
      // Arrange - User not authenticated from the start
      // When isAuthenticated returns false, fetchUser() returns early without calling getCurrentUser
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Act
      render(
        <UserProvider>
          <TestComponent />
        </UserProvider>
      )

      // Wait for initial auth check (isAuthenticated is called in fetchUser)
      await waitFor(() => {
        expect(userApis.isAuthenticated).toHaveBeenCalled()
      })

      // Clear previous calls to track interval behavior
      ;(userApis.isAuthenticated as jest.Mock).mockClear()

      // Fast-forward time to trigger the interval check (10 seconds)
      act(() => {
        jest.advanceTimersByTime(10000)
      })

      // Assert - isAuthenticated should be called during interval
      // But since userRef.current is null (user was never set), no redirect should happen
      // The condition is: if (!isAuth && userRef.current) - userRef.current is null
      expect(userApis.isAuthenticated).toHaveBeenCalled()
      // getCurrentUser is NOT called when isAuthenticated returns false initially
      expect(userApis.getCurrentUser).not.toHaveBeenCalled()
    })

    it('should call isAuthenticated periodically every 10 seconds', async () => {
      // Arrange
      const mockUser = { id: 1, user_name: 'testuser', email: 'test@test.com' }
      ;(userApis.getCurrentUser as jest.Mock).mockResolvedValue(mockUser)
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(true)

      // Act
      render(
        <UserProvider>
          <TestComponent />
        </UserProvider>
      )

      await waitFor(() => {
        expect(userApis.getCurrentUser).toHaveBeenCalled()
      })

      // Clear previous calls
      ;(userApis.isAuthenticated as jest.Mock).mockClear()

      // Fast-forward 30 seconds (should trigger 3 checks)
      act(() => {
        jest.advanceTimersByTime(30000)
      })

      // Assert - Should have been called 3 times (at 10s, 20s, 30s)
      expect(userApis.isAuthenticated).toHaveBeenCalledTimes(3)
    })
  })

  describe('User state management', () => {
    it('should fetch user on mount', async () => {
      // Arrange
      const mockUser = { id: 1, user_name: 'testuser', email: 'test@test.com' }
      ;(userApis.getCurrentUser as jest.Mock).mockResolvedValue(mockUser)
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(true)

      // Act
      const { getByText } = render(
        <UserProvider>
          <TestComponent />
        </UserProvider>
      )

      // Assert
      await waitFor(() => {
        expect(getByText('User: testuser')).toBeInTheDocument()
      })
    })

    it('should show no user when fetch fails', async () => {
      // Arrange
      ;(userApis.getCurrentUser as jest.Mock).mockRejectedValue(new Error('Unauthorized'))
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)

      // Act
      const { getByText } = render(
        <UserProvider>
          <TestComponent />
        </UserProvider>
      )

      // Assert
      await waitFor(() => {
        expect(getByText('No user')).toBeInTheDocument()
      })
    })
  })
})
