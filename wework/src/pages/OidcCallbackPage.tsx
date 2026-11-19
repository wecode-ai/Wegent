import { useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '@/features/auth/useAuth'
import { useTranslation } from '@/hooks/useTranslation'
import { createOidcCallbackResource } from './oidcCallbackResource'

export function OidcCallbackPage() {
  const { t } = useTranslation('common')
  const { loginWithOidcToken } = useAuth()

  const search = window.location.search
  const source = useMemo(
    () => createOidcCallbackResource(search, loginWithOidcToken),
    [search, loginWithOidcToken]
  )
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background"
      aria-busy={state.status === 'idle' || state.status === 'loading'}
    >
      <div className="rounded-2xl border border-border bg-surface px-8 py-8 text-sm font-medium text-text-secondary shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
        {t('workbench.oidc_processing', '正在处理 OpenID Connect 登录...')}
      </div>
    </div>
  )
}
