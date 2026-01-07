// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Copy, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { taskMemberApi } from '@/apis/task-member'
import { useTranslation } from '@/hooks/useTranslation'

interface InviteLinkDialogProps {
  open: boolean
  onClose: () => void
  taskId: number
  taskTitle: string
  onMembersChanged?: () => void // Callback to refresh task detail after converting to group chat
}

export function InviteLinkDialog({
  open,
  onClose,
  taskId,
  taskTitle,
  onMembersChanged,
}: InviteLinkDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [expiresHours, setExpiresHours] = useState('0') // 0 = permanent (no expiration)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // Auto-generate link when dialog opens
  useEffect(() => {
    if (open && !inviteUrl) {
      generateLink()
    }
  }, [open])

  const generateLink = async () => {
    setLoading(true)
    try {
      // First, ensure the task is converted to a group chat
      let wasConverted = false
      try {
        await taskMemberApi.convertToGroupChat(taskId)
        wasConverted = true
      } catch (conversionError: unknown) {
        // Ignore conversion errors - task might already be a group chat or user might not be owner
        // The important part is the generateInviteLink call below
        console.log('Task conversion:', conversionError)
      }

      // Generate the invite link
      const response = await taskMemberApi.generateInviteLink(taskId, parseInt(expiresHours))
      setInviteUrl(response.invite_url)

      // Trigger UI refresh if task was converted to group chat
      if (wasConverted) {
        onMembersChanged?.()
      }
    } catch (error: unknown) {
      toast({
        title: t('chat:groupChat.inviteLink.generateFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const copyLink = async () => {
    if (!inviteUrl) return

    // Try modern clipboard API first
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(inviteUrl)
        setCopied(true)
        toast({
          title: t('chat:groupChat.inviteLink.copied'),
        })
        // Close the dialog after copying
        setTimeout(() => {
          handleClose()
        }, 500)
        return
      } catch (err) {
        console.error('Clipboard API failed: ', err)
      }
    }

    // Fallback for non-HTTPS environments (e.g., HTTP IP:port)
    try {
      const textarea = document.createElement('textarea')
      textarea.value = inviteUrl
      textarea.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      toast({
        title: t('chat:groupChat.inviteLink.copied'),
      })
      // Close the dialog after copying
      setTimeout(() => {
        handleClose()
      }, 500)
    } catch (err) {
      console.error('Fallback copy failed: ', err)
      toast({
        title: t('chat:groupChat.inviteLink.copyFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleClose = () => {
    setInviteUrl(null)
    setCopied(false)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat:groupChat.inviteLink.title')}</DialogTitle>
          <DialogDescription>
            {t('chat:groupChat.inviteLink.description', { taskTitle })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : inviteUrl ? (
            <>
              <div className="flex items-center gap-2">
                <Input value={inviteUrl} readOnly className="flex-1 text-sm" />
                <Button variant="outline" size="icon" onClick={copyLink}>
                  {copied ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>

              <p className="text-xs text-text-muted">
                {expiresHours === '0'
                  ? t('chat:groupChat.inviteLink.permanentNote')
                  : t('chat:groupChat.inviteLink.expiresNote', { hours: expiresHours })}
              </p>

              <div className="flex items-center gap-2 pt-2">
                <span className="text-sm text-text-secondary">
                  {t('chat:groupChat.inviteLink.expiresIn')}
                </span>
                <Select value={expiresHours} onValueChange={setExpiresHours}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">{t('chat:groupChat.inviteLink.permanent')}</SelectItem>
                    <SelectItem value="24">{t('chat:groupChat.inviteLink.hours24')}</SelectItem>
                    <SelectItem value="72">{t('chat:groupChat.inviteLink.days3')}</SelectItem>
                    <SelectItem value="168">{t('chat:groupChat.inviteLink.days7')}</SelectItem>
                    <SelectItem value="720">{t('chat:groupChat.inviteLink.days30')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button
                variant="outline"
                onClick={() => {
                  setInviteUrl(null)
                  generateLink()
                }}
                className="w-full"
              >
                {t('chat:groupChat.inviteLink.regenerate')}
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
