// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { useRouter, useSearchParams } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'
import Image from 'next/image'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

export default function LoginForm() {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [formData, setFormData] = useState({
    user_name: 'admin',
    password: 'Wegent2025!',
  })
  const [showPassword, setShowPassword] = useState(false)
  // Used antd message.error for unified error prompt, no need for local error state
  const [isLoading, setIsLoading] = useState(false)

  // Get login mode configuration from runtime config
  const runtimeConfig = getRuntimeConfigSync()
  const loginMode = runtimeConfig.loginMode
  const showPasswordLogin = loginMode === 'password' || loginMode === 'all'
  const showOidcLogin = loginMode === 'oidc' || loginMode === 'all'

  // Get OIDC login button text from runtime config
  const oidcLoginText = runtimeConfig.oidcLoginText || t('common:login.oidc_login')
  const loginPath = paths.auth.login.getHref()
  const defaultRedirect = paths.chat.getHref()
  const [redirectPath, setRedirectPath] = useState(defaultRedirect)

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }))
    // Used antd message.error for unified error prompt, no need for local error state
  }

  const { user, isLoading: userLoading, login } = useUser()

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const queryRedirect = searchParams.get('redirect')
      const storedRedirect = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)
      const disallowedRedirects = [loginPath, '/login/oidc']
      const validQueryRedirect = sanitizeRedirectPath(queryRedirect, disallowedRedirects)
      const validStoredRedirect = sanitizeRedirectPath(storedRedirect, disallowedRedirects)

      if (validQueryRedirect) {
        sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, validQueryRedirect)
        setRedirectPath(validQueryRedirect)
      } else if (validStoredRedirect) {
        setRedirectPath(validStoredRedirect)
      } else {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
        setRedirectPath(defaultRedirect)
      }
    }
  }, [defaultRedirect, loginPath, searchParams])

  useEffect(() => {
    if (!userLoading && user) {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      }
      router.replace(redirectPath)
    }
  }, [userLoading, user, router, redirectPath])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (user) {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      }
      router.replace(redirectPath)
      return
    }
    setIsLoading(true)
    // Used antd message.error for unified error prompt, no need for local error state

    try {
      await login({
        user_name: formData.user_name,
        password: formData.password,
      })
      // Login succeeded - clean up session storage
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      }
      // Force an immediate redirect after successful login
      // This ensures redirect happens even if useEffect timing is delayed
      router.replace(redirectPath)
    } catch {
      // Error handling is already done in UserContext.login, no need to show error message here
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Language switcher */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
      {/* Password login form */}
      {showPasswordLogin && (
        <form className="space-y-6" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="user_name" className="block text-sm font-medium text-text-secondary">
              {t('common:login.username')}
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
                className="appearance-none block w-full px-3 py-2 border border-border rounded-md shadow-sm bg-base text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent sm:text-sm"
                placeholder={t('common:login.enter_username')}
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-text-secondary">
              {t('common:login.password')}
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
                className="appearance-none block w-full px-3 py-2 pr-10 border border-border rounded-md shadow-sm bg-base text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent sm:text-sm"
                placeholder={t('common:login.enter_password')}
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
                ) : (
                  <EyeSlashIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
                )}
              </button>
            </div>
          </div>

          {/* Error prompts are unified with antd message, no longer rendered locally */}

          <div>
            <Button variant="default" type="submit" disabled={isLoading} style={{ width: '100%' }}>
              {isLoading ? (
                <div className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-primary-contrast"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {t('common:login.logging_in')}
                </div>
              ) : (
                t('common:user.login')
              )}
            </Button>
          </div>

          {/* Show test account info */}
          <div className="mt-6 text-center text-xs text-text-muted">
            {t('common:login.test_account')}
          </div>
        </form>
      )}

      {/* Divider and third-party login - only shown when both login modes are displayed */}
      {showPasswordLogin && showOidcLogin && (
        <div className="mt-6">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-surface text-text-muted">
                {t('common:login.or_continue_with')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* OIDC login */}
      {showOidcLogin && (
        <div className={showPasswordLogin ? 'mt-6' : ''}>
          <div className="grid grid-cols-1 gap-3">
            <Button
              variant="outline"
              onClick={() => (window.location.href = '/api/auth/oidc/login')}
              style={{
                width: '100%',
                justifyContent: 'center',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Image src="/ocid.png" alt="OIDC Login" width={20} height={20} className="mr-2" />
              {oidcLoginText}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
