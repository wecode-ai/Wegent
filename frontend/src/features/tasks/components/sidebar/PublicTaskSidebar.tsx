// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Button } from '@/components/ui/button'
import Image from 'next/image'
import { LogIn, MessageSquare } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface PublicTaskSidebarProps {
  taskTitle: string
  sharerName: string
  onLoginClick: () => void
  isLoggedIn?: boolean
}

/**
 * Simplified sidebar for public shared task viewing
 * Shows the current shared task and prompts users to login
 */
export default function PublicTaskSidebar({
  taskTitle,
  sharerName,
  onLoginClick,
  isLoggedIn = false,
}: PublicTaskSidebarProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col bg-surface w-full h-full">
      {/* Logo */}
      <div className="px-1 py-2 sm:py-3">
        <div className="flex items-center justify-between pl-2 gap-2">
          <div className="flex items-center gap-2">
            <Image
              src="/weibo-logo.png"
              alt="Weibo Logo"
              width={20}
              height={20}
              className="object-container"
            />
            <span className="text-sm text-text-primary">Wegent</span>
          </div>
        </div>
      </div>

      {/* Login prompt */}
      <div className="px-1 mb-3">
        <Button
          variant="default"
          onClick={onLoginClick}
          className="w-full justify-start px-2 py-1.5 h-8 text-sm"
          size="sm"
        >
          <LogIn className="h-4 w-4 mr-1.5" />
          {isLoggedIn ? t('shared-task:continue_chat') : t('shared-task:login_to_continue')}
        </Button>
      </div>

      {/* Current shared task */}
      <div className="flex-1 pl-2 pr-1 pt-2 overflow-y-auto">
        <div className="mb-2">
          <div className="text-xs text-text-muted px-2 mb-1">{t('shared-task:shared_task')}</div>
        </div>

        <div className="relative group rounded-lg border border-border bg-muted/50 px-2 py-2 mb-2">
          <div className="flex items-start gap-2">
            <div className="flex-shrink-0 mt-0.5">
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-text-primary line-clamp-2 mb-1">
                {taskTitle}
              </div>
              <div className="text-xs text-text-muted">
                {t('shared-task:shared_by')} {sharerName}
              </div>
            </div>
          </div>
        </div>

        {/* Information box */}
        <div className="mt-4 mx-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="text-xs text-text-primary space-y-2">
            <p className="font-medium">👀 {t('shared-task:read_only_view')}</p>
            <p className="text-text-muted">
              {isLoggedIn ? t('shared-task:continue_prompt') : t('shared-task:login_prompt')}
            </p>
          </div>
        </div>
      </div>

      {/* Bottom login CTA */}
      <div className="p-3 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={onLoginClick}
          className="w-full text-text-primary hover:text-text-primary hover:bg-hover"
        >
          <LogIn className="h-3.5 w-3.5 mr-2" />
          {t('shared-task:continue_chat')}
        </Button>
      </div>
    </div>
  )
}
