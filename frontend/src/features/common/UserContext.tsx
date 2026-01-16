// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react'
import { userApis } from '@/apis/user'
import { User } from '@/types/api'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'
import { useToast } from '@/hooks/use-toast'

interface UserContextType {
  user: User | null
  isLoading: boolean
  logout: () => void
  refresh: () => Promise<void>
  login: (data: { user_name: string; password: string }) => Promise<void>
}
const UserContext = createContext<UserContextType>({
  user: null,
  isLoading: true,
  logout: () => {},
  refresh: async () => {},
  login: async () => {},
})
export const UserProvider = ({ children }: { children: ReactNode }) => {
  const { toast } = useToast()
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Use ref to avoid closure issues in setInterval callback
  const userRef = useRef<User | null>(null)
  // Using antd message.error for unified error handling, no local error state needed

  // Keep userRef in sync with user state
  useEffect(() => {
    userRef.current = user
  }, [user])

  const redirectToLogin = () => {
    const loginPath = paths.auth.login.getHref()
    if (typeof window === 'undefined') {
      router.replace(loginPath)
      return
    }
    if (window.location.pathname === loginPath) {
      return
    }
    const disallowedTargets = [loginPath, '/login/oidc']
    const currentPathWithSearch = `${window.location.pathname}${window.location.search}`
    const validRedirect = sanitizeRedirectPath(currentPathWithSearch, disallowedTargets)

    if (validRedirect) {
      sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, validRedirect)
      router.replace(`${loginPath}?redirect=${encodeURIComponent(validRedirect)}`)
      return
    }

    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
    router.replace(loginPath)
  }

  const fetchUser = async () => {
    setIsLoading(true)

    try {
      const isAuth = userApis.isAuthenticated()

      if (!isAuth) {
        console.log(
          'UserContext: User not authenticated, clearing user state and redirecting to login'
        )
        setUser(null)
        setIsLoading(false)
        redirectToLogin()
        return
      }

      const userData = await userApis.getCurrentUser()
      setUser(userData)
    } catch (error) {
      console.error('UserContext: Failed to fetch user information:', error as Error)
      toast({
        variant: 'destructive',
        title: 'Failed to load user',
      })
      setUser(null)
      redirectToLogin()
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchUser()

    // Listen for OIDC login success event
    const handleOidcLoginSuccess = () => {
      console.log('Received OIDC login success event, refreshing user information')
      fetchUser()
    }

    window.addEventListener('oidc-login-success', handleOidcLoginSuccess)

    // Periodically check if token is expired (check every 10 seconds)
    const tokenCheckInterval = setInterval(() => {
      const isAuth = userApis.isAuthenticated()
      // Use userRef.current to avoid closure capturing stale user state
      if (!isAuth && userRef.current) {
        console.log('Token expired, auto logout')
        setUser(null)
        redirectToLogin()
      }
    }, 10000)

    return () => {
      window.removeEventListener('oidc-login-success', handleOidcLoginSuccess)
      clearInterval(tokenCheckInterval)
    }
    // eslint-disable-next-line
  }, [])

  const logout = () => {
    console.log('Executing logout operation')
    userApis.logout()
    setUser(null)
    redirectToLogin()
  }

  const login = async (data: { user_name: string; password: string }) => {
    setIsLoading(true)
    try {
      const userData = await userApis.login(data)
      setUser(userData)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || 'Login failed',
      })
      setUser(null)
      throw error
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <UserContext.Provider value={{ user, isLoading, logout, refresh: fetchUser, login }}>
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => useContext(UserContext)
