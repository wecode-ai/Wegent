import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  AdminPasswordSetupForm,
  PasswordLoginForm,
  OUTLINED_LOGIN_BUTTON_CLASS,
} from '@/components/auth/LoginForms'
import { getRuntimeConfig } from '@/config/runtime'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { createLoginPageSource, getLoginRedirectTarget } from '@/features/auth/loginPageSource'

export function LoginPage() {
  const { t } = useTranslation('common')
  const auth = useAuth()
  const { user, isLoading: authLoading, adminPasswordSetupRequired, adminUsername } = auth
  const config = useMemo(() => getRuntimeConfig(), [])
  const [source] = useState(createLoginPageSource)
  const redirectTarget = getLoginRedirectTarget()
  const subscribe = useCallback(
    (listener: () => void) =>
      source.subscribe(listener, {
        auth,
        config,
        redirectTarget,
        translate: key => t(key),
      }),
    [source, auth, config, redirectTarget, t]
  )
  const {
    formData,
    adminPasswordFormData,
    isSubmitting,
    isAdminPasswordSubmitting,
    error,
    adminPasswordError,
  } = useSyncExternalStore(subscribe, source.getSnapshot)
  const {
    setFormData,
    setAdminPasswordFormData,
    handleSubmit,
    handleAdminPasswordSubmit,
    handleOidcLogin,
  } = source
  const showPasswordLogin = config.loginMode === 'password' || config.loginMode === 'all'
  const showOidcLogin = config.loginMode === 'oidc' || config.loginMode === 'all'
  const isResolvingInitialUserState = authLoading && !user

  if (config.loginMode === 'oidc') {
    return null
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="heading-xl text-text-primary">{t('workbench.login_title')}</h1>
          <p className="mt-2 text-sm text-text-muted">{t('workbench.login_subtitle')}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface px-8 py-8 shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
          {showPasswordLogin && isResolvingInitialUserState && (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="login-loading">
              {t('workbench.loading_setup_status')}
            </div>
          )}
          {showPasswordLogin && !isResolvingInitialUserState && adminPasswordSetupRequired && (
            <AdminPasswordSetupForm
              adminUsername={adminUsername}
              value={adminPasswordFormData}
              error={adminPasswordError}
              submitting={isAdminPasswordSubmitting}
              onChange={setAdminPasswordFormData}
              onSubmit={handleAdminPasswordSubmit}
            />
          )}
          {showPasswordLogin && !isResolvingInitialUserState && !adminPasswordSetupRequired && (
            <PasswordLoginForm
              value={formData}
              error={error}
              submitting={isSubmitting}
              onChange={setFormData}
              onSubmit={handleSubmit}
            />
          )}
          {showPasswordLogin &&
            !isResolvingInitialUserState &&
            !adminPasswordSetupRequired &&
            showOidcLogin && (
              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-text-muted">{t('workbench.login_or_continue')}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
          {showOidcLogin &&
            (!showPasswordLogin ||
              (!isResolvingInitialUserState && !adminPasswordSetupRequired)) && (
              <button
                type="button"
                data-testid="oidc-login-button"
                className={OUTLINED_LOGIN_BUTTON_CLASS}
                onClick={handleOidcLogin}
              >
                {config.oidcLoginText || t('workbench.oidc_login')}
              </button>
            )}
        </div>
      </div>
    </div>
  )
}
