// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { userApis } from '@/apis/user'
import { User } from '@/types/api'
import { App } from 'antd'

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
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态

  const fetchUser = async () => {
    setIsLoading(true)
    // 已用 antd message.error 统一错误提示，无需本地 error 状态
    try {
      if (!userApis.isAuthenticated()) {
        setUser(null)
        setIsLoading(false)
        return
      }
      const userData = await userApis.getCurrentUser()
      setUser(userData)
    } catch (e: any) {
      message.error('Failed to load user')
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

  // Login method
  const login = async (data: any) => {
    setIsLoading(true)
    // 已用 antd message.error 统一错误提示，无需本地 error 状态
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