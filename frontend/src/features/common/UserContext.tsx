// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { userApis } from '@/apis/user'
import { User } from '@/types/api'

interface UserContextType {
  user: User | null
  isLoading: boolean
  error: string
  logout: () => void
  refresh: () => Promise<void>
  login: (data: any) => Promise<void>
}
const UserContext = createContext<UserContextType>({
  user: null,
  isLoading: true,
  error: '',
  logout: () => { },
  refresh: async () => { },
  login: async () => { },
})

export const UserProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchUser = async () => {
    setIsLoading(true)
    setError('')
    try {
      if (!userApis.isAuthenticated()) {
        setUser(null)
        setIsLoading(false)
        return
      }
      const userData = await userApis.getCurrentUser()
      setUser(userData)
    } catch (e: any) {
      setError('Failed to load user')
      setUser(null)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchUser()
    // eslint-disable-next-line
  }, [])

  const logout = () => {
    userApis.logout()
  }

  // 登录方法
  const login = async (data: any) => {
    setIsLoading(true)
    setError('')
    try {
      const userData = await userApis.login(data)
      setUser(userData)
    } catch (e: any) {
      setError(e?.message || 'Login failed')
      setUser(null)
      throw e
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <UserContext.Provider value={{ user, isLoading, error, logout, refresh: fetchUser, login }}>
      {children}
    </UserContext.Provider>
  )
}

export const useUser = () => useContext(UserContext)