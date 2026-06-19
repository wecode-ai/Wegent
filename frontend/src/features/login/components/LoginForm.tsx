// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRouter, useSearchParams } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from '@/features/login/constants'
import Image from 'next/image'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { userApis } from '@/apis/user'

export default function LoginForm() {
  const { t } = useTranslation()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [formData, setFormData] = useState({
    user_name: '',
    password: '',
  })
  const [adminPasswordFormData, setAdminPasswordFormData] = useState({
    password: '',
    confirmPassword: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [showAdminPassword, setShowAdminPassword] = useState(false)
  const [showAdminPasswordConfirm, setShowAdminPasswordConfirm] = useState(false)
  const [adminPasswordSetupRequired, setAdminPasswordSetupRequired] = useState<boolean | null>(null)
  const [adminPasswordSetupStatusError, setAdminPasswordSetupStatusError] = useState(false)
  const [adminUsername, setAdminUsername] = useState('')
  const [adminPasswordError, setAdminPasswordError] = useState<string | null>(null)
  // Used antd message.error for unified error prompt, no need for local error state
  const [isLoading, setIsLoading] = useState(false)
  const [isAdminPasswordSubmitting, setIsAdminPasswordSubmitting] = useState(false)

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

  const { user, isLoading: userLoading, login, setupAdminPassword } = useUser()

  useEffect(() => {
    let cancelled = false

    async function loadAdminPasswordSetupStatus() {
      if (!showPasswordLogin) {
        setAdminPasswordSetupRequired(false)
        setAdminPasswordSetupStatusError(false)
        return
      }

      try {
        const status = await userApis.getAdminPasswordSetupStatus()
        if (!cancelled) {
          setAdminPasswordSetupRequired(status.required)
          setAdminUsername(status.admin_username)
          setAdminPasswordSetupStatusError(false)
        }
      } catch (error) {
        console.error('Failed to load admin password setup status:', error)
        if (!cancelled) {
          setAdminPasswordSetupRequired(null)
          setAdminPasswordSetupStatusError(true)
        }
      }
    }

    loadAdminPasswordSetupStatus()

    return () => {
      cancelled = true
    }
  }, [showPasswordLogin])

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
      // For API endpoints, use full page navigation
      // For internal routes, use Next.js router for client-side navigation
      if (redirectPath.startsWith('/api/')) {
        window.location.href = redirectPath
      } else {
        router.replace(redirectPath)
      }
    }
  }, [userLoading, user, router, redirectPath])

  const handleRedirect = (path: string) => {
    // For API endpoints (like /api/attachments/*), use full page navigation
    // For internal routes, use Next.js router for client-side navigation
    if (path.startsWith('/api/')) {
      window.location.href = path
    } else {
      router.replace(path)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (user) {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      }
      handleRedirect(redirectPath)
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
      handleRedirect(redirectPath)
    } catch {
      // Error handling is already done in UserContext.login, no need to show error message here
    } finally {
      setIsLoading(false)
    }
  }

  const handleAdminPasswordInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setAdminPasswordFormData(prev => ({
      ...prev,
      [name]: value,
    }))
    setAdminPasswordError(null)
  }

  const handleAdminPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAdminPasswordError(null)

    if (adminPasswordFormData.password !== adminPasswordFormData.confirmPassword) {
      setAdminPasswordError(t('common:login.admin_password_mismatch'))
      return
    }

    setIsAdminPasswordSubmitting(true)
    try {
      await setupAdminPassword(adminPasswordFormData.password)
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
      }
      handleRedirect(redirectPath)
    } catch {
      setAdminPasswordError(t('common:login.admin_password_setup_failed'))
    } finally {
      setIsAdminPasswordSubmitting(false)
    }
  }

  const isCheckingAdminPasswordSetup =
    showPasswordLogin && adminPasswordSetupRequired === null && !adminPasswordSetupStatusError

  return (
    <div className="space-y-6">
      {/* Language switcher */}
      <div className="absolute top-4 right-4 flex items-center gap-3">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
      {isCheckingAdminPasswordSetup && (
        <div className="py-8 text-center text-sm text-text-muted" data-testid="login-loading">
          {t('common:login.loading_setup_status')}
        </div>
      )}

      {showPasswordLogin && adminPasswordSetupStatusError && (
        <div
          className="py-8 text-center text-sm text-red-600"
          data-testid="login-setup-status-error"
        >
          {t('common:login.admin_password_setup_status_failed')}
        </div>
      )}

      {showPasswordLogin && adminPasswordSetupRequired === true && (
        <form
          className="space-y-6"
          data-testid="admin-password-setup-form"
          onSubmit={handleAdminPasswordSubmit}
        >
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              {t('common:login.admin_password_setup_title')}
            </h2>
            <p className="mt-2 text-sm text-text-muted">
              {t('common:login.admin_password_setup_description')}
            </p>
          </div>

          <div
            className="rounded-lg border border-border bg-surface px-4 py-3"
            data-testid="admin-username-summary"
          >
            <div className="text-xs font-medium text-text-muted">
              {t('common:login.admin_username_label')}
            </div>
            <div
              className="mt-1 font-mono text-sm font-semibold text-text-primary"
              data-testid="admin-username-value"
            >
              {adminUsername}
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {t('common:login.admin_username_description')}
            </p>
          </div>

          <div>
            <label
              htmlFor="admin-password"
              className="block text-sm font-medium text-text-secondary"
            >
              {t('common:login.admin_password')}
            </label>
            <div className="mt-1 relative">
              <Input
                id="admin-password"
                name="password"
                data-testid="admin-password-input"
                type={showAdminPassword ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={6}
                value={adminPasswordFormData.password}
                onChange={handleAdminPasswordInputChange}
                className="pr-10 shadow-sm"
                placeholder={t('common:login.admin_password_placeholder')}
              />
              <button
                type="button"
                data-testid="admin-password-visibility-button"
                className="absolute inset-y-0 right-0 flex h-11 min-w-[44px] items-center justify-center pr-3"
                onClick={() => setShowAdminPassword(current => !current)}
                aria-label={t('common:login.toggle_admin_password_visibility')}
              >
                {showAdminPassword ? (
                  <EyeIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
                ) : (
                  <EyeSlashIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
                )}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="admin-password-confirm"
              className="block text-sm font-medium text-text-secondary"
            >
              {t('common:login.admin_password_confirm')}
            </label>
            <div className="mt-1 relative">
              <Input
                id="admin-password-confirm"
                name="confirmPassword"
                data-testid="admin-password-confirm-input"
                type={showAdminPasswordConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={6}
                value={adminPasswordFormData.confirmPassword}
                onChange={handleAdminPasswordInputChange}
                className="pr-10 shadow-sm"
                placeholder={t('common:login.admin_password_confirm_placeholder')}
              />
              <button
                type="button"
                data-testid="admin-password-confirm-visibility-button"
                className="absolute inset-y-0 right-0 flex h-11 min-w-[44px] items-center justify-center pr-3"
                onClick={() => setShowAdminPasswordConfirm(current => !current)}
                aria-label={t('common:login.toggle_admin_password_visibility')}
              >
                {showAdminPasswordConfirm ? (
                  <EyeIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
                ) : (
                  <EyeSlashIcon className="h-5 w-5 text-text-muted hover:text-text-secondary" />
                )}
              </button>
            </div>
          </div>

          {adminPasswordError && (
            <div className="text-sm text-red-600" data-testid="admin-password-error">
              {adminPasswordError}
            </div>
          )}

          <Button
            variant="default"
            type="submit"
            data-testid="admin-password-submit-button"
            disabled={isAdminPasswordSubmitting}
            style={{ width: '100%' }}
          >
            {isAdminPasswordSubmitting
              ? t('common:login.admin_password_setting')
              : t('common:login.admin_password_submit')}
          </Button>
        </form>
      )}

      {/* Password login form */}
      {showPasswordLogin && adminPasswordSetupRequired === false && (
        <form className="space-y-6" data-testid="login-form" onSubmit={handleSubmit}>
          <div>
            <label htmlFor="user_name" className="block text-sm font-medium text-text-secondary">
              {t('common:login.username')}
            </label>
            <div className="mt-1">
              <Input
                id="user_name"
                name="user_name"
                data-testid="login-username-input"
                type="text"
                autoComplete="username"
                required
                value={formData.user_name}
                onChange={handleInputChange}
                className="shadow-sm"
                placeholder={t('common:login.enter_username')}
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-text-secondary">
              {t('common:login.password')}
            </label>
            <div className="mt-1 relative">
              <Input
                id="password"
                name="password"
                data-testid="login-password-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={formData.password}
                onChange={handleInputChange}
                className="pr-10 shadow-sm"
                placeholder={t('common:login.enter_password')}
              />
              <button
                type="button"
                data-testid="toggle-password-visibility-button"
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={t('common:login.toggle_password_visibility')}
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
            <Button
              variant="default"
              type="submit"
              data-testid="login-submit-button"
              disabled={isLoading}
              style={{ width: '100%' }}
            >
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
        </form>
      )}

      {/* Divider and third-party login - only shown when both login modes are displayed */}
      {showPasswordLogin && adminPasswordSetupRequired === false && showOidcLogin && (
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
      {showOidcLogin && (!showPasswordLogin || adminPasswordSetupRequired === false) && (
        <div className={showPasswordLogin ? 'mt-6' : ''}>
          <div className="grid grid-cols-1 gap-3">
            <Button
              variant="outline"
              data-testid="oidc-login-button"
              onClick={() => {
                // Include redirect parameter for OIDC login if exists
                const redirectUrl = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY)
                const oidcUrl = redirectUrl
                  ? `/api/auth/oidc/login?redirect=${encodeURIComponent(redirectUrl)}`
                  : '/api/auth/oidc/login'
                window.location.href = oidcUrl
              }}
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
