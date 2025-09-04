// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { paths } from '@/config/paths'

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
    router.push(paths.dashboard.root.getHref())
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
        <button
          className={`text-lg font-medium ${activePage === 'tasks' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
          onClick={navigateToTasks}
        >
          Tasks
        </button>
        <button
          className={`text-lg font-medium ${activePage === 'dashboard' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
          onClick={navigateToDashboard}
        >
          Dashboard
        </button>
      </div>
      
      {/* Right side content (user avatar, etc.) */}
      {children}
    </div>
  )
}