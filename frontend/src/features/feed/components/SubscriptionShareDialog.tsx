'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription share dialog component.
 * Allows subscription owners to invite users or namespaces to follow.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Mail, Trash2, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { subscriptionApis } from '@/apis/subscription'
import type { Subscription, SubscriptionInvitationResponse } from '@/types/subscription'

interface SubscriptionShareDialogProps {
  subscription: Subscription
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SubscriptionShareDialog({
  subscription,
  open,
  onOpenChange,
}: SubscriptionShareDialogProps) {
  const { t } = useTranslation('feed')

  // State
  const [inviteInput, setInviteInput] = useState('')
  const [inviting, setInviting] = useState(false)
  const [invitations, setInvitations] = useState<SubscriptionInvitationResponse[]>([])
  const [invitationsLoading, setInvitationsLoading] = useState(false)
  const [revokingId, setRevokingId] = useState<number | null>(null)

  // Load sent invitations
  const loadInvitations = useCallback(async () => {
    try {
      setInvitationsLoading(true)
      const response = await subscriptionApis.getInvitationsSent(subscription.id, {
        page: 1,
        limit: 50,
      })
      setInvitations(response.items)
    } catch (error) {
      console.error('Failed to load invitations:', error)
    } finally {
      setInvitationsLoading(false)
    }
  }, [subscription.id])

  // Load invitations when dialog opens
  useEffect(() => {
    if (open) {
      loadInvitations()
    }
  }, [open, loadInvitations])

  // Handle invite user
  const handleInviteUser = useCallback(async () => {
    if (!inviteInput.trim()) return

    try {
      setInviting(true)

      // Determine if input is email or user ID
      const isEmail = inviteInput.includes('@')
      const data = isEmail
        ? { email: inviteInput.trim() }
        : { user_id: parseInt(inviteInput.trim(), 10) }

      await subscriptionApis.inviteUser(subscription.id, data)
      toast.success(t('invite_success'))
      setInviteInput('')
      loadInvitations()
    } catch (error) {
      console.error('Failed to invite user:', error)
      toast.error(t('invite_failed'))
    } finally {
      setInviting(false)
    }
  }, [inviteInput, subscription.id, t, loadInvitations])

  // Handle revoke invitation
  const handleRevokeInvitation = useCallback(
    async (userId: number) => {
      try {
        setRevokingId(userId)
        await subscriptionApis.revokeUserInvitation(subscription.id, userId)
        toast.success(t('invitation_revoked'))
        loadInvitations()
      } catch (error) {
        console.error('Failed to revoke invitation:', error)
        toast.error(t('invitation_revoke_failed'))
      } finally {
        setRevokingId(null)
      }
    },
    [subscription.id, t, loadInvitations]
  )

  // Get status badge variant
  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'accepted':
        return 'success'
      case 'rejected':
        return 'error'
      default:
        return 'warning'
    }
  }

  // Get status label
  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'accepted':
        return t('invitation_accepted')
      case 'rejected':
        return t('invitation_rejected')
      default:
        return t('invitation_pending')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('share_dialog_title')}</DialogTitle>
          <DialogDescription>{t('share_dialog_desc')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="invite" className="mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="invite">
              <UserPlus className="h-4 w-4 mr-1.5" />
              {t('share_to_user')}
            </TabsTrigger>
            <TabsTrigger value="invitations">
              <Users className="h-4 w-4 mr-1.5" />
              {t('invitations')}
            </TabsTrigger>
          </TabsList>

          {/* Invite Tab */}
          <TabsContent value="invite" className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>{t('share_to_user')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
                  <Input
                    value={inviteInput}
                    onChange={e => setInviteInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleInviteUser()}
                    placeholder={t('invite_user_placeholder')}
                    className="pl-9"
                  />
                </div>
                <Button onClick={handleInviteUser} disabled={inviting || !inviteInput.trim()}>
                  {inviting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* Invitations Tab */}
          <TabsContent value="invitations" className="mt-4">
            {invitationsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : invitations.length === 0 ? (
              <div className="text-center py-8 text-text-muted">
                <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{t('no_invitations')}</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {invitations.map(invitation => (
                  <div
                    key={invitation.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-surface/50"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="font-medium truncate block">
                        @{invitation.invited_by_username}
                      </span>
                      <Badge
                        variant={getStatusVariant(invitation.invitation_status)}
                        size="sm"
                        className="mt-1"
                      >
                        {getStatusLabel(invitation.invitation_status)}
                      </Badge>
                    </div>
                    {invitation.invitation_status === 'pending' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-text-muted hover:text-destructive"
                        onClick={() => handleRevokeInvitation(invitation.invited_by_user_id)}
                        disabled={revokingId === invitation.invited_by_user_id}
                      >
                        {revokingId === invitation.invited_by_user_id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
