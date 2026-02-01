// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect } from 'react'
import { Link, Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface ShareLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  kbName: string
}

export function ShareLinkDialog({
  open,
  onOpenChange,
  kbId,
  kbName,
}: ShareLinkDialogProps) {
  const { t } = useTranslation('knowledge')
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Generate share link
  const shareLink =
    typeof window !== 'undefined'
      ? `${window.location.origin}/knowledge/share/${kbId}`
      : ''

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopied(true)
      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy link:', err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="w-5 h-5" />
            {t('permission.shareLink')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t('permission.shareLinkDescription', { name: kbName })}
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 p-3 bg-muted rounded-lg text-sm break-all font-mono">
              {shareLink}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              className="flex-shrink-0"
            >
              {copied ? (
                <Check className="w-4 h-4 text-success" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </Button>
          </div>
          {copied && (
            <p className="text-sm text-success">{t('permission.linkCopied')}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
