// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { paths } from '@/config/paths'
import { Button } from 'antd'

type TopNavigationProps = {
  activePage: 'tasks' | 'dashboard'
  showLogo?: boolean
  children?: React.ReactNode
}

export default function TopNavigation({ activePage, showLogo = false, children }: TopNavigationProps) {
  const router = useRouter()

  const navigateToTasks = () => {
    router.push(paths.task.getHref())
  }

  const navigateToDashboard = () => {
    router.push(paths.settings.root.getHref())
  }

  return (
    <div className="flex items-center justify-center px-6 py-10 relative">
      {/* Logo - only shown when showLogo is true */}
      {showLogo && (
        <div className="absolute left-16 top-1/2 -translate-y-1/2 flex items-center">
          <Image
            src="/weibo-logo.png"
            alt="Weibo Logo"
            width={24}
            height={24}
            className="object-contain"
            priority
          />
        </div>
      )}
      
      {/* Navigation Links */}
      <div className="flex space-x-6">
        <Button
          type="link"
          onClick={navigateToTasks}
          style={{
            fontSize: '1.125rem',
            fontWeight: 500,
            color: activePage === 'tasks' ? '#ffffff' : '#9ca3af',
            padding: '0',
            height: 'auto'
          }}
        >
          Tasks
        </Button>
        <Button
          type="link"
          onClick={navigateToDashboard}
          style={{
            fontSize: '1.125rem',
            fontWeight: 500,
            color: activePage === 'dashboard' ? '#ffffff' : '#9ca3af',
            padding: '0',
            height: 'auto'
          }}
        >
          Settings
        </Button>
      </div>
      
      {/* Right side content (user avatar, etc.) */}
      {children}
    </div>
  )
}