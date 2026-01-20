// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { userApis } from '@/apis/user'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'

interface AuthGuardProps {
  children: React.ReactNode
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { t } = useTranslation()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const loginPath = paths.auth.login.getHref()
    const allowedPaths = [
      loginPath,
      '/login/oidc',
      paths.home.getHref(),
      paths.auth.password_login.getHref(),
      '/shared/task', // Allow public shared task page without authentication
    ]
    if (!allowedPaths.includes(pathname)) {
      // Use isAuthenticated() to check both token existence and expiry
      const isAuth = userApis.isAuthenticated()
      if (!isAuth) {
        const search = searchParams.toString()
        const redirectTarget = search ? `${pathname}?${search}` : pathname
        router.replace(`${loginPath}?redirect=${encodeURIComponent(redirectTarget)}`)
        // Do not render content, wait for redirect
        return
      }
    }
    setChecking(false)
  }, [pathname, router, searchParams])

  if (checking) {
    return (
      <div className="flex items-center justify-center smart-h-screen bg-base box-border">
        <div className="bg-surface rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
          <Spinner size="lg" center />
          <div className="mt-4 text-text-secondary text-base font-medium tracking-wide">
            {t('common:auth.loading')}
          </div>
        </div>
      </div>
    )
  }

  // Render page content after validation passes
  return <>{children}</>
}
