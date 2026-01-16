// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@/features/common/UserContext'
import { useTranslation, languageNames } from '@/hooks/useTranslation'
import { DocsButton } from '@/features/layout/DocsButton'
import { FeedbackButton } from '@/features/layout/FeedbackButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { paths } from '@/config/paths'
import {
  UserCircleIcon,
  Cog6ToothIcon,
  ArrowRightOnRectangleIcon,
  ChevronUpIcon,
  ShieldCheckIcon,
  LanguageIcon,
} from '@heroicons/react/24/outline'

interface UserFloatingMenuProps {
  className?: string
}

export function UserFloatingMenu({ className = '' }: UserFloatingMenuProps) {
  const { t, changeLanguage, getCurrentLanguage, getSupportedLanguages } = useTranslation()
  const router = useRouter()
  const { user, logout } = useUser()
  const [isExpanded, setIsExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const userDisplayName = user?.user_name || t('common:user.default_name')
  const isAdmin = user?.role === 'admin'
  const currentLanguage = getCurrentLanguage()
  const supportedLanguages = getSupportedLanguages()

  const handleLanguageClick = () => {
    const currentIndex = supportedLanguages.indexOf(currentLanguage)
    const nextIndex = (currentIndex + 1) % supportedLanguages.length
    const nextLang = supportedLanguages[nextIndex]
    changeLanguage(nextLang)
    setIsExpanded(false)
  }

  // Toggle menu on click
  const handleToggleMenu = () => {
    setIsExpanded(prev => !prev)
  }

  const handleSettingsClick = () => {
    router.push(paths.settings.root.getHref())
    setIsExpanded(false)
  }

  const handleLogout = () => {
    logout()
    setIsExpanded(false)
  }

  // Close menu when clicking outside
  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
      setIsExpanded(false)
    }
  }, [])

  // Close menu on Escape key
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      setIsExpanded(false)
    }
  }, [])

  // Add/remove event listeners
  useEffect(() => {
    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isExpanded, handleClickOutside, handleKeyDown])

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* User avatar button */}
      <button
        type="button"
        onClick={handleToggleMenu}
        aria-expanded={isExpanded}
        aria-haspopup="true"
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted transition-all duration-200 group"
      >
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <UserCircleIcon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex flex-col items-start">
          <span className="text-sm font-medium text-text-primary leading-tight">
            {userDisplayName}
          </span>
          {isAdmin && (
            <span className="text-xs text-primary flex items-center gap-0.5">
              <ShieldCheckIcon className="w-3 h-3" />
              Admin
            </span>
          )}
        </div>
        <ChevronUpIcon
          className={`w-3.5 h-3.5 text-text-muted transition-transform duration-200 ${
            isExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Expanded menu */}
      <div
        role="menu"
        aria-label={t('common:user.menu', 'User menu')}
        className={`absolute bottom-full left-0 mb-2 min-w-[200px] rounded-xl bg-surface border border-border overflow-hidden transition-all duration-200 ease-out ${
          isExpanded
            ? 'opacity-100 translate-y-0 pointer-events-auto'
            : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        {/* Menu items */}
        <div className="py-1">
          {/* Settings */}
          <button
            type="button"
            role="menuitem"
            onClick={handleSettingsClick}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
          >
            <Cog6ToothIcon className="w-4 h-4 text-text-muted" />
            {t('common:navigation.settings')}
          </button>

          {/* Docs */}
          <DocsButton showLabel className="w-full px-3 py-2" onClick={() => setIsExpanded(false)} />

          {/* Feedback */}
          <FeedbackButton
            showLabel
            className="w-full px-3 py-2"
            onClick={() => setIsExpanded(false)}
          />

          {/* Theme toggle */}
          <ThemeToggle
            showLabel
            className="w-full px-3 py-2"
            onToggle={() => setIsExpanded(false)}
          />

          {/* Language Switcher */}
          <button
            type="button"
            role="menuitem"
            onClick={handleLanguageClick}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
          >
            <LanguageIcon className="w-4 h-4 text-text-muted" />
            {languageNames[currentLanguage] || currentLanguage}
          </button>

          {/* Admin link */}
          {isAdmin && (
            <>
              <div className="my-1 mx-2 h-px bg-border/60" />
              <Link
                href="/admin"
                onClick={() => setIsExpanded(false)}
                role="menuitem"
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
              >
                <ShieldCheckIcon className="w-4 h-4 text-primary" />
                {t('common:navigation.admin', 'Admin')}
              </Link>
            </>
          )}

          {/* Logout */}
          <div className="my-1 mx-2 h-px bg-border/60" />
          <button
            type="button"
            role="menuitem"
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-muted transition-colors duration-150"
          >
            <ArrowRightOnRectangleIcon className="w-4 h-4 text-text-muted" />
            {t('common:user.logout')}
          </button>
        </div>
      </div>
    </div>
  )
}
