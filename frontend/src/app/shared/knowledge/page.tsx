// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { getToken, userApis } from '@/apis/user'
import { LogIn, BookOpen, Clock, Send, AlertCircle } from 'lucide-react'
import { useTheme } from '@/features/theme/ThemeProvider'
import TopNavigation from '@/features/layout/TopNavigation'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import type { User } from '@/types/api'
import type { PublicKnowledgeBaseResponse, PermissionLevel } from '@/types/knowledge'
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard'
import { detectInAppBrowser } from '@/utils/browserDetection'
import '@/features/common/scrollbar.css'

/**
 * Public shared knowledge base page - no authentication required for viewing basic info
 * Uses the same layout and styling as the shared task page for consistency
 */
function SharedKnowledgeContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { theme: _theme } = useTheme()
  const { t } = useTranslation('shared-knowledge')

  const [kbData, setKbData] = useState<PublicKnowledgeBaseResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [showInAppBrowserGuard, setShowInAppBrowserGuard] = useState(false)
  const [selectedLevel, setSelectedLevel] = useState<PermissionLevel>('view')
  const [isApplying, setIsApplying] = useState(false)
  const [applyStatus, setApplyStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [applyError, setApplyError] = useState<string | null>(null)

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
      setError(t('error_invalid_link'))
      setIsLoading(false)
      return
    }

    const fetchSharedKnowledge = async () => {
      try {
        const data = await knowledgePermissionApi.getPublicKnowledgeBase(token)
        setKbData(data)
      } catch (err) {
        console.error('Failed to load shared knowledge base:', err)
        const errorMessage = (err as Error)?.message || ''

        // Map error messages to i18n keys
        if (
          errorMessage.includes('Invalid share token') ||
          errorMessage.includes('Invalid resource type')
        ) {
          setError(t('error_invalid_link'))
        } else if (errorMessage.includes('expired')) {
          setError(t('error_expired_link'))
        } else if (errorMessage.includes('not found') || errorMessage.includes('inactive')) {
          setError(t('error_kb_not_found'))
        } else {
          setError(t('error_load_failed'))
        }
      } finally {
        setIsLoading(false)
      }
    }

    fetchSharedKnowledge()
  }, [searchParams, t])

  const handleLoginAndApply = () => {
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
    proceedToLogin(token)
  }

  const proceedToLogin = (token: string) => {
    // Redirect to login with the full shared knowledge URL as redirect target
    const redirectTarget = `/shared/knowledge?token=${encodeURIComponent(token)}`
    router.push(`/login?redirect=${encodeURIComponent(redirectTarget)}`)
  }

  const handleApplyPermission = async () => {
    const token = searchParams.get('token')
    if (!token || !kbData) return

    setIsApplying(true)
    setApplyError(null)

    try {
      const response = await knowledgePermissionApi.joinByLink({
        share_token: token,
        requested_permission_level: selectedLevel,
      })

      if (response.status === 'approved') {
        // User got immediate access, redirect to KB
        router.push(`/knowledge/document/${kbData.id}`)
      } else if (response.status === 'pending') {
        setApplyStatus('pending')
      }
    } catch (err) {
      console.error('Failed to apply for permission:', err)
      const errorMessage = (err as Error)?.message || ''

      if (errorMessage.includes('Already have access')) {
        // User already has access, redirect to KB
        router.push(`/knowledge/document/${kbData.id}`)
        return
      } else if (errorMessage.includes('already pending')) {
        setApplyStatus('pending')
        return
      } else if (errorMessage.includes('Cannot join your own')) {
        setApplyError(t('cannot_join_own'))
      } else {
        setApplyError(errorMessage || t('error_load_failed'))
      }
      setApplyStatus('error')
    } finally {
      setIsApplying(false)
    }
  }

  const _handleEnterKnowledgeBase = () => {
    if (kbData) {
      router.push(`/knowledge/document/${kbData.id}`)
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        <TopNavigation variant="standalone" showLogo>
          <GithubStarButton />
        </TopNavigation>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Spinner className="w-12 h-12 mx-auto mb-4" />
            <p className="text-text-muted">Loading shared knowledge base...</p>
          </div>
        </div>
      </div>
    )
  }

  if (error || !kbData) {
    // Determine error title and description based on error type
    let errorTitle = t('error_load_failed')
    let errorDesc = t('error_load_failed_desc')
    let errorIcon = '⚠️'

    if (error) {
      if (error.includes(t('error_invalid_link'))) {
        errorTitle = t('error_invalid_link')
        errorDesc = t('error_invalid_link_desc')
        errorIcon = '🔗'
      } else if (error.includes(t('error_expired_link'))) {
        errorTitle = t('error_expired_link')
        errorDesc = t('error_expired_link_desc')
        errorIcon = '⏰'
      } else if (error.includes(t('error_kb_not_found'))) {
        errorTitle = t('error_kb_not_found')
        errorDesc = t('error_kb_not_found_desc')
        errorIcon = '🗑️'
      }
    }

    return (
      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        <TopNavigation variant="standalone" showLogo>
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
                onClick={() => router.push('/knowledge')}
                variant="default"
                size="default"
                className="min-w-[160px]"
              >
                {t('go_home')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Check if link is expired
  if (kbData.is_expired) {
    return (
      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        <TopNavigation variant="standalone" showLogo>
          <GithubStarButton />
        </TopNavigation>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-lg w-full">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-full bg-warning/10 flex items-center justify-center">
                <span className="text-4xl">⏰</span>
              </div>
            </div>
            <h1 className="text-2xl font-semibold text-center mb-3 text-text-primary">
              {t('error_expired_link')}
            </h1>
            <p className="text-center text-text-muted mb-8 leading-relaxed">
              {t('error_expired_link_desc')}
            </p>
            <div className="flex justify-center">
              <Button
                onClick={() => router.push('/knowledge')}
                variant="default"
                size="default"
                className="min-w-[160px]"
              >
                {t('go_home')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Render pending approval status
  if (applyStatus === 'pending') {
    return (
      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        <TopNavigation variant="standalone" showLogo>
          <GithubStarButton />
        </TopNavigation>
        <div className="flex-1 flex items-center justify-center p-4">
          <Card padding="lg" className="max-w-md w-full">
            <div className="text-center space-y-4">
              <div className="flex justify-center">
                <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center">
                  <Clock className="w-8 h-8 text-warning" />
                </div>
              </div>
              <h1 className="text-xl font-semibold">{t('pending_approval')}</h1>
              <p className="text-text-secondary text-sm">{t('pending_approval_desc')}</p>
              <div className="bg-muted rounded-lg p-4 text-sm">
                <div className="flex justify-between mb-2">
                  <span className="text-text-muted">
                    {t('knowledge:document.permission.permissionLevel')}:
                  </span>
                  <span className="font-medium">
                    {selectedLevel === 'view' ? t('view_permission') : t('edit_permission')}
                  </span>
                </div>
              </div>
              <Button variant="outline" onClick={() => router.push('/knowledge')}>
                {t('go_home')}
              </Button>
            </div>
          </Card>
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
              proceedToLogin(token)
            }
          }}
          onCancel={() => setShowInAppBrowserGuard(false)}
        />
      )}

      <div className="flex flex-col smart-h-screen bg-base text-text-primary box-border">
        {/* Top navigation */}
        <TopNavigation variant="standalone" showLogo>
          <GithubStarButton />
          {isLoggedIn && currentUser ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-primary">{currentUser.user_name}</span>
            </div>
          ) : (
            <Button
              onClick={handleLoginAndApply}
              size="sm"
              variant="default"
              className="flex items-center gap-2"
            >
              <LogIn className="w-4 h-4" />
              <span className="hidden sm:inline">{t('login_to_apply')}</span>
              <span className="sm:hidden">{t('login')}</span>
            </Button>
          )}
        </TopNavigation>

        {/* Main content area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="w-full max-w-xl mx-auto flex flex-col px-4 py-6">
            {/* KB Info Card */}
            <Card padding="lg" className="mb-6">
              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <BookOpen className="w-6 h-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h1 className="text-xl font-semibold text-text-primary mb-1">{kbData.name}</h1>
                    <p className="text-sm text-text-muted">
                      {t('shared_by', { name: kbData.creator_name })}
                    </p>
                  </div>
                </div>

                {/* Description */}
                {kbData.description && (
                  <p className="text-sm text-text-secondary">{kbData.description}</p>
                )}

                {/* Approval notice */}
                {kbData.require_approval && (
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <AlertCircle className="w-4 h-4" />
                    <span>{t('require_approval_notice')}</span>
                  </div>
                )}
              </div>
            </Card>

            {/* Read-only notice for non-logged in users */}
            {!isLoggedIn && (
              <Alert
                variant="default"
                className="mb-6 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
              >
                <AlertDescription className="text-sm text-text-primary">
                  📖 {t('read_only_notice')}
                </AlertDescription>
              </Alert>
            )}

            {/* Permission Apply Form for logged in users */}
            {isLoggedIn && (
              <Card padding="lg">
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold">{t('apply_permission')}</h2>

                  {/* Permission Level Selection */}
                  <div className="space-y-3">
                    <label className="text-sm font-medium">{t('select_permission')}</label>
                    <div className="space-y-2">
                      {/* View Option */}
                      <label
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedLevel === 'view'
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="permission"
                          value="view"
                          checked={selectedLevel === 'view'}
                          onChange={() => setSelectedLevel('view')}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium">{t('view_permission')}</div>
                          <div className="text-sm text-text-muted">{t('view_permission_desc')}</div>
                        </div>
                      </label>
                      {/* Edit Option */}
                      <label
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          selectedLevel === 'edit'
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="permission"
                          value="edit"
                          checked={selectedLevel === 'edit'}
                          onChange={() => setSelectedLevel('edit')}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium">{t('edit_permission')}</div>
                          <div className="text-sm text-text-muted">{t('edit_permission_desc')}</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Error Message */}
                  {applyError && <div className="text-sm text-error text-center">{applyError}</div>}

                  {/* Submit Button */}
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={handleApplyPermission}
                    disabled={isApplying}
                  >
                    {isApplying ? (
                      <Spinner className="w-4 h-4" />
                    ) : (
                      <>
                        <Send className="w-4 h-4 mr-2" />
                        {t('submit_request')}
                      </>
                    )}
                  </Button>
                </div>
              </Card>
            )}

            {/* Bottom CTA for non-logged in users */}
            {!isLoggedIn && (
              <div className="mt-8 p-4 rounded-lg bg-surface border border-border">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-text-primary mb-1">
                      {t('login_to_apply')}
                    </p>
                    <p className="text-xs text-text-muted">{t('read_only_notice')}</p>
                  </div>
                  <Button onClick={handleLoginAndApply} size="sm" className="flex-shrink-0">
                    <LogIn className="w-4 h-4 mr-2" />
                    {t('login_to_apply')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export default function SharedKnowledgePage() {
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
      <SharedKnowledgeContent />
    </Suspense>
  )
}
