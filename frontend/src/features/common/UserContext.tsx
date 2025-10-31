// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { userApis } from '@/apis/user'
import { User } from '@/types/api'
import { App } from 'antd'
import { useRouter } from 'next/navigation'

interface UserContextType {
  user: User | null
  isLoading: boolean
  logout: () => void
  refresh: () => Promise<void>
  login: (data: any) => Promise<void>
}
const UserContext = createContext<UserContextType>({
  user: null,
  isLoading: true,
  logout: () => {},
  refresh: async () => {},
  login: async () => {},
});
export const UserProvider = ({ children }: { children: ReactNode }) => {
  const { message } = App.useApp()
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Using antd message.error for unified error handling, no local error state needed

  const fetchUser = async () => {
    setIsLoading(true)

    try {
      const isAuth = userApis.isAuthenticated()

      if (!isAuth) {
        console.log('UserContext: User not authenticated, clearing user state and redirecting to login')
        setUser(null)
        setIsLoading(false)
        router.replace('/login')
        return
      }

      const userData = await userApis.getCurrentUser()
      setUser(userData)
    } catch (e: any) {
      console.error('UserContext: Failed to fetch user information:', e)
      message.error('Failed to load user')
      setUser(null)
      router.replace('/login')
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
      if (!isAuth && user) {
        console.log('Token expired, auto logout')
        setUser(null)
        router.replace('/login')
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
    router.replace('/login')
  }

  const login = async (data: any) => {
    setIsLoading(true)
    try {
      const userData = await userApis.login(data)
      setUser(userData)
    } catch (e: any) {
      message.error(e?.message || 'Login failed')
      setUser(null)
      throw e
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