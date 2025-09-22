// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Button } from '@headlessui/react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { paths } from '@/config/paths'
import { App } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'
import LanguageSwitcher from '@/components/LanguageSwitcher'

export default function LoginForm() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const router = useRouter()
  const [formData, setFormData] = useState({
    user_name: 'admin',
    password: 'admin'
  })
  const [showPassword, setShowPassword] = useState(false)
  // 已用 antd message.error 统一错误提示，无需本地 error 状态
  const [isLoading, setIsLoading] = useState(false)

  // 获取登录模式配置
  const loginMode = process.env.NEXT_PUBLIC_LOGIN_MODE || 'all'
  const showPasswordLogin = loginMode === 'password' || loginMode === 'all'
  const showOidcLogin = loginMode === 'oidc' || loginMode === 'all'

  // 获取 OIDC 登录按钮文本
  const oidcLoginText = process.env.NEXT_PUBLIC_OIDC_LOGIN_TEXT || 'Login with OpenID Connect'

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value
    }))
    // 已用 antd message.error 统一错误提示，无需本地 error 状态
  }

  const { user, refresh, isLoading: userLoading, login } = useUser()
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (user) {
      router.replace(paths.task.getHref())
      return
    }
    setIsLoading(true)
    // 已用 antd message.error 统一错误提示，无需本地 error 状态

    try {
      await login({
        user_name: formData.user_name,
        password: formData.password
      })
      router.replace(paths.task.getHref())
    } catch (error: any) {
      message.error(error.message || 'Login failed, please check username and password')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 语言切换器 */}
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      {/* 密码登录表单 */}
      {showPasswordLogin && (
        <form className="space-y-6" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="user_name" className="block text-sm font-medium text-gray-300">
              Username
            </label>
            <div className="mt-1">
              <input
                id="user_name"
                name="user_name"
                type="text"
                autoComplete="username"
                required
                value={formData.user_name}
                onChange={handleInputChange}
                className="appearance-none block w-full px-3 py-2 border border-[#30363d] rounded-md shadow-sm bg-[#0d1117] text-white placeholder-gray-500 focus:outline-none focus:outline-white/25 focus:border-transparent sm:text-sm"
                placeholder="Enter username"
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-300">
              password
            </label>
            <div className="mt-1 relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={formData.password}
                onChange={handleInputChange}
                className="appearance-none block w-full px-3 py-2 pr-10 border border-[#30363d] rounded-md shadow-sm bg-[#0d1117] text-white placeholder-gray-500 focus:outline-none focus:outline-white/25 focus:border-transparent sm:text-sm"
                placeholder="Enter password"
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeSlashIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
                ) : (
                  <EyeIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
                )}
              </button>
            </div>
          </div>

          {/* 错误提示已用 antd message 统一，不再本地渲染 */}

          <div>
            <Button
              type="submit"
              disabled={isLoading}
              className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white focus:outline-none focus:outline-white/25 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
              style={{ backgroundColor: 'rgb(112,167,215)' }}
            >
              {isLoading ? (
                <div className="flex items-center">
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Logging in...
                </div>
              ) : (
                t('navigation.login')
              )}
            </Button>
          </div>

          {/* 显示测试账号信息 */}
          <div className="mt-6 text-center text-xs text-gray-500">
            Test account: admin / admin
          </div>
        </form>
      )}

      {/* 分隔线和第三方登录 - 只在同时显示两种登录方式时显示 */}
      {showPasswordLogin && showOidcLogin && (
        <div className="mt-6">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-600" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-[#161b22] text-gray-400">Or continue with</span>
            </div>
          </div>
        </div>
      )}

      {/* OIDC 登录 */}
      {showOidcLogin && (
        <div className={showPasswordLogin ? "mt-6" : ""}>
          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={() => window.location.href = '/api/auth/oidc/login'}
              className="w-full inline-flex justify-center py-2 px-4 border border-[#30363d] rounded-md shadow-sm bg-[#0d1117] text-sm font-medium text-gray-300 hover:bg-[#21262d] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#161b22] focus:ring-blue-500 transition-colors duration-200"
            >
              <img src="/ocid.png" alt="OIDC Login" className="w-5 h-5 mr-2" />
              {oidcLoginText}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}