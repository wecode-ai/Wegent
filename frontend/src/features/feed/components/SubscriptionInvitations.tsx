'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription invitations component.
 * Shows pending invitations and allows users to accept/reject them.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Mail, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { subscriptionApis } from '@/apis/subscription'
import type { SubscriptionInvitationResponse } from '@/types/subscription'
import { paths } from '@/config/paths'

interface SubscriptionInvitationsProps {
  onInvitationHandled?: () => void
}

export function SubscriptionInvitations({ onInvitationHandled }: SubscriptionInvitationsProps) {
  const { t } = useTranslation('feed')
  const router = useRouter()

  // State
  const [invitations, setInvitations] = useState<SubscriptionInvitationResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [processingId, setProcessingId] = useState<number | null>(null)

  // Load pending invitations
  const loadInvitations = useCallback(async () => {
    try {
      setLoading(true)
      const response = await subscriptionApis.getPendingInvitations({ page: 1, limit: 50 })
      // Filter to only show pending invitations
      setInvitations(response.items.filter(inv => inv.invitation_status === 'pending'))
    } catch (error) {
      console.error('Failed to load invitations:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadInvitations()
  }, [loadInvitations])

  // Handle accept invitation
  const handleAccept = useCallback(
    async (invitationId: number) => {
      try {
        setProcessingId(invitationId)
        await subscriptionApis.acceptInvitation(invitationId)
        toast.success(t('invitation_accepted'))
        // Remove from list
        setInvitations(prev => prev.filter(inv => inv.id !== invitationId))
        onInvitationHandled?.()
      } catch (error) {
        console.error('Failed to accept invitation:', error)
        toast.error(t('invitation_accept_failed'))
      } finally {
        setProcessingId(null)
      }
    },
    [t, onInvitationHandled]
  )

  // Handle reject invitation
  const handleReject = useCallback(
    async (invitationId: number) => {
      try {
        setProcessingId(invitationId)
        await subscriptionApis.rejectInvitation(invitationId)
        toast.success(t('invitation_rejected'))
        // Remove from list
        setInvitations(prev => prev.filter(inv => inv.id !== invitationId))
        onInvitationHandled?.()
      } catch (error) {
        console.error('Failed to reject invitation:', error)
        toast.error(t('invitation_reject_failed'))
      } finally {
        setProcessingId(null)
      }
    },
    [t, onInvitationHandled]
  )

  // Navigate to subscription detail
  const handleViewSubscription = useCallback(
    (subscriptionId: number) => {
      router.push(paths.feedSubscriptionDetail.getHref(subscriptionId))
    },
    [router]
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  if (invitations.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted">
        <Mail className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{t('no_invitations')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {invitations.map(invitation => (
        <div
          key={invitation.id}
          className="flex items-center gap-4 p-4 rounded-lg border border-border bg-surface/50"
        >
          {/* Subscription info */}
          <div className="flex-1 min-w-0">
            <button
              onClick={() => handleViewSubscription(invitation.subscription_id)}
              className="font-semibold text-text-primary hover:text-primary transition-colors truncate block text-left"
            >
              {invitation.subscription_display_name}
            </button>
            <p className="text-sm text-text-muted mt-0.5">
              {t('owner')}: @{invitation.owner_username}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="warning" size="sm">
                {t('invitation_pending')}
              </Badge>
              <span className="text-xs text-text-muted">
                {new Date(invitation.invited_at).toLocaleDateString()}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleReject(invitation.id)}
              disabled={processingId === invitation.id}
              className="text-destructive hover:text-destructive"
            >
              {processingId === invitation.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <X className="h-4 w-4 mr-1" />
                  {t('invitation_reject')}
                </>
              )}
            </Button>
            <Button
              size="sm"
              onClick={() => handleAccept(invitation.id)}
              disabled={processingId === invitation.id}
            >
              {processingId === invitation.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  {t('invitation_accept')}
                </>
              )}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
