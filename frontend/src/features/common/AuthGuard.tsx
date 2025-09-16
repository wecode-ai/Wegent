'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getToken } from '@/apis/user'
import { paths } from '@/config/paths'
import { Spin } from 'antd'

interface AuthGuardProps {
  children: React.ReactNode
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const loginPath = paths.auth.login.getHref()
    if (pathname !== loginPath && pathname !== paths.internal.cas.getHref() && pathname !== paths.home.getHref()) {
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
      <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
        <div className="bg-[#161b22] rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
          <Spin size="large" />
          <div className="mt-4 text-gray-200 text-base font-medium tracking-wide">Loading...</div>
        </div>
      </div>
    )
  }

  // 校验通过后再渲染页面内容
  return <>{children}</>
}