import type { FormEvent } from 'react'
import type { LoginRequest } from '@/api/auth'
import type { getRuntimeConfig } from '@/config/runtime'
import type { useAuth } from './useAuth'
import { isAdminPasswordSetupRequiredError } from './adminPasswordSetup'
import { POST_LOGIN_REDIRECT_KEY, sanitizeRedirectPath } from './redirect'
import { navigateTo } from '@/lib/navigation'

export function getLoginRedirectTarget(): string {
  const search = new URLSearchParams(window.location.search)
  const queryRedirect = sanitizeRedirectPath(search.get('redirect'), ['/login', '/login/oidc'])
  const storedRedirect = sanitizeRedirectPath(sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY), [
    '/login',
    '/login/oidc',
  ])
  return queryRedirect || storedRedirect || '/'
}

function buildOidcLoginUrl(apiBaseUrl: string, redirect: string, appBasePath: string): string {
  const params = new URLSearchParams()
  params.set('redirect', redirect)
  if (appBasePath) {
    params.set('frontend_base_path', appBasePath)
  }

  return `${apiBaseUrl}/auth/oidc/login?${params.toString()}`
}

interface LoginInput {
  auth: ReturnType<typeof useAuth>
  config: ReturnType<typeof getRuntimeConfig>
  redirectTarget: string
  translate(key: string): string
}
interface LoginSnapshot {
  formData: LoginRequest
  adminPasswordFormData: { password: string; confirmPassword: string }
  isSubmitting: boolean
  isAdminPasswordSubmitting: boolean
  error: string | null
  adminPasswordError: string | null
}

/** The mounted login surface owns its drafts, authentication actions and outbound navigation. */
export function createLoginPageSource() {
  let snapshot: LoginSnapshot = {
    formData: { user_name: '', password: '' },
    adminPasswordFormData: { password: '', confirmPassword: '' },
    isSubmitting: false,
    isAdminPasswordSubmitting: false,
    error: null,
    adminPasswordError: null,
  }
  let observation = 0
  let input: LoginInput | undefined
  let completedRedirect: string | undefined
  let oidcRedirect: string | undefined
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<LoginSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const complete = (target: string) => {
    if (!listeners.size || completedRedirect === target) return
    completedRedirect = target
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
    navigateTo(target)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: LoginInput) {
      input = next
      const revision = ++observation
      listeners.add(listener)
      if (!next.auth.isLoading && next.auth.user) complete(next.redirectTarget)
      else if (next.config.loginMode === 'oidc') {
        const url = buildOidcLoginUrl(
          next.config.apiBaseUrl,
          next.redirectTarget,
          next.config.appBasePath
        )
        if (oidcRedirect !== url) {
          oidcRedirect = url
          sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, next.redirectTarget)
          window.location.href = url
        }
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || revision !== observation) return
          completedRedirect = undefined
          oidcRedirect = undefined
        })
      }
    },
    setFormData: (formData: LoginRequest) => publish({ formData }),
    setAdminPasswordFormData: (adminPasswordFormData: LoginSnapshot['adminPasswordFormData']) =>
      publish({ adminPasswordFormData }),
    async handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (!input || !listeners.size) return
      const request = input
      const credentials = snapshot.formData
      completedRedirect = undefined
      publish({ error: null, isSubmitting: true })
      try {
        await request.auth.login(credentials)
        if (input?.auth.login === request.auth.login) complete(request.redirectTarget)
      } catch (error) {
        if (isAdminPasswordSetupRequiredError(error)) return
        if (listeners.size && input?.auth.login === request.auth.login)
          publish({
            error:
              error instanceof Error ? error.message : request.translate('workbench.login_failed'),
          })
      } finally {
        publish({ isSubmitting: false })
      }
    },
    async handleAdminPasswordSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      if (!input || !listeners.size) return
      const request = input
      const values = snapshot.adminPasswordFormData
      publish({ adminPasswordError: null })
      if (values.password !== values.confirmPassword) {
        publish({ adminPasswordError: request.translate('workbench.admin_password_mismatch') })
        return
      }
      publish({ isAdminPasswordSubmitting: true })
      try {
        await request.auth.setupAdminPassword(values.password)
        if (input?.auth.setupAdminPassword === request.auth.setupAdminPassword)
          complete(request.redirectTarget)
      } catch (error) {
        if (listeners.size && input?.auth.setupAdminPassword === request.auth.setupAdminPassword)
          publish({
            adminPasswordError:
              error instanceof Error
                ? error.message
                : request.translate('workbench.admin_password_setup_failed'),
          })
      } finally {
        publish({ isAdminPasswordSubmitting: false })
      }
    },
    handleOidcLogin() {
      if (!input || !listeners.size) return
      const redirect =
        sanitizeRedirectPath(sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY), [
          '/login',
          '/login/oidc',
        ]) || input.redirectTarget
      window.location.href = buildOidcLoginUrl(
        input.config.apiBaseUrl,
        redirect,
        input.config.appBasePath
      )
    },
  }
}
