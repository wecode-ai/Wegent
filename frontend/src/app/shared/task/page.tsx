// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { taskApis, PublicSharedTaskResponse } from '@/apis/tasks'
import { getToken, userApis } from '@/apis/user'
import { LogIn } from 'lucide-react'
import { useTheme } from '@/features/theme/ThemeProvider'
import TopNavigation from '@/features/layout/TopNavigation'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { MessageBubble, type Message } from '@/features/tasks/components/message'
import { useTranslation } from '@/hooks/useTranslation'
import type { User, SubtaskContextBrief } from '@/types/api'
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard'
import { detectInAppBrowser } from '@/utils/browserDetection'
import '@/features/common/scrollbar.css'

/**
 * Public shared task page - no authentication required
 * Uses the same layout and styling as the chat page for consistency
 */
function SharedTaskContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { theme } = useTheme()
  const { t } = useTranslation()

  const [taskData, setTaskData] = useState<PublicSharedTaskResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [showInAppBrowserGuard, setShowInAppBrowserGuard] = useState(false)

  // Check if user is logged in
  const isLoggedIn = !!getToken()

  // Fetch current user if logged in
  useEffect(() => {
    const fetchUser = async () => {
      if (isLoggedIn) {
        try {
          const user = await userApis.getCurrentUser()
          setCurrentUser(user)
        } catch (err) {
          console.error('Failed to fetch user:', err)
        }
      }
    }
    fetchUser()
  }, [isLoggedIn])

  useEffect(() => {
    const token = searchParams.get('token')

    if (!token) {
      setError(t('shared-task:error_invalid_link'))
      setIsLoading(false)
      return
    }

    const fetchSharedTask = async () => {
      try {
        const data = await taskApis.getPublicSharedTask(token)
        setTaskData(data)
      } catch (err) {
        console.error('Failed to load shared task:', err)
        const errorMessage = (err as Error)?.message || ''

        // Map error messages to i18n keys
        if (
          errorMessage.includes('Invalid share link format') ||
          errorMessage.includes('Invalid share token')
        ) {
          setError(t('shared-task:error_invalid_link'))
        } else if (
          errorMessage.includes('no longer available') ||
          errorMessage.includes('deleted')
        ) {
          setError(t('shared-task:error_task_deleted'))
        } else {
          setError(t('shared-task:error_load_failed'))
        }
      } finally {
        setIsLoading(false)
      }
    }

    fetchSharedTask()
  }, [searchParams, t])

  const handleLoginAndCopy = () => {
    const token = searchParams.get('token')
    if (!token) return

    // Check if we're in an in-app browser
    const browserInfo = detectInAppBrowser()
    if (browserInfo.isInAppBrowser) {
      // Show the in-app browser guard
      setShowInAppBrowserGuard(true)
      return
    }

    // Not in-app browser, proceed with normal flow
    proceedToLoginOrChat(token)
  }

  const proceedToLoginOrChat = (token: string) => {
    // Check if user is already logged in
    const authToken = getToken()

    if (authToken) {
      // User is logged in, directly navigate to chat with taskShare parameter
      // Use encodeURIComponent to ensure proper URL encoding
      router.push(`/chat?taskShare=${encodeURIComponent(token)}`)
    } else {
      // User is not logged in, redirect to login with the full chat URL as redirect target
      // This way, after login, the user will be redirected directly to /chat?taskShare=xxx
      const redirectTarget = `/chat?taskShare=${encodeURIComponent(token)}`
      router.push(`/login?redirect=${encodeURIComponent(redirectTarget)}`)
    }
  }

  // Helper function to convert subtask to Message format for MessageBubble
  const convertSubtaskToMessage = (subtask: PublicSharedTaskResponse['subtasks'][0]): Message => {
    const isUser = subtask.role === 'USER'

    // Convert public contexts to SubtaskContextBrief format for ContextBadgeList
    const contexts: SubtaskContextBrief[] =
      subtask.contexts?.map(ctx => ({
        id: ctx.id,
        context_type: ctx.context_type,
        name: ctx.name,
        status: ctx.status as 'pending' | 'uploading' | 'parsing' | 'ready' | 'failed',
        // Attachment fields
        file_extension: ctx.file_extension,
        file_size: ctx.file_size,
        mime_type: ctx.mime_type,
        // Knowledge base fields
        document_count: ctx.document_count,
      })) || []

    // For user messages, use prompt
    if (isUser) {
      return {
        type: 'user',
        content: subtask.prompt || '',
        timestamp: new Date(subtask.created_at).getTime(),
        subtaskStatus: subtask.status,
        subtaskId: subtask.id,
        contexts,
        // Group chat fields
        senderUserName: subtask.sender_user_name,
        senderUserId: subtask.sender_user_id,
      }
    }

    // For AI messages, extract result value
    let resultContent = ''
    if (subtask.result) {
      if (typeof subtask.result === 'object') {
        const resultObj = subtask.result as { value?: unknown; thinking?: unknown }
        if (resultObj.value !== null && resultObj.value !== undefined && resultObj.value !== '') {
          resultContent = String(resultObj.value)
        } else {
          resultContent = JSON.stringify(subtask.result)
        }
      } else {
        resultContent = String(subtask.result)
      }
    } else if (subtask.status === 'COMPLETED') {
      resultContent = 'Task completed'
    } else if (subtask.status === 'FAILED') {
      resultContent = 'Task failed'
    } else {
      resultContent = 'Processing...'
    }

    // Add ${$$}$ separator to trigger markdown rendering in MessageBubble
    // Format: prompt${$$}$result (empty prompt for shared tasks)
    const content = '$' + '{$$}$' + resultContent

    return {
      type: 'ai',
      content,
      timestamp: new Date(subtask.created_at).getTime(),
      botName: 'AI Assistant',
      subtaskStatus: subtask.status,
      subtaskId: subtask.id,
      contexts,
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        <TopNavigation activePage="chat" variant="standalone" showLogo>
          <GithubStarButton />
        </TopNavigation>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-text-muted">Loading shared conversation...</p>
          </div>
        </div>
      </div>
    )
  }

  if (error || !taskData) {
    // Determine error title and description based on error type
    let errorTitle = t('shared-task:error_load_failed')
    let errorDesc = t('shared-task:error_load_failed_desc')
    let errorIcon = '⚠️'

    if (error) {
      if (error.includes(t('shared-task:error_invalid_link'))) {
        errorTitle = t('shared-task:error_invalid_link')
        errorDesc = t('shared-task:error_invalid_link_desc')
        errorIcon = '🔗'
      } else if (error.includes(t('shared-task:error_task_deleted'))) {
        errorTitle = t('shared-task:error_task_deleted')
        errorDesc = t('shared-task:error_task_deleted_desc')
        errorIcon = '🗑️'
      }
    }

    return (
      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        <TopNavigation activePage="chat" variant="standalone" showLogo>
          <GithubStarButton />
        </TopNavigation>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-lg w-full">
            {/* Error Icon */}
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
                <span className="text-4xl">{errorIcon}</span>
              </div>
            </div>

            {/* Error Title */}
            <h1 className="text-2xl font-semibold text-center mb-3 text-text-primary">
              {errorTitle}
            </h1>

            {/* Error Description */}
            <p className="text-center text-text-muted mb-8 leading-relaxed">{errorDesc}</p>

            {/* Action Button */}
            <div className="flex justify-center">
              <Button
                onClick={() => router.push('/chat')}
                variant="default"
                size="default"
                className="min-w-[160px]"
              >
                {t('shared-task:go_home')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* In-app browser guard modal */}
      {showInAppBrowserGuard && (
        <InAppBrowserGuard
          onProceed={() => {
            const token = searchParams.get('token')
            if (token) {
              proceedToLoginOrChat(token)
            }
          }}
          onCancel={() => setShowInAppBrowserGuard(false)}
        />
      )}

      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        {/* Top navigation */}
        <TopNavigation activePage="chat" variant="standalone" showLogo>
          <GithubStarButton />
          {isLoggedIn && currentUser ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-primary">{currentUser.user_name}</span>
            </div>
          ) : (
            <Button
              onClick={handleLoginAndCopy}
              size="sm"
              variant="default"
              className="flex items-center gap-2"
            >
              <LogIn className="w-4 h-4" />
              <span className="hidden sm:inline">{t('shared-task:login_to_continue')}</span>
              <span className="sm:hidden">{t('shared-task:login')}</span>
            </Button>
          )}
        </TopNavigation>

        {/* Main content area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="w-full max-w-3xl mx-auto flex flex-col px-4 py-6">
            {/* Task title and sharer info */}
            <div className="mb-6">
              <h1 className="text-2xl font-semibold text-text-primary mb-2">
                {taskData.task_title}
              </h1>
              <p className="text-sm text-text-muted">
                {t('shared-task:shared_by')}{' '}
                <span className="font-medium text-text-primary">{taskData.sharer_name}</span>
              </p>
            </div>

            {/* Read-only notice */}
            <Alert
              variant="default"
              className="mb-6 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
            >
              <AlertDescription className="text-sm text-text-primary">
                📖 {t('shared-task:read_only_notice')}
              </AlertDescription>
            </Alert>

            {/* Messages area - using MessageBubble component for consistency */}
            <div className="flex-1 space-y-6">
              {taskData.subtasks.map((subtask, index) => {
                const message = convertSubtaskToMessage(subtask)
                return (
                  <MessageBubble
                    key={subtask.id}
                    msg={message}
                    index={index}
                    selectedTaskDetail={null}
                    selectedTeam={null}
                    selectedRepo={null}
                    selectedBranch={null}
                    theme={theme}
                    t={t}
                  />
                )
              })}
            </div>

            {/* Bottom CTA */}
            <div className="mt-8 p-4 rounded-lg bg-surface border border-border">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-text-primary mb-1">
                    {isLoggedIn ? t('shared-task:want_to_continue') : t('shared-task:login_prompt')}
                  </p>
                  <p className="text-xs text-text-muted">{t('shared-task:copy_and_chat')}</p>
                </div>
                <Button onClick={handleLoginAndCopy} size="sm" className="flex-shrink-0">
                  <LogIn className="w-4 h-4 mr-2" />
                  {isLoggedIn ? t('shared-task:continue_chat') : t('shared-task:login_to_continue')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default function SharedTaskPage() {
  return (
    <Suspense
      fallback={
        <div className="flex smart-h-screen bg-base text-text-primary box-border">
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-text-muted">Loading...</p>
            </div>
          </div>
        </div>
      }
    >
      <SharedTaskContent />
    </Suspense>
  )
}
