// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Link, CheckCircle2, Clock, Send } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useKnowledgePermissions } from '@/features/knowledge/permission/hooks/useKnowledgePermissions'
import type { PermissionLevel } from '@/types/knowledge'

/**
 * Knowledge Base Share Page
 *
 * This page is accessed via share links (e.g., /knowledge/share/123).
 * It allows users to:
 * 1. View KB info if they already have access
 * 2. Apply for permission if they don't have access
 * 3. See pending request status if they have a pending request
 */
export default function KnowledgeBaseSharePage() {
  const { t } = useTranslation('knowledge')
  const router = useRouter()
  const params = useParams()
  const kbId = params.id ? parseInt(params.id as string, 10) : 0

  const [selectedLevel, setSelectedLevel] = useState<PermissionLevel>('view')
  const [applySuccess, setApplySuccess] = useState(false)

  const {
    shareInfo,
    loading,
    error,
    fetchShareInfo,
    applyPermission,
  } = useKnowledgePermissions({ kbId })

  // Fetch share info on mount
  useEffect(() => {
    if (kbId) {
      fetchShareInfo()
    }
  }, [kbId, fetchShareInfo])

  // If user already has access, redirect to the KB page
  useEffect(() => {
    if (shareInfo?.my_permission?.has_access) {
      router.push(`/knowledge/document/${kbId}`)
    }
  }, [shareInfo, kbId, router])

  const handleApply = async () => {
    try {
      await applyPermission(selectedLevel)
      setApplySuccess(true)
      // Refresh to show pending status
      await fetchShareInfo()
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  if (loading && !shareInfo) {
    return (
      <div className="flex h-screen items-center justify-center bg-base">
        <Spinner />
      </div>
    )
  }

  if (error && !shareInfo) {
    return (
      <div className="flex h-screen items-center justify-center bg-base">
        <Card padding="lg" className="max-w-md text-center">
          <div className="text-error mb-4">{error}</div>
          <Button variant="outline" onClick={() => router.push('/knowledge')}>
            {t('common:actions.back')}
          </Button>
        </Card>
      </div>
    )
  }

  const myPermission = shareInfo?.my_permission

  // User has a pending request
  if (myPermission?.pending_request) {
    return (
      <div className="flex h-screen items-center justify-center bg-base p-4">
        <Card padding="lg" className="max-w-md w-full">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center">
                <Clock className="w-8 h-8 text-warning" />
              </div>
            </div>
            <h1 className="text-xl font-semibold">{t('permission.pendingApproval')}</h1>
            <p className="text-text-secondary text-sm">
              {t('permission.pendingApprovalDescription', { name: shareInfo?.name })}
            </p>
            <div className="bg-muted rounded-lg p-4 text-sm">
              <div className="flex justify-between mb-2">
                <span className="text-text-muted">{t('permission.permissionLevel')}:</span>
                <span className="font-medium">
                  {t(`permission.${myPermission.pending_request.permission_level}`)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">{t('permission.requestedAt')}:</span>
                <span className="font-medium">
                  {new Date(myPermission.pending_request.requested_at).toLocaleDateString()}
                </span>
              </div>
            </div>
            <Button variant="outline" onClick={() => router.push('/knowledge')}>
              {t('common:actions.back')}
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  // Apply success state
  if (applySuccess) {
    return (
      <div className="flex h-screen items-center justify-center bg-base p-4">
        <Card padding="lg" className="max-w-md w-full">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-success" />
              </div>
            </div>
            <h1 className="text-xl font-semibold">{t('permission.applySuccess')}</h1>
            <p className="text-text-secondary text-sm">
              {t('permission.applySuccessDescription')}
            </p>
            <Button variant="outline" onClick={() => router.push('/knowledge')}>
              {t('common:actions.back')}
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  // No access - show apply form
  return (
    <div className="flex h-screen items-center justify-center bg-base p-4">
      <Card padding="lg" className="max-w-md w-full">
        <div className="space-y-6">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Link className="w-6 h-6 text-primary" />
              </div>
            </div>
            <h1 className="text-xl font-semibold">{t('permission.apply')}</h1>
          </div>

          {/* KB Info */}
          <div className="bg-muted rounded-lg p-4">
            <h2 className="font-medium mb-1">{shareInfo?.name}</h2>
            {shareInfo?.description && (
              <p className="text-sm text-text-secondary mb-2">{shareInfo.description}</p>
            )}
            <p className="text-xs text-text-muted">
              {t('permission.createdBy', { name: shareInfo?.creator_name })}
            </p>
          </div>

          {/* Permission Level Selection */}
          <div className="space-y-3">
            <label className="text-sm font-medium">{t('permission.selectPermission')}</label>
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
                  <div className="font-medium">{t('permission.view')}</div>
                  <div className="text-sm text-text-muted">{t('permission.viewDescription')}</div>
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
                  <div className="font-medium">{t('permission.edit')}</div>
                  <div className="text-sm text-text-muted">{t('permission.editDescription')}</div>
                </div>
              </label>
            </div>
          </div>

          {/* Error Message */}
          {error && <div className="text-sm text-error text-center">{error}</div>}

          {/* Submit Button */}
          <Button
            variant="primary"
            className="w-full"
            onClick={handleApply}
            disabled={loading}
          >
            {loading ? (
              <Spinner className="w-4 h-4" />
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                {t('permission.submitRequest')}
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  )
}
