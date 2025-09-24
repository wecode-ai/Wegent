'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getToken } from '@/apis/user'
import { paths } from '@/config/paths'
import { Spin } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'

interface AuthGuardProps {
  children: React.ReactNode
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { t } = useTranslation('common')
  const pathname = usePathname()
  const router = useRouter()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const loginPath = paths.auth.login.getHref()
    const allowedPaths = [
      loginPath,
      '/login/oidc',
      paths.home.getHref(),
      paths.auth.password_login.getHref()
    ]
    if (!allowedPaths.includes(pathname)) {
      const token = getToken()
      if (!token) {
        router.replace(loginPath)
        // 不渲染内容，等待跳转
        return
      }
    }
    setChecking(false)
  }, [pathname, router])

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-base">
        <div className="bg-surface rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
          <Spin size="large" />
          <div className="mt-4 text-text-secondary text-base font-medium tracking-wide">{t('auth.loading')}</div>
        </div>
      </div>
    )
  }

  // 校验通过后再渲染页面内容
  return <>{children}</>
}
