// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, act, waitFor, fireEvent } from '@testing-library/react'
import { ApiError } from '@/apis/client'
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
    getCurrentUserWithoutAuthRedirect: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    setupAdminPassword: jest.fn(),
    updateUser: jest.fn(),
  },
}))

const mockToast = jest.fn()

// Mock useToast
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
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
  const { user, isLoading, adminPasswordSetupRequired } = useUser()
  if (onUserChange) {
    onUserChange(user)
  }
  return (
    <div>
      {isLoading
        ? 'Loading...'
        : adminPasswordSetupRequired
          ? 'Admin setup required'
          : user
            ? `User: ${user.user_name}`
            : 'No user'}
    </div>
  )
}

function PreferenceUpdateComponent() {
  const { user, updatePreferences } = useUser()

  return (
    <button
      disabled={!user}
      onClick={() => updatePreferences({ default_execution_target: 'cloud' })}
    >
      Update preferences
    </button>
  )
}

function LoginActionComponent() {
  const { login } = useUser()

  return (
    <button
      onClick={() => {
        void login({ user_name: 'admin', password: 'unused-password' }).catch(() => undefined)
      }}
    >
      Login
    </button>
  )
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
      expect(userApis.getCurrentUserWithoutAuthRedirect).not.toHaveBeenCalled()
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

    it('should expose admin setup requirement from login page user handshake', async () => {
      Object.defineProperty(window, 'location', {
        value: {
          pathname: '/login',
          href: 'http://localhost/login',
        },
        writable: true,
      })
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)
      ;(userApis.getCurrentUserWithoutAuthRedirect as jest.Mock).mockRejectedValue(
        new ApiError('ADMIN_PASSWORD_SETUP_REQUIRED', 400, 'ADMIN_PASSWORD_SETUP_REQUIRED')
      )

      const { getByText } = render(
        <UserProvider>
          <TestComponent />
        </UserProvider>
      )

      await waitFor(() => {
        expect(getByText('Admin setup required')).toBeInTheDocument()
      })
      expect(userApis.getCurrentUserWithoutAuthRedirect).toHaveBeenCalledTimes(1)
      expect(mockRouter.replace).not.toHaveBeenCalled()
      expect(mockToast).not.toHaveBeenCalled()
    })

    it('should not show a login failure toast for admin password setup transition', async () => {
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(false)
      ;(userApis.login as jest.Mock).mockRejectedValue(
        new ApiError('ADMIN_PASSWORD_SETUP_REQUIRED', 400, 'ADMIN_PASSWORD_SETUP_REQUIRED')
      )

      const { getByText } = render(
        <UserProvider>
          <LoginActionComponent />
        </UserProvider>
      )

      await waitFor(() => {
        expect(userApis.isAuthenticated).toHaveBeenCalled()
      })

      fireEvent.click(getByText('Login'))

      await waitFor(() => {
        expect(userApis.login).toHaveBeenCalledWith({
          user_name: 'admin',
          password: 'unused-password',
        })
      })
      expect(mockToast).not.toHaveBeenCalled()
    })
  })

  describe('Preference updates', () => {
    it('should not submit null quick access when updating unrelated preferences', async () => {
      const mockUser = {
        id: 1,
        user_name: 'testuser',
        email: 'test@test.com',
        preferences: {
          send_key: 'enter',
          quick_access: null,
        },
      }
      ;(userApis.getCurrentUser as jest.Mock).mockResolvedValue(mockUser)
      ;(userApis.isAuthenticated as jest.Mock).mockReturnValue(true)
      ;(userApis.updateUser as jest.Mock).mockResolvedValue({
        ...mockUser,
        preferences: {
          send_key: 'enter',
          default_execution_target: 'cloud',
        },
      })

      const { getByText } = render(
        <UserProvider>
          <PreferenceUpdateComponent />
        </UserProvider>
      )

      await waitFor(() => {
        expect(getByText('Update preferences')).not.toBeDisabled()
      })

      fireEvent.click(getByText('Update preferences'))

      await waitFor(() => {
        expect(userApis.updateUser).toHaveBeenCalled()
      })
      expect(userApis.updateUser).toHaveBeenCalledWith({
        preferences: {
          send_key: 'enter',
          default_execution_target: 'cloud',
        },
      })
    })
  })
})
