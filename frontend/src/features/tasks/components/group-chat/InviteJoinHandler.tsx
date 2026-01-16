// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Users, Bot } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { taskMemberApi, InviteInfoResponse } from '@/apis/task-member'
import { useTranslation } from '@/hooks/useTranslation'

export function InviteJoinHandler() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const router = useRouter()
  const inviteToken = searchParams.get('invite')

  const [inviteInfo, setInviteInfo] = useState<InviteInfoResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!inviteToken) return

    setLoading(true)
    setError(null)
    taskMemberApi
      .getInviteInfo(inviteToken)
      .then(setInviteInfo)
      .catch(err => setError(err.message || t('chat:groupChat.invite.invalidLink')))
      .finally(() => setLoading(false))
  }, [inviteToken, t])

  const handleJoin = async () => {
    if (!inviteToken) return

    setJoining(true)
    try {
      const result = await taskMemberApi.joinByInvite(inviteToken)

      if (result.already_member) {
        toast({ title: t('chat:groupChat.invite.alreadyMember') })
      } else {
        toast({ title: t('chat:groupChat.invite.joinSuccess') })
      }

      // Navigate to the group chat
      router.replace(`/chat?taskId=${result.task_id}`)
    } catch (err: unknown) {
      toast({
        title: err instanceof Error ? err.message : t('chat:groupChat.invite.joinFailed'),
        variant: 'destructive',
      })
    } finally {
      setJoining(false)
    }
  }

  const handleClose = () => {
    // Remove the invite parameter from URL
    const newParams = new URLSearchParams(searchParams.toString())
    newParams.delete('invite')
    const newUrl = newParams.toString() ? `/chat?${newParams.toString()}` : '/chat'
    router.replace(newUrl)
  }

  if (!inviteToken) return null

  return (
    <Dialog open={true} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat:groupChat.invite.title')}</DialogTitle>
          <DialogDescription>{t('chat:groupChat.invite.description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" onClick={handleClose} className="mt-4">
              {t('chat:common.close')}
            </Button>
          </div>
        ) : (
          inviteInfo && (
            <div className="space-y-4">
              <div className="bg-muted rounded-lg p-4">
                <h3 className="font-semibold text-lg">{inviteInfo.task_title}</h3>
                <p className="text-sm text-text-secondary mt-1">
                  {t('chat:groupChat.invite.invitedBy', {
                    name: inviteInfo.inviter_name,
                  })}
                </p>
              </div>

              <div className="flex items-center gap-4 text-sm text-text-secondary">
                <div className="flex items-center gap-1">
                  <Users className="w-4 h-4" />
                  <span>
                    {t('chat:groupChat.invite.memberCount', {
                      count: inviteInfo.member_count,
                    })}
                  </span>
                </div>
                {inviteInfo.team_name && (
                  <div className="flex items-center gap-1">
                    <Bot className="w-4 h-4" />
                    <span>{inviteInfo.team_name}</span>
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" onClick={handleClose}>
                  {t('chat:common.cancel')}
                </Button>
                <Button onClick={handleJoin} disabled={joining}>
                  {joining ? t('chat:groupChat.invite.joining') : t('chat:groupChat.invite.join')}
                </Button>
              </DialogFooter>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  )
}
